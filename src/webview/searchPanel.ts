import type { ObjectInfo } from '../shared/types';
import { HitKind, SearchHit, searchDrawing } from './search';

const KIND_LABEL: Record<HitKind, string> = {
  text: 'Text',
  attribute: 'Attributes',
  block: 'Blocks',
  layer: 'Layers',
  type: 'Object types',
};

const INPUT_DELAY_MS = 150;

export interface SearchControl {
  element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

interface Options {
  objects: ObjectInfo[];
  pageNames: string[];
  onSelect(hit: SearchHit): void;
}

/**
 * The Find button and its dropdown: a query box and the grouped results.
 * Enter / Shift+Enter step through the results in order, so a user can walk
 * every "D-1xx" door tag without touching the mouse.
 */
export function buildSearchControl({ objects, pageNames, onSelect }: Options): SearchControl {
  const wrapper = document.createElement('div');
  wrapper.className = 'dwg-search';

  const button = document.createElement('button');
  button.className = 'dwg-layer-button';
  button.textContent = 'Find';
  button.title = 'Find text, attributes, blocks, layers or object types (Ctrl+F)';
  wrapper.appendChild(button);

  const panel = document.createElement('div');
  panel.className = 'dwg-layer-panel dwg-search-panel';
  panel.hidden = true;
  wrapper.appendChild(panel);

  const inputRow = document.createElement('div');
  inputRow.className = 'dwg-search-input-row';
  const input = document.createElement('input');
  // Not type=search: Chromium clears that on Escape, losing the query each time the panel closes
  input.type = 'text';
  input.className = 'dwg-layer-filter';
  input.placeholder = 'Find in drawing…';
  input.setAttribute('aria-label', 'Find in drawing');
  const counter = document.createElement('span');
  counter.className = 'dwg-search-counter';
  inputRow.append(input, counter);
  panel.appendChild(inputRow);

  const results = document.createElement('div');
  results.className = 'dwg-search-results';
  results.setAttribute('role', 'listbox');
  panel.appendChild(results);

  let flat: { hit: SearchHit; row: HTMLElement }[] = [];
  let current = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The query the results on screen were computed for. */
  let renderedQuery: string | null = null;

  const choose = (index: number) => {
    if (flat.length === 0) return;
    current = (index + flat.length) % flat.length;
    flat.forEach(({ row }, i) => row.classList.toggle('dwg-search-current', i === current));
    flat[current].row.scrollIntoView({ block: 'nearest' });
    counter.textContent = `${current + 1} / ${flat.length}`;
    onSelect(flat[current].hit);
  };

  const render = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    renderedQuery = input.value;
    const groups = searchDrawing(objects, input.value);
    results.textContent = '';
    flat = [];
    current = -1;
    counter.textContent = '';

    if (input.value.trim() && groups.length === 0) {
      const none = document.createElement('div');
      none.className = 'dwg-layer-nomatch';
      none.textContent = 'Nothing matches';
      results.appendChild(none);
      return;
    }

    for (const group of groups) {
      const heading = document.createElement('div');
      heading.className = 'dwg-search-group';
      heading.textContent =
        group.total > group.hits.length
          ? `${KIND_LABEL[group.kind]} (${group.hits.length} of ${group.total})`
          : `${KIND_LABEL[group.kind]} (${group.total})`;
      results.appendChild(heading);

      for (const hit of group.hits) {
        const row = document.createElement('div');
        row.className = 'dwg-layer-row dwg-search-row';
        row.setAttribute('role', 'option');

        const label = document.createElement('span');
        label.className = 'dwg-layer-name';
        label.textContent = hit.label;
        label.title = hit.label;
        row.appendChild(label);

        const meta: string[] = [];
        if (hit.objects.length > 1) meta.push(String(hit.objects.length));
        if (hit.detail) meta.push(hit.detail);
        if (pageNames.length > 1) meta.push(pageNames[hit.page] ?? '');
        if (meta.length) {
          const detail = document.createElement('span');
          detail.className = 'dwg-layer-count';
          detail.textContent = meta.join(' · ');
          row.appendChild(detail);
        }

        const position = flat.length;
        row.addEventListener('click', () => choose(position));
        flat.push({ hit, row });
        results.appendChild(row);
      }
    }
    if (flat.length) counter.textContent = `${flat.length} found`;
  };

  input.addEventListener('input', () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(render, INPUT_DELAY_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter can come before the typing delay has run, or after a paste
      if (renderedQuery !== input.value) render();
      choose(current < 0 ? 0 : current + (event.shiftKey ? -1 : 1));
    }
  });

  const control: SearchControl = {
    element: wrapper,
    open() {
      panel.hidden = false;
      input.focus();
      input.select();
    },
    close() {
      panel.hidden = true;
    },
    isOpen: () => !panel.hidden,
  };

  button.addEventListener('click', () => (panel.hidden ? control.open() : control.close()));
  return control;
}
