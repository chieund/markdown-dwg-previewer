import { Bounds, DxfPage, SVG_NS, ViewportView, renderEntity } from './renderer';
import {
  BUTTON_STEP,
  ViewBox,
  applyViewBox,
  attachPanZoom,
  clientToViewBox,
  getViewBox,
  unitsPerPixel,
  zoomCentre,
} from './panZoom';
import { toPngBase64, toStandaloneSvg } from './export';
import { carryOverView, initialHiddenLayers } from './sceneState';
import { LayerIndex } from './layerIndex';
import { ObjectIndex } from './objectIndex';
import { pickObject } from './pick';
import { buildInspector } from './inspector';
import { SearchControl, buildSearchControl } from './searchPanel';
import type { SearchHit } from './search';
import type { ObjectInfo } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLDivElement;

interface Scene {
  pages: DxfPage[];
  hiddenLayers: Set<string>;
  pageIndex: number;
  skippedEntityTypes: string[];
}

let scene: Scene | null = null;
let canvasHost: HTMLElement | null = null;
let layerSlot: HTMLElement | null = null;
let activeSvg: SVGSVGElement | null = null;
let disposeActivePanZoom: (() => void) | null = null;
/** Incremented on each renderCanvas call; stale rAF chains check this and bail. */
let renderGeneration = 0;
/** Dispose function for the document-level click listener on the layer panel. */
let disposeLayerOutsideClick: (() => void) | null = null;
/** The fitted view of the current page — zoom is reported relative to it. */
let fittedView: ViewBox | null = null;
/** Last known cursor position in drawing coordinates, for the status bar. */
let cursorPoint: { x: number; y: number } | null = null;
let statusBar: HTMLElement | null = null;
let visibleEntityCount = 0;
let pageSelect: HTMLSelectElement | null = null;
/** Elements of the page on screen by layer, so a layer toggle never re-renders. */
let layerIndex = new LayerIndex<SVGElement>();
let emptyState: HTMLElement | null = null;

/** Top-level objects of the whole drawing, for search and the inspector. */
let objects: ObjectInfo[] = [];
/** Drawn elements of the page on screen, by object. */
let objectIndex = new ObjectIndex<SVGElement>();
/** Selected objects (indices into `objects`), highlighted on the canvas. */
let selection: number[] = [];
/** The drawing's content group, dimmed while something is selected. */
let contentGroup: SVGGElement | null = null;
/** Group above the content that holds highlighted copies of the selection. */
let highlightGroup: SVGGElement | null = null;
let inspector: HTMLElement | null = null;
let searchControl: SearchControl | null = null;

/** A selection of a whole layer can hold tens of thousands of elements; copying them all would stall. */
const MAX_HIGHLIGHTED_ELEMENTS = 20_000;
/** A press that moves less than this is a click, not the start of a pan. */
const CLICK_SLOP_PX = 4;
/** How far from a thin line a click still picks it. */
const PICK_RADIUS_PX = 4;

function fitBounds(bounds: Bounds): ViewBox {
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  const padding = Math.max(width, height) * 0.05;
  return {
    x: bounds.minX - padding,
    y: -bounds.maxY - padding,
    w: width + padding * 2,
    h: height + padding * 2,
  };
}

const EMPTY_VIEW: ViewBox = { x: -50, y: -50, w: 100, h: 100 };

/**
 * Draws a page into the host element.
 *
 * For large drawings (>3000 entities), rendering is batched across animation
 * frames to avoid freezing the UI. Smaller drawings render synchronously.
 *
 * A generation token ensures that if renderCanvas is called again (e.g. layer
 * toggle) before the previous batch completes, the stale chain bails out
 * immediately instead of burning CPU appending to a detached DOM tree.
 */
