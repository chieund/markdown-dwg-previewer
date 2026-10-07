import type { DiffPage, DrawingDiff, DxfEntity, ViewportView } from '../shared/types';
import { SVG_NS, renderEntity } from './renderer';
import { BUTTON_STEP, ViewBox, applyViewBox, attachPanZoom, clientToViewBox, fitBounds, getViewBox, zoomCentre } from './panZoom';
import { DIFF_COLORS, pageLabel, paint, stepIndex } from './diffModel';

type Category = 'unchanged' | 'removed' | 'changedOld' | 'changedNew' | 'added';
type Toggle = 'added' | 'removed' | 'changed' | 'unchanged';

/** Bottom to top: the context first, what changed on top of it. */
const DRAW_ORDER: Category[] = ['unchanged', 'removed', 'changedOld', 'changedNew', 'added'];

const TOGGLE_OF: Record<Category, Toggle> = {
  unchanged: 'unchanged',
  removed: 'removed',
  changedOld: 'changed',
  changedNew: 'changed',
  added: 'added',
};

const TOGGLE_LABEL: Record<Toggle, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/** Entities drawn per animation frame, as in the drawing view. */
const BATCH_SIZE = 3000;

/** Keyboard handler of the view on screen. One window listener serves every render, so none pile up. */
let onKey: ((event: KeyboardEvent) => void) | null = null;
window.addEventListener('keydown', (event) => onKey?.(event));

let clipCounter = 0;

/**
 * The comparison view: both versions of a drawing on one canvas, coloured by
 * what happened to each object, with a list of the changes to step through.
 */
