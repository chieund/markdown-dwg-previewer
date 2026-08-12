import { Bounds, DxfPage, SVG_NS, ViewportView, renderEntity } from './renderer';
import { ViewBox, applyViewBox, attachPanZoom, getViewBox } from './panZoom';
import { toPngBase64, toStandaloneSvg } from './export';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLDivElement;

interface Scene {
  pages: DxfPage[];
  hiddenLayers: Set<string>;
  pageIndex: number;
}

let scene: Scene | null = null;
let canvasHost: HTMLElement | null = null;
let layerSlot: HTMLElement | null = null;
let activeSvg: SVGSVGElement | null = null;
let disposeActivePanZoom: (() => void) | null = null;

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

function renderCanvas(host: HTMLElement, page: DxfPage, hiddenLayers: Set<string>, keepView: boolean) {
  const previousView = keepView && activeSvg ? getViewBox(activeSvg) : null;

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

  for (const view of page.viewports ?? []) {
    const el = renderViewport(view, hiddenLayers);
    if (el) styleGroup.appendChild(el);
  }

  for (const entity of page.entities) {
    if (hiddenLayers.has(entity.layer)) continue;
    const el = renderEntity(entity);
    if (el) styleGroup.appendChild(el);
  }

  flipGroup.appendChild(styleGroup);
  svg.appendChild(flipGroup);
  host.appendChild(svg);
  activeSvg = svg;

  const fitted = page.bounds ? fitBounds(page.bounds) : EMPTY_VIEW;
  applyViewBox(svg, previousView ?? fitted);
  disposeActivePanZoom = attachPanZoom(svg, () => applyViewBox(svg, fitted));
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
  select.addEventListener('change', () => {
    scene.pageIndex = Number(select.value);
    refreshLayerControl();
    redraw(false);
  });
  return select;
}

function refreshLayerControl() {
  if (!layerSlot || !scene) return;
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

  const actions = document.createElement('div');
  actions.className = 'dwg-layer-actions';
  const checkboxes: HTMLInputElement[] = [];

  const setAll = (visible: boolean) => {
    for (const layer of layers) {
      if (visible) scene.hiddenLayers.delete(layer.name);
      else scene.hiddenLayers.add(layer.name);
    }
    for (const box of checkboxes) box.checked = visible;
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
    const row = document.createElement('label');
    row.className = 'dwg-layer-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !scene.hiddenLayers.has(layer.name);
    box.addEventListener('change', () => {
      if (box.checked) scene.hiddenLayers.delete(layer.name);
      else scene.hiddenLayers.add(layer.name);
      updateButton();
      redraw(true);
    });
    checkboxes.push(box);

    const swatch = document.createElement('span');
    swatch.className = 'dwg-layer-swatch';
    swatch.style.background = layer.color;

    const name = document.createElement('span');
    name.className = 'dwg-layer-name';
    name.textContent = layer.name;
    name.title = layer.name;

    const count = document.createElement('span');
    count.className = 'dwg-layer-count';
    count.textContent = String(layer.entityCount);

    row.append(box, swatch, name, count);
    panel.appendChild(row);
  }

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !wrapper.contains(event.target as Node)) panel.hidden = true;
  });

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
  scene = { pages, hiddenLayers: new Set(), pageIndex: 0 };
  activeSvg = null;
  root.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'dwg-toolbar';

  layerSlot = document.createElement('div');
  layerSlot.className = 'dwg-layer-slot';

  for (const control of [
    buildPageSelect(scene),
    layerSlot,
    buildExportControls(),
    buildSkippedBanner(skippedEntityTypes),
  ]) {
    if (control) toolbar.appendChild(control);
  }

  canvasHost = document.createElement('div');
  canvasHost.className = 'dwg-canvas';

  root.appendChild(toolbar);
  root.appendChild(canvasHost);
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
    | { type: 'DXF_ERROR'; message: string };

  if (message.type === 'DXF_DATA') {
    try {
      renderScene(message.pages, message.skippedEntityTypes);
    } catch (err) {
      showError(`Error rendering drawing:\n${describe(err)}`);
    }
  } else if (message.type === 'DXF_ERROR') {
    showError(message.message);
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
    <span>Converting and loading DWG drawing…</span>
  `;
  root.appendChild(spinner);
}