function renderCanvas(host: HTMLElement, page: DxfPage, hiddenLayers: Set<string>, keepView: boolean) {
  const previousView = keepView && activeSvg ? getViewBox(activeSvg) : null;
  const thisGeneration = ++renderGeneration;

  disposeActivePanZoom?.();
  disposeActivePanZoom = null;
  host.innerHTML = '';

  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';
  svg.style.cursor = 'grab';

  const flipGroup = document.createElementNS(SVG_NS, 'g');
  flipGroup.setAttribute('transform', 'scale(1,-1)');

  const styleGroup = document.createElementNS(SVG_NS, 'g');

  const index = new LayerIndex<SVGElement>();
  layerIndex = index;
  const objIndex = new ObjectIndex<SVGElement>();
  objectIndex = objIndex;

  // Viewport content sits behind the sheet
  for (const view of page.viewports ?? []) {
    const el = renderViewport(view, hiddenLayers, index, objIndex);
    if (el) styleGroup.appendChild(el);
  }

  // Every entity is drawn, hidden layers included: switching a layer back on
  // then only flips its elements' display instead of rendering the page again.
  const entities = page.entities;
  // Register every entity's geometry now, so zooming to a selection is right
  // even before the later batches have drawn their elements.
  for (const entity of entities) objIndex.add(entity, null);
  const draw = (target: Node, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const entity = entities[i];
      const el = renderEntity(entity);
      index.add(entity.layer, el, hiddenLayers);
      if (el) {
        objIndex.attach(entity.obj, el);
        target.appendChild(el);
      }
    }
  };

  const BATCH_SIZE = 3000;
  draw(styleGroup, 0, Math.min(BATCH_SIZE, entities.length));

  if (entities.length > BATCH_SIZE) {
    // Large drawing: render the rest progressively so the UI stays responsive
    let offset = BATCH_SIZE;
    const renderNextBatch = () => {
      // Bail if a newer renderCanvas call has started
      if (renderGeneration !== thisGeneration) return;
      const end = Math.min(offset + BATCH_SIZE, entities.length);
      const fragment = document.createDocumentFragment();
      draw(fragment, offset, end);
      styleGroup.appendChild(fragment);
      offset = end;
      if (offset < entities.length) requestAnimationFrame(renderNextBatch);
      // The selection may include elements drawn only now
      else if (selection.length) refreshHighlight();
    };
    requestAnimationFrame(renderNextBatch);
  }

  flipGroup.appendChild(styleGroup);
  const overlay = document.createElementNS(SVG_NS, 'g');
  overlay.setAttribute('class', 'dwg-highlight');
  flipGroup.appendChild(overlay);
  contentGroup = styleGroup;
  highlightGroup = overlay;
  svg.appendChild(flipGroup);
  host.appendChild(svg);
  activeSvg = svg;

  const fitted = page.bounds ? fitBounds(page.bounds) : EMPTY_VIEW;
  fittedView = fitted;

  applyViewBox(svg, previousView ?? fitted);
  disposeActivePanZoom = attachPanZoom(svg, () => applyViewBox(svg, fitted), updateStatusBar);

  svg.addEventListener('mousemove', (event) => {
    const point = clientToViewBox(svg, event.clientX, event.clientY);
    // The scene is drawn through a scale(1,-1) flip, so undo it for display.
    cursorPoint = { x: point.x, y: -point.y };
    updateStatusBar();
  });
  svg.addEventListener('mouseleave', () => {
    cursorPoint = null;
    updateStatusBar();
  });

  // A click (a press that did not turn into a pan) picks the object under it.
  let pressed: { x: number; y: number } | null = null;
  svg.addEventListener('mousedown', (event) => {
    // A click that only closes the open Layers panel must not also select
    const closingPanel = !!document.querySelector('.dwg-layers .dwg-layer-panel:not([hidden])');
    pressed = event.button === 0 && !closingPanel ? { x: event.clientX, y: event.clientY } : null;
  });
  svg.addEventListener('click', (event) => {
    if (!pressed) return;
    const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
    pressed = null;
    if (moved > CLICK_SLOP_PX) return;
    const picked = pickAt(svg, event.clientX, event.clientY);
    if (picked === undefined) clearSelection();
    else select([picked], { zoom: false, inspect: true });
  });

  emptyState = null;
  refreshVisibleCount(page, hiddenLayers);
}