export function renderDiff(root: HTMLElement, diff: DrawingDiff): void {
  root.innerHTML = '';
  const visible: Record<Toggle, boolean> = { added: true, removed: true, changed: true, unchanged: true };
  let pageIndex = Math.max(0, diff.pages.findIndex((page) => page.changes.length > 0));
  let current = -1;
  let svg: SVGSVGElement | null = null;
  let fitted: ViewBox | null = null;
  let groups = new Map<Category, SVGGElement>();
  let marker: SVGRectElement | null = null;
  let disposePanZoom: (() => void) | null = null;
  /** Bumped per page shown; a batch for an older page stops. */
  let generation = 0;

  // ── Toolbar ──────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'dwg-toolbar';

  const title = document.createElement('span');
  title.className = 'dwg-diff-title';
  title.textContent = `${diff.oldLabel}  ↔  ${diff.newLabel}`;
  title.title = title.textContent;
  toolbar.appendChild(title);

  let select: HTMLSelectElement | null = null;
  if (diff.pages.length > 1) {
    select = document.createElement('select');
    select.className = 'dwg-page-select';
    diff.pages.forEach((page, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = pageLabel(page);
      select!.appendChild(option);
    });
    select.addEventListener('change', () => showPage(Number(select!.value)));
    toolbar.appendChild(select);
  }

  const toggles = document.createElement('div');
  toggles.className = 'dwg-diff-toggles';
  const toggleCounts = new Map<Toggle, HTMLElement>();
  for (const toggle of ['added', 'removed', 'changed', 'unchanged'] as Toggle[]) {
    const label = document.createElement('label');
    label.className = 'dwg-diff-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      visible[toggle] = box.checked;
      applyVisibility();
    });
    const swatch = document.createElement('span');
    swatch.className = 'dwg-layer-swatch';
    swatch.style.background = DIFF_COLORS[toggle];
    const text = document.createElement('span');
    toggleCounts.set(toggle, text);
    label.append(box, swatch, text);
    toggles.appendChild(label);
  }
  toolbar.appendChild(toggles);

  const nav = document.createElement('div');
  nav.className = 'dwg-zoom';
  const prev = navButton('◀', 'Previous change (Shift+F7)', () => step(-1));
  const position = document.createElement('span');
  position.className = 'dwg-diff-position';
  const next = navButton('▶', 'Next change (F7)', () => step(1));
  nav.append(prev, position, next);
  toolbar.appendChild(nav);

  // The list of changes, in the same dropdown style as Layers and Find
  const listWrap = document.createElement('div');
  listWrap.className = 'dwg-search';
  const listButton = document.createElement('button');
  listButton.className = 'dwg-layer-button';
  listButton.textContent = 'Changes';
  const listPanel = document.createElement('div');
  listPanel.className = 'dwg-layer-panel dwg-search-panel';
  listPanel.hidden = true;
  listButton.addEventListener('click', () => (listPanel.hidden = !listPanel.hidden));
  listWrap.append(listButton, listPanel);
  toolbar.appendChild(listWrap);

  const zoom = document.createElement('div');
  zoom.className = 'dwg-zoom';
  zoom.append(
    navButton('−', 'Zoom out', () => svg && zoomCentre(svg, BUTTON_STEP)),
    navButton('+', 'Zoom in', () => svg && zoomCentre(svg, 1 / BUTTON_STEP)),
    navButton('Fit', 'Fit the drawing to the view', () => svg && fitted && applyViewBox(svg, fitted))
  );
  toolbar.appendChild(zoom);

  for (const warning of diff.warnings ?? []) {
    const banner = document.createElement('span');
    banner.className = 'dwg-banner';
    banner.textContent = warning;
    toolbar.appendChild(banner);
  }
  if (!diff.handleMatching) {
    const note = document.createElement('span');
    note.className = 'dwg-banner';
    note.textContent = 'Handles differ between the files: moved objects show as removed + added';
    note.title = note.textContent;
    toolbar.appendChild(note);
  }

  const canvas = document.createElement('div');
  canvas.className = 'dwg-canvas';
  const status = document.createElement('div');
  status.className = 'dwg-statusbar';
  root.append(toolbar, canvas, status);

  onKey = (event) => {
    if (event.key === 'F7') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      listPanel.hidden = true;
    }
  };

  showPage(pageIndex);

  // ── Page ─────────────────────────────────────────────────────────────────
  function showPage(index: number): void {
    pageIndex = index;
    current = -1;
    if (select) select.value = String(index);
    const page = diff.pages[index];

    disposePanZoom?.();
    canvas.innerHTML = '';
    svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
    svg.style.cursor = 'grab';

    const flip = document.createElementNS(SVG_NS, 'g');
    flip.setAttribute('transform', 'scale(1,-1)');
    groups = new Map();
    const thisGeneration = ++generation;
    for (const category of DRAW_ORDER) {
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', `dwg-diff-${category}`);
      if (category === 'unchanged') {
        for (const view of page.viewports ?? []) group.appendChild(renderViewport(view));
      }
      drawBatched(group, colour(page, category), () => thisGeneration === generation);
      groups.set(category, group);
      flip.appendChild(group);
    }
    marker = document.createElementNS(SVG_NS, 'rect');
    marker.setAttribute('class', 'dwg-diff-marker');
    marker.setAttribute('fill', 'none');
    marker.setAttribute('vector-effect', 'non-scaling-stroke');
    marker.style.display = 'none';
    flip.appendChild(marker);
    svg.appendChild(flip);
    canvas.appendChild(svg);

    fitted = page.bounds ? fitBounds(page.bounds) : { x: -50, y: -50, w: 100, h: 100 };
    applyViewBox(svg, fitted);
    const view = svg;
    disposePanZoom = attachPanZoom(view, () => fitted && applyViewBox(view, fitted), updateStatus);
    view.addEventListener('mousemove', (event) => {
      const point = clientToViewBox(view, event.clientX, event.clientY);
      updateStatus({ x: point.x, y: -point.y });
    });

    if (page.changes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dwg-empty';
      const heading = document.createElement('div');
      heading.className = 'dwg-empty-title';
      heading.textContent = diff.pages.some((p) => p.changes.length) ? 'No differences on this sheet' : 'No differences';
      const detail = document.createElement('div');
      detail.className = 'dwg-empty-detail';
      detail.textContent = 'Every object on it is the same in both versions.';
      empty.append(heading, detail);
      canvas.appendChild(empty);
    }

    const counts: Record<Toggle, number> = {
      added: page.changes.filter((c) => c.kind === 'added').length,
      removed: page.changes.filter((c) => c.kind === 'removed').length,
      changed: page.changes.filter((c) => c.kind === 'changed').length,
      unchanged: page.unchanged.length,
    };
    for (const [toggle, el] of toggleCounts) el.textContent = `${TOGGLE_LABEL[toggle]} ${counts[toggle]}`;

    buildList(page);
    applyVisibility();
    updatePosition();
    updateStatus();
  }

  function colour(page: DiffPage, category: Category): DxfEntity[] {
    switch (category) {
      case 'unchanged': return paint(page.unchanged, DIFF_COLORS.unchanged);
      case 'removed': return paint(page.removed, DIFF_COLORS.removed);
      case 'changedOld': return paint(page.changedOld, DIFF_COLORS.removed, true);
      case 'changedNew': return paint(page.changedNew, DIFF_COLORS.changed);
      case 'added': return paint(page.added, DIFF_COLORS.added);
    }
  }

  function applyVisibility(): void {
    for (const [category, group] of groups) {
      group.style.display = visible[TOGGLE_OF[category]] ? '' : 'none';
    }
    placeMarker();
  }

  /** Frames the current change, unless it has no extent or its kind is switched off. */
  function placeMarker(): void {
    if (!marker) return;
    const change = diff.pages[pageIndex].changes[current];
    if (!change?.bounds || !visible[change.kind]) {
      marker.style.display = 'none';
      return;
    }
    const b = change.bounds;
    const view = svg ? getViewBox(svg) : null;
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY, (view?.w ?? 0) * 0.02) * 0.15;
    marker.setAttribute('x', String(b.minX - pad));
    marker.setAttribute('y', String(b.minY - pad));
    marker.setAttribute('width', String(b.maxX - b.minX + pad * 2));
    marker.setAttribute('height', String(b.maxY - b.minY + pad * 2));
    marker.setAttribute('stroke', DIFF_COLORS[change.kind]);
    marker.style.display = '';
  }

  // ── Changes ──────────────────────────────────────────────────────────────
  function buildList(page: DiffPage): void {
    listPanel.textContent = '';
    listButton.textContent = `Changes (${page.changes.length})`;
    if (page.changes.length === 0) {
      const none = document.createElement('div');
      none.className = 'dwg-layer-nomatch';
      none.textContent = 'No changes on this sheet';
      listPanel.appendChild(none);
      return;
    }
    page.changes.forEach((change, index) => {
      const row = document.createElement('div');
      row.className = 'dwg-layer-row dwg-search-row';
      const swatch = document.createElement('span');
      swatch.className = 'dwg-layer-swatch';
      swatch.style.background = DIFF_COLORS[change.kind];
      const label = document.createElement('span');
      label.className = 'dwg-layer-name';
      label.textContent = change.label;
      label.title = change.label;
      row.append(swatch, label);
      row.addEventListener('click', () => goTo(index));
      listPanel.appendChild(row);
    });
  }

  function step(delta: 1 | -1): void {
    const page = diff.pages[pageIndex];
    const index = stepIndex(current, page.changes.length, delta);
    if (index >= 0) goTo(index);
  }

  function goTo(index: number): void {
    const page = diff.pages[pageIndex];
    const change = page.changes[index];
    if (!change || !svg || !fitted) return;
    current = index;
    listPanel.querySelectorAll('.dwg-search-row').forEach((row, i) => row.classList.toggle('dwg-search-current', i === index));

    if (change.bounds) {
      const view = fitBounds(change.bounds);
      // Keep some of the surroundings in view around a small change
      const minWidth = fitted.w * 0.1;
      if (view.w < minWidth) {
        const grow = minWidth / view.w;
        view.x -= (view.w * (grow - 1)) / 2;
        view.y -= (view.h * (grow - 1)) / 2;
        view.w *= grow;
        view.h *= grow;
      }
      applyViewBox(svg, view);
    }
    placeMarker();
    updatePosition();
    updateStatus();
  }

  function updatePosition(): void {
    const total = diff.pages[pageIndex].changes.length;
    position.textContent = total === 0 ? '0 / 0' : `${current < 0 ? '–' : current + 1} / ${total}`;
    prev.disabled = next.disabled = total === 0;
  }

  function updateStatus(cursor?: { x: number; y: number }): void {
    const page = diff.pages[pageIndex];
    const parts = [cursor ? `X ${cursor.x.toFixed(2)}   Y ${cursor.y.toFixed(2)}` : 'X —   Y —'];
    if (svg && fitted) parts.push(`Zoom ${Math.round((fitted.w / getViewBox(svg).w) * 100)}%`);
    const change = page.changes[current];
    if (change) parts.push(change.label);
    status.textContent = parts.join('     ');
  }
}

