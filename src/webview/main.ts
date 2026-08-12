import { Bounds, DxfPage, SVG_NS, ViewportView, renderEntity } from './renderer';
import {
  BUTTON_STEP,
  ViewBox,
  applyViewBox,
  attachPanZoom,
  clientToViewBox,
  getViewBox,
  zoomCentre,
} from './panZoom';
import { toPngBase64, toStandaloneSvg } from './export';

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

  // Viewport content sits behind the sheet
  for (const view of page.viewports ?? []) {
    const el = renderViewport(view, hiddenLayers);
    if (el) styleGroup.appendChild(el);
  }

  // Filter visible entities
  const visibleEntities = page.entities.filter(e => !hiddenLayers.has(e.layer));

  const BATCH_SIZE = 3000;

  if (visibleEntities.length <= BATCH_SIZE) {
    // Small drawing: render all at once
    for (const entity of visibleEntities) {
      const el = renderEntity(entity);
      if (el) styleGroup.appendChild(el);
    }
  } else {
    // Large drawing: render first batch immediately, rest progressively
    for (let i = 0; i < BATCH_SIZE; i++) {
      const el = renderEntity(visibleEntities[i]);
      if (el) styleGroup.appendChild(el);
    }

    // Render remaining entities in batches via requestAnimationFrame
    let offset = BATCH_SIZE;
    const renderNextBatch = () => {
      // Bail if a newer renderCanvas call has started
      if (renderGeneration !== thisGeneration) return;
      if (offset >= visibleEntities.length) return;

      const end = Math.min(offset + BATCH_SIZE, visibleEntities.length);
      const fragment = document.createDocumentFragment();
      for (let i = offset; i < end; i++) {
        const el = renderEntity(visibleEntities[i]);
        if (el) fragment.appendChild(el);
      }
      styleGroup.appendChild(fragment);
      offset = end;
      if (offset < visibleEntities.length) {
        requestAnimationFrame(renderNextBatch);
      }
    };
    requestAnimationFrame(renderNextBatch);
  }

  flipGroup.appendChild(styleGroup);
  svg.appendChild(flipGroup);
  host.appendChild(svg);
  activeSvg = svg;

  const fitted = page.bounds ? fitBounds(page.bounds) : EMPTY_VIEW;
  fittedView = fitted;
  visibleEntityCount = visibleEntities.length + countVisibleViewportEntities(page, hiddenLayers);

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

  // Nothing on screen must never be a bare rectangle — say why it is empty.
  if (visibleEntityCount === 0) {
    host.appendChild(buildEmptyState(page, hiddenLayers));
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
      redraw(true);
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
  scene.pageIndex = index;
  if (pageSelect) pageSelect.value = String(index);
  refreshLayerControl();
  redraw(false);
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

function renderViewport(view: ViewportView, hiddenLayers: Set<string>): SVGElement | null {
  const visible = view.entities.filter((entity) => !hiddenLayers.has(entity.layer));
  if (visible.length === 0) return null;

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
  for (const entity of visible) {
    const el = renderEntity(entity);
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
    redraw(true);
  };

  const isolate = (name: string) => {
    for (const layer of layers) scene.hiddenLayers.add(layer.name);
    scene.hiddenLayers.delete(name);
    syncCheckboxes();
    updateButton();
    redraw(true);
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
      redraw(true);
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

function buildSkippedBanner(skippedEntityTypes: string[]): HTMLElement | null {
  if (skippedEntityTypes.length === 0) return null;

  const banner = document.createElement('span');
  banner.className = 'dwg-banner';

  const label = document.createElement('span');
  label.className = 'dwg-banner-text';
  label.textContent = `Not supported: ${skippedEntityTypes.join(', ')}`;
  label.title = label.textContent;
  banner.appendChild(label);

  const dismiss = document.createElement('button');
  dismiss.className = 'dwg-banner-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss unsupported entity notice');
  dismiss.addEventListener('click', () => banner.remove());
  banner.appendChild(dismiss);

  return banner;
}

function renderScene(pages: DxfPage[], skippedEntityTypes: string[]) {
  scene = { pages, hiddenLayers: new Set(), pageIndex: 0, skippedEntityTypes };
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

  for (const control of [
    buildPageSelect(scene),
    layerSlot,
    buildZoomControls(),
    buildExportControls(),
    buildSkippedBanner(skippedEntityTypes),
  ]) {
    if (control) toolbar.appendChild(control);
  }

  canvasHost = document.createElement('div');
  canvasHost.className = 'dwg-canvas';

  root.appendChild(toolbar);
  root.appendChild(canvasHost);
  root.appendChild(buildStatusBar());
  refreshLayerControl();
  redraw(false);
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function showError(message: string) {
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'dwg-error';
  pre.textContent = message;
  root.appendChild(pre);
}

window.addEventListener('message', (event) => {
  const message = event.data as
    | { type: 'DXF_DATA'; pages: DxfPage[]; skippedEntityTypes: string[] }
    | { type: 'DXF_ERROR'; message: string }
    | { type: 'DXF_PROGRESS'; stage: string };

  if (message.type === 'DXF_DATA') {
    try {
      renderScene(message.pages, message.skippedEntityTypes);
    } catch (err) {
      showError(`Error rendering drawing:\n${describe(err)}`);
    }
  } else if (message.type === 'DXF_ERROR') {
    showError(message.message);
  } else if (message.type === 'DXF_PROGRESS') {
    showProgress(message.stage);
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