/**
 * Applies the hidden-layer set to the page already on screen. Batches still
 * waiting for an animation frame read the same set when they draw, so they
 * arrive with the right visibility.
 */
function applyLayerVisibility(): void {
  if (!scene || !canvasHost) return;
  layerIndex.apply(scene.hiddenLayers);
  refreshVisibleCount(scene.pages[scene.pageIndex], scene.hiddenLayers);
  if (selection.length) refreshHighlight();
}

function refreshVisibleCount(page: DxfPage, hiddenLayers: Set<string>): void {
  const visibleOnPage = page.entities.filter((e) => !hiddenLayers.has(e.layer)).length;
  visibleEntityCount = visibleOnPage + countVisibleViewportEntities(page, hiddenLayers);

  // Nothing on screen must never be a bare rectangle — say why it is empty.
  emptyState?.remove();
  emptyState = null;
  if (visibleEntityCount === 0 && canvasHost) {
    emptyState = buildEmptyState(page, hiddenLayers);
    canvasHost.appendChild(emptyState);
  }
  updateStatusBar();
}

function countVisibleViewportEntities(page: DxfPage, hiddenLayers: Set<string>): number {
  return (page.viewports ?? []).reduce(
    (total, view) => total + view.entities.filter((e) => !hiddenLayers.has(e.layer)).length,
    0
  );
}

/**
 * Explains an empty canvas.
 *
 * A drawing can come up blank for two very different reasons, and the fix
 * differs: either the user switched every layer off, or the sheet genuinely
 * holds nothing a 2D viewer can draw — which is what happens with 3D models.
 * Showing a bare rectangle for either one reads as a broken extension.
 */
function buildEmptyState(page: DxfPage, hiddenLayers: Set<string>): HTMLElement {
  const totalOnPage =
    page.entities.length +
    (page.viewports ?? []).reduce((total, view) => total + view.entities.length, 0);

  const box = document.createElement('div');
  box.className = 'dwg-empty';

  const title = document.createElement('div');
  title.className = 'dwg-empty-title';
  const detail = document.createElement('div');
  detail.className = 'dwg-empty-detail';
  box.append(title, detail);

  if (totalOnPage > 0) {
    const hiddenCount = page.layers.filter((l) => hiddenLayers.has(l.name)).length;
    title.textContent = 'Every layer on this sheet is hidden';
    detail.textContent =
      `${hiddenCount} of ${page.layers.length} layers are switched off, ` +
      `which hides all ${totalOnPage.toLocaleString()} objects here.`;

    const action = document.createElement('button');
    action.className = 'dwg-empty-action';
    action.textContent = 'Show all layers';
    action.addEventListener('click', () => {
      for (const layer of page.layers) hiddenLayers.delete(layer.name);
      refreshLayerControl();
      applyLayerVisibility();
    });
    box.appendChild(action);
    return box;
  }

  title.textContent = 'Nothing to draw on this sheet';
  const skipped = scene?.skippedEntityTypes ?? [];
  detail.textContent = skipped.length
    ? `This sheet holds no 2D geometry this viewer can draw. It uses: ${skipped.join(', ')}.`
    : 'This sheet holds no 2D geometry. Drawings built from 3D solids, meshes or ' +
      'surfaces have nothing for a 2D viewer to show. Open View → Output and pick ' +
      '"DWG Previewer" to see what was read from the file.';

  const elsewhere = scene?.pages.findIndex(
    (candidate, index) => index !== scene!.pageIndex && candidate.entities.length > 0
  );
  if (elsewhere !== undefined && elsewhere >= 0) {
    const action = document.createElement('button');
    action.className = 'dwg-empty-action';
    action.textContent = `Open "${scene!.pages[elsewhere].name}" instead`;
    action.addEventListener('click', () => goToPage(elsewhere));
    box.appendChild(action);
  }

  return box;
}