/** Appends rendered entities, the first batch now and the rest a frame at a time while `live()` holds. */
function drawBatched(target: SVGGElement, entities: DxfEntity[], live: () => boolean): void {
  const draw = (from: number) => {
    if (!live()) return;
    const end = Math.min(from + BATCH_SIZE, entities.length);
    const fragment = document.createDocumentFragment();
    for (let i = from; i < end; i++) {
      const el = renderEntity(entities[i]);
      if (el) fragment.appendChild(el);
    }
    target.appendChild(fragment);
    if (end < entities.length) requestAnimationFrame(() => draw(end));
  };
  draw(0);
}

/** A viewport's model content, clipped to its window and greyed out like the rest of the context. */
function renderViewport(view: ViewportView): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  const id = `dwg-diff-viewport-${clipCounter++}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const clip = document.createElementNS(SVG_NS, 'clipPath');
  clip.setAttribute('id', id);
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(view.rect.x));
  rect.setAttribute('y', String(view.rect.y));
  rect.setAttribute('width', String(view.rect.width));
  rect.setAttribute('height', String(view.rect.height));
  clip.appendChild(rect);
  defs.appendChild(clip);
  group.appendChild(defs);
  const content = document.createElementNS(SVG_NS, 'g');
  content.setAttribute('clip-path', `url(#${id})`);
  for (const entity of paint(view.entities, DIFF_COLORS.unchanged)) {
    const el = renderEntity(entity);
    if (el) content.appendChild(el);
  }
  group.appendChild(content);
  return group;
}

function navButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'dwg-zoom-button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', run);
  return button;
}