function goToPage(index: number): void {
  if (!scene) return;
  clearSelection();
  scene.pageIndex = index;
  if (pageSelect) pageSelect.value = String(index);
  refreshLayerControl();
  redraw(false);
}

/** The object under a click: measured in drawing coordinates, within a few pixels of tolerance. */
function pickAt(svg: SVGSVGElement, clientX: number, clientY: number): number | undefined {
  if (!scene) return undefined;
  const point = clientToViewBox(svg, clientX, clientY);
  const pixel = unitsPerPixel(svg);
  // The scene is drawn through a scale(1,-1) flip
  return pickObject(scene.pages[scene.pageIndex], { x: point.x, y: -point.y }, PICK_RADIUS_PX * pixel, scene.hiddenLayers);
}

/** Selects objects: dims the rest, highlights them, and optionally zooms to them and opens the inspector. */
function select(objs: number[], options: { zoom: boolean; inspect: boolean }): void {
  selection = objs;
  refreshHighlight();

  if (options.zoom && activeSvg && fittedView) {
    const bounds = objectIndex.boundsOf(objs);
    if (bounds) {
      const view = fitBounds(bounds);
      // A lone label or point would fill the screen; keep some context around it.
      const minWidth = fittedView.w * 0.08;
      if (view.w < minWidth) {
        const grow = minWidth / view.w;
        view.x -= (view.w * (grow - 1)) / 2;
        view.y -= (view.h * (grow - 1)) / 2;
        view.w *= grow;
        view.h *= grow;
      }
      applyViewBox(activeSvg, view);
      updateStatusBar();
    }
  }

  inspector?.remove();
  inspector = null;
  if (options.inspect && objs.length === 1 && canvasHost) {
    const info = objects[objs[0]];
    if (info) {
      const layer = scene?.pages[scene.pageIndex].layers.find((l) => l.name === info.layer);
      inspector = buildInspector(info, layer?.color, clearSelection);
      canvasHost.appendChild(inspector);
    }
  }
}

function clearSelection(): void {
  if (!selection.length && !inspector) return;
  selection = [];
  refreshHighlight();
  inspector?.remove();
  inspector = null;
}

/**
 * Redraws the highlight copies for the current selection.
 *
 * Copies of elements on a hidden layer are skipped, so toggling a layer off
 * takes its highlight with it. Copies of viewport content go into a group
 * clipped like the original, or a line that only touches the window would be
 * highlighted all the way across the sheet. Strokes are made non-scaling and
 * at least 2px — a solid hatch has no stroke of its own, and a stroke in
 * drawing units can cover half the screen.
 */
function refreshHighlight(): void {
  if (!highlightGroup || !contentGroup) return;
  highlightGroup.textContent = '';
  contentGroup.classList.toggle('dwg-dimmed', selection.length > 0);

  const clipped = new Map<string, SVGGElement>();
  const elements = objectIndex.elementsOf(selection).slice(0, MAX_HIGHLIGHTED_ELEMENTS);
  for (const element of elements) {
    if (element.style.display === 'none') continue;

    const copy = element.cloneNode(true) as SVGElement;
    // Pattern definitions would duplicate ids; the highlight paints its own fill
    copy.querySelectorAll('defs').forEach((defs) => defs.remove());
    for (const part of [copy, ...Array.from(copy.querySelectorAll<SVGElement>('*'))]) {
      part.setAttribute('vector-effect', 'non-scaling-stroke');
      const width = Number(part.getAttribute('stroke-width') ?? 0);
      part.setAttribute('stroke-width', String(Math.max(2, Number.isFinite(width) ? width : 0)));
    }

    const clip = element.parentElement?.closest('[clip-path]')?.getAttribute('clip-path');
    let target: SVGGElement = highlightGroup;
    if (clip) {
      let group = clipped.get(clip);
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('clip-path', clip);
        highlightGroup.appendChild(group);
        clipped.set(clip, group);
      }
      target = group;
    }
    target.appendChild(copy);
  }
}

function selectSearchHit(hit: SearchHit): void {
  if (!scene) return;
  if (hit.page !== scene.pageIndex && scene.pages[hit.page]) goToPage(hit.page);
  // Text and attribute hits are single objects worth describing; a whole layer is not.
  select(hit.objects, { zoom: true, inspect: hit.kind === 'text' || hit.kind === 'attribute' || hit.objects.length === 1 });
}

function buildZoomControls(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'dwg-zoom';

  const add = (label: string, title: string, run: () => void) => {
    const button = document.createElement('button');
    button.className = 'dwg-zoom-button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', run);
    group.appendChild(button);
  };

  // A smaller viewBox means a closer view, so zooming in divides.
  add('−', 'Zoom out', () => {
    if (!activeSvg) return;
    zoomCentre(activeSvg, BUTTON_STEP);
    updateStatusBar();
  });
  add('+', 'Zoom in', () => {
    if (!activeSvg) return;
    zoomCentre(activeSvg, 1 / BUTTON_STEP);
    updateStatusBar();
  });
  add('Fit', 'Fit the drawing to the view — the same as double-clicking it', () => {
    if (!activeSvg || !fittedView) return;
    applyViewBox(activeSvg, fittedView);
    updateStatusBar();
  });

  return group;
}

function buildStatusBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'dwg-statusbar';
  statusBar = bar;
  return bar;
}

/** Drawing units span a huge range, so the precision follows the magnitude. */
function formatCoord(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 10000) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function updateStatusBar(): void {
  if (!statusBar) return;

  const span = (text: string, className = '') => {
    const el = document.createElement('span');
    if (className) el.className = className;
    el.textContent = text;
    return el;
  };

  statusBar.textContent = '';
  statusBar.appendChild(
    span(cursorPoint ? `X ${formatCoord(cursorPoint.x)}   Y ${formatCoord(cursorPoint.y)}` : 'X —   Y —')
  );

  if (activeSvg && fittedView) {
    // 100% is the whole drawing on screen, which is the only reference a
    // viewer has without knowing the paper size it will be printed at.
    const zoom = (fittedView.w / getViewBox(activeSvg).w) * 100;
    statusBar.appendChild(span(`Zoom ${zoom >= 10 ? zoom.toFixed(0) : zoom.toFixed(1)}%`));
  }

  statusBar.appendChild(span(`${visibleEntityCount.toLocaleString()} objects`));
  statusBar.appendChild(span('', 'dwg-status-spacer'));
  statusBar.appendChild(span('Scroll = zoom · Drag = pan · Double-click = fit', 'dwg-status-hint'));
}

let clipCounter = 0;

function renderViewport(
  view: ViewportView,
  hiddenLayers: Set<string>,
  index: LayerIndex<SVGElement>,
  objIndex: ObjectIndex<SVGElement>
): SVGElement | null {
  if (view.entities.length === 0) return null;

  const group = document.createElementNS(SVG_NS, 'g');
  const id = `dwg-viewport-${clipCounter++}`;

  const defs = document.createElementNS(SVG_NS, 'defs');
  const clipPath = document.createElementNS(SVG_NS, 'clipPath');
  clipPath.setAttribute('id', id);

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(view.rect.x));
  rect.setAttribute('y', String(view.rect.y));
  rect.setAttribute('width', String(view.rect.width));
  rect.setAttribute('height', String(view.rect.height));

  clipPath.appendChild(rect);
  defs.appendChild(clipPath);
  group.appendChild(defs);

  const content = document.createElementNS(SVG_NS, 'g');
  content.setAttribute('clip-path', `url(#${id})`);
  for (const entity of view.entities) {
    const el = renderEntity(entity);
    index.add(entity.layer, el, hiddenLayers);
    objIndex.add(entity, el);
    if (el) content.appendChild(el);
  }
  group.appendChild(content);

  return group;
}

function redraw(keepView: boolean) {
  if (!scene || !canvasHost) return;
  const page = scene.pages[scene.pageIndex];
  try {
    renderCanvas(canvasHost, page, scene.hiddenLayers, keepView);
  } catch (err) {
    showError(`Error rendering "${page.name}":\n${describe(err)}`);
  }
}

function buildPageSelect(scene: Scene): HTMLElement | null {
  if (scene.pages.length < 2) return null;

  const select = document.createElement('select');
  select.className = 'dwg-page-select';
  scene.pages.forEach((page, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = page.name;
    select.appendChild(option);
  });
  select.value = String(scene.pageIndex);
  select.addEventListener('change', () => goToPage(Number(select.value)));
  pageSelect = select;
  return select;
}

function refreshLayerControl() {
  if (!layerSlot || !scene) return;
  // Remove previous document-level listener before rebuilding
  disposeLayerOutsideClick?.();
  disposeLayerOutsideClick = null;
  layerSlot.innerHTML = '';
  const control = buildLayerControl(scene);
  if (control) layerSlot.appendChild(control);
}

function buildLayerControl(scene: Scene): HTMLElement | null {
  const layers = scene.pages[scene.pageIndex].layers;
  if (layers.length === 0) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'dwg-layers';

  const button = document.createElement('button');
  button.className = 'dwg-layer-button';
  wrapper.appendChild(button);

  const panel = document.createElement('div');
  panel.className = 'dwg-layer-panel';
  panel.hidden = true;
  wrapper.appendChild(panel);

  const updateButton = () => {
    const hidden = layers.filter((l) => scene.hiddenLayers.has(l.name)).length;
    button.textContent = `Layers ${layers.length - hidden}/${layers.length}`;
  };

  // A real drawing can carry over a hundred layers, so the list needs a way in
  // other than scrolling it.
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'dwg-layer-filter';
  filter.placeholder = `Filter ${layers.length} layers…`;
  panel.appendChild(filter);

  const actions = document.createElement('div');
  actions.className = 'dwg-layer-actions';
  const checkboxes = new Map<string, HTMLInputElement>();
  const rows = new Map<string, HTMLElement>();
  let matching = layers;

  const syncCheckboxes = () => {
    for (const [name, box] of checkboxes) box.checked = !scene.hiddenLayers.has(name);
  };

  /** Show/Hide All act on what the filter has narrowed the list down to. */
  const setAll = (visible: boolean) => {
    for (const layer of matching) {
      if (visible) scene.hiddenLayers.delete(layer.name);
      else scene.hiddenLayers.add(layer.name);
    }
    syncCheckboxes();
    updateButton();
    applyLayerVisibility();
  };

  const isolate = (name: string) => {
    for (const layer of layers) scene.hiddenLayers.add(layer.name);
    scene.hiddenLayers.delete(name);
    syncCheckboxes();
    updateButton();
    applyLayerVisibility();
  };

  for (const [label, visible] of [
    ['Show All', true],
    ['Hide All', false],
  ] as const) {
    const action = document.createElement('button');
    action.className = 'dwg-layer-action';
    action.textContent = label;
    action.addEventListener('click', () => setAll(visible));
    actions.appendChild(action);
  }
  panel.appendChild(actions);

  for (const layer of layers) {
    const row = document.createElement('div');
    row.className = 'dwg-layer-row';

    const label = document.createElement('label');
    label.className = 'dwg-layer-label';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !scene.hiddenLayers.has(layer.name);
    box.addEventListener('change', () => {
      if (box.checked) scene.hiddenLayers.delete(layer.name);
      else scene.hiddenLayers.add(layer.name);
      updateButton();
      applyLayerVisibility();
    });
    checkboxes.set(layer.name, box);

    const swatch = document.createElement('span');
    swatch.className = 'dwg-layer-swatch';
    swatch.style.background = layer.color;

    const name = document.createElement('span');
    name.className = 'dwg-layer-name';
    name.textContent = layer.name;
    name.title = layer.name;

    label.append(box, swatch, name);

    const count = document.createElement('span');
    count.className = 'dwg-layer-count';
    count.textContent = String(layer.entityCount);

    const only = document.createElement('button');
    only.className = 'dwg-layer-isolate';
    only.textContent = 'only';
    only.title = `Show only "${layer.name}"`;
    only.addEventListener('click', () => isolate(layer.name));

    row.append(label, count, only);
    rows.set(layer.name, row);
    panel.appendChild(row);
  }

  const noMatch = document.createElement('div');
  noMatch.className = 'dwg-layer-nomatch';
  noMatch.textContent = 'No layer matches that name';
  noMatch.hidden = true;
  panel.appendChild(noMatch);

  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    matching = query ? layers.filter((l) => l.name.toLowerCase().includes(query)) : layers;
    const visible = new Set(matching.map((l) => l.name));
    for (const [name, row] of rows) row.hidden = !visible.has(name);
    noMatch.hidden = matching.length > 0;
  });

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  const outsideClickHandler = (event: MouseEvent) => {
    if (!panel.hidden && !wrapper.contains(event.target as Node)) panel.hidden = true;
  };
  document.addEventListener('click', outsideClickHandler);
  disposeLayerOutsideClick = () => document.removeEventListener('click', outsideClickHandler);

  updateButton();
  return wrapper;
}

function buildExportControls(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'dwg-export';

  const exportAs = async (format: 'svg' | 'png') => {
    if (!activeSvg) return;
    try {
      const data = format === 'svg' ? toStandaloneSvg(activeSvg) : await toPngBase64(activeSvg);
      vscodeApi.postMessage({ type: 'EXPORT', format, data });
    } catch (err) {
      vscodeApi.postMessage({ type: 'EXPORT_FAILED', message: describe(err) });
    }
  };

  for (const format of ['svg', 'png'] as const) {
    const button = document.createElement('button');
    button.className = 'dwg-export-button';
    button.textContent = format.toUpperCase();
    button.title = `Save current view as ${format.toUpperCase()}`;
    button.addEventListener('click', () => void exportAs(format));
    group.appendChild(button);
  }

  return group;
}

function buildBanner(text: string): HTMLElement {
  const banner = document.createElement('span');
  banner.className = 'dwg-banner';

  const label = document.createElement('span');
  label.className = 'dwg-banner-text';
  label.textContent = text;
  label.title = text;
  banner.appendChild(label);

  const dismiss = document.createElement('button');
  dismiss.className = 'dwg-banner-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notice');
  dismiss.addEventListener('click', () => banner.remove());
  banner.appendChild(dismiss);

  return banner;
}

function buildSkippedBanner(skippedEntityTypes: string[]): HTMLElement | null {
  if (skippedEntityTypes.length === 0) return null;
  return buildBanner(`Not supported: ${skippedEntityTypes.join(', ')}`);
}

function renderScene(
  pages: DxfPage[],
  skippedEntityTypes: string[],
  warnings: string[] = [],
  drawingObjects: ObjectInfo[] = []
) {
  objects = drawingObjects;
  selection = [];
  inspector = null;
  // A reload (the file was saved again) keeps the user's page, layers and zoom.
  const previous = scene;
  const previousView = activeSvg ? getViewBox(activeSvg) : null;
  const carried = previous
    ? carryOverView({ pageName: previous.pages[previous.pageIndex]?.name, hiddenLayers: previous.hiddenLayers }, pages)
    : { pageIndex: 0, hiddenLayers: initialHiddenLayers(pages), keepView: false };

  scene = { pages, hiddenLayers: carried.hiddenLayers, pageIndex: carried.pageIndex, skippedEntityTypes };
  activeSvg = null;
  pageSelect = null;
  statusBar = null;
  cursorPoint = null;
  fittedView = null;
  root.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'dwg-toolbar';

  layerSlot = document.createElement('div');
  layerSlot.className = 'dwg-layer-slot';

  searchControl = buildSearchControl({
    objects,
    pageNames: pages.map((page) => page.name),
    onSelect: selectSearchHit,
  });

  for (const control of [
    buildPageSelect(scene),
    layerSlot,
    searchControl.element,
    buildZoomControls(),
    buildExportControls(),
    buildSkippedBanner(skippedEntityTypes),
    ...warnings.map(buildBanner),
  ]) {
    if (control) toolbar.appendChild(control);
  }
  toolbarEl = toolbar;

  canvasHost = document.createElement('div');
  canvasHost.className = 'dwg-canvas';

  root.appendChild(toolbar);
  root.appendChild(canvasHost);
  root.appendChild(buildStatusBar());
  refreshLayerControl();
  redraw(false);
  if (carried.keepView && previousView && activeSvg) {
    applyViewBox(activeSvg, previousView);
    updateStatusBar();
  }
}

let toolbarEl: HTMLElement | null = null;

/**
 * A reload that fails — typically the file read mid-save — must not replace a
 * drawing the user is looking at with an error page; the next save will fix it.
 */
function showReloadError(message: string) {
  if (!toolbarEl) return;
  toolbarEl.querySelector('.dwg-reload-error')?.remove();
  const banner = buildBanner(`Reload failed — showing the previous version. ${message.split('\n')[0]}`);
  banner.classList.add('dwg-reload-error');
  toolbarEl.appendChild(banner);
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function showError(message: string) {
  scene = null;
  toolbarEl = null;
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'dwg-error';
  pre.textContent = message;
  root.appendChild(pre);
}

window.addEventListener('message', (event) => {
  const message = event.data as
    | { type: 'DXF_DATA'; pages: DxfPage[]; skippedEntityTypes: string[]; warnings?: string[]; objects?: ObjectInfo[] }
    | { type: 'DXF_ERROR'; message: string }
    | { type: 'DXF_PROGRESS'; stage: string };

  if (message.type === 'DXF_DATA') {
    try {
      renderScene(message.pages, message.skippedEntityTypes, message.warnings, message.objects);
    } catch (err) {
      showError(`Error rendering drawing:\n${describe(err)}`);
    }
  } else if (message.type === 'DXF_ERROR') {
    if (scene) showReloadError(message.message);
    else showError(message.message);
  } else if (message.type === 'DXF_PROGRESS') {
    // While a drawing is on screen, a reload works in the background.
    if (!scene) showProgress(message.stage);
  }
});

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && searchControl) {
    event.preventDefault();
    searchControl.open();
  } else if (event.key === 'Escape') {
    if (searchControl?.isOpen()) searchControl.close();
    else clearSelection();
  }
});

showLoading();
vscodeApi.postMessage({ type: 'READY' });

function showLoading() {
  root.innerHTML = '';
  const spinner = document.createElement('div');
  spinner.className = 'dwg-loading';
  spinner.innerHTML = `
    <div class="dwg-spinner"></div>
    <span class="dwg-loading-text">Loading drawing…</span>
  `;
  root.appendChild(spinner);
}

function showProgress(stage: string) {
  const textEl = root.querySelector('.dwg-loading-text');
  if (!textEl) {
    showLoading();
    const newTextEl = root.querySelector('.dwg-loading-text');
    if (newTextEl) newTextEl.textContent = stageLabel(stage);
    return;
  }
  textEl.textContent = stageLabel(stage);
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'reading': return 'Reading DWG file…';
    case 'converting': return 'Converting DWG → DXF…';
    case 'parsing': return 'Parsing drawing data…';
    default: return 'Processing…';
  }
}
