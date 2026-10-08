/**
 * The Quantities panel: block counts and per-layer length, area and hatch area
 * for the sheet on screen.
 *
 * It is docked in the sidebar beside the canvas; the inspector sits above it while it is open.
 * Every row can select its objects, which is what makes the numbers
 * checkable: the estimator can jump to the fourteen doors and count them.
 */
import { DECLARABLE_UNITS, OUTPUT_UNITS, Unit, formatCount } from './units';
import { toCsv, toTsv } from './table';
import { EMPTY_TAKEOFF, Takeoff } from './takeoff';
import { TakeoffTab, takeoffTable } from './takeoffTable';

export interface TakeoffPanelOptions {
  /** Name of the page being measured, for the panel header. */
  pageName(): string;
  /** `$INSUNITS` the file declares, when it is a unit that converts. */
  declaredUnits: number | undefined;
  /** The drawing's unit: the declared one, or what the user said it is. */
  drawingUnits(): number | undefined;
  /** The user said what a drawing that declares nothing is drawn in. */
  onDrawingUnitsChange(insunits: number | undefined): void;
  /** Unit currently chosen; the panel does not own it, so the status bar agrees. */
  unit(): Unit | undefined;
  onUnitChange(unit: Unit): void;
  /** Recomputes the tables; run again whenever layers or the page change. */
  compute(): Takeoff;
  /** Selects the given objects and zooms to them. */
  onSelect(objects: number[]): void;
  /** What is selected on the canvas, so the row that selected it stays marked. */
  selection(): number[];
  /** A layer's colour on the page, for the swatch that ties a row to the drawing. */
  layerColor(name: string): string | undefined;
  /** Closes the panel. */
  onClose(): void;
  /** Hands text to the clipboard. */
  onCopy(text: string): void;
  /** Saves CSV text through the host's save dialog. */
  onExportCsv(text: string): void;
}

export interface TakeoffPanel {
  element: HTMLElement;
  /** Recomputes and redraws both tabs. */
  refresh(): void;
  /** Marks the row whose objects are the selection; cheap, for every click on the canvas. */
  syncSelection(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A magnifier over a crosshair: "find these on the drawing". Drawn rather than
 * a glyph — the ⌖ character is missing from many fonts and renders as a box.
 */
function locateIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6.5 1.5a5 5 0 1 0 0 10a5 5 0 1 0 0-10ZM6.5 4v5M4 6.5h5M10.2 10.2L14.5 14.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/** Whether a row's objects are exactly the selection, in any order. */
function sameObjects(a: number[], b: number[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const set = new Set(b);
  return a.every((index) => set.has(index));
}

interface TableRow {
  cells: string[];
  objects: number[];
  /** Layer colour shown before the name. */
  color?: string;
}

type Tab = TakeoffTab;

export function buildTakeoffPanel(options: TakeoffPanelOptions): TakeoffPanel {
  const panel = document.createElement('div');
  panel.className = 'dwg-takeoff';

  let tab: Tab = 'blocks';
  let takeoff: Takeoff = EMPTY_TAKEOFF;

  // ── Header ────────────────────────────────────────────────────────────────

  const header = document.createElement('div');
  header.className = 'dwg-takeoff-header';

  const title = document.createElement('div');
  title.className = 'dwg-takeoff-title';

  const unitSelect = document.createElement('select');
  unitSelect.className = 'dwg-takeoff-units';
  unitSelect.title = 'Unit the numbers are shown and exported in';
  unitSelect.setAttribute('aria-label', 'Output unit');
  for (const choice of OUTPUT_UNITS) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    unitSelect.appendChild(option);
  }
  unitSelect.addEventListener('change', () => {
    const chosen = OUTPUT_UNITS.find((choice) => choice.id === unitSelect.value);
    if (chosen) options.onUnitChange(chosen);
    render();
  });
  /** Converting needs to know the drawing's unit; until then there is nothing to choose. */
  const syncUnitSelect = () => {
    const unit = options.unit();
    unitSelect.hidden = options.drawingUnits() === undefined || !unit;
    if (unit) unitSelect.value = unit.id;
  };
  syncUnitSelect();

  const close = document.createElement('button');
  close.className = 'dwg-inspector-close';
  close.textContent = '×';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close quantities');
  close.addEventListener('click', () => options.onClose());

  header.append(title, unitSelect, close);
  panel.appendChild(header);

  // Never guessed: a drawing that does not declare its unit stays in drawing
  // units until the user says what one of them is.
  const unitHint = document.createElement('div');
  unitHint.className = 'dwg-takeoff-hint';
  unitHint.hidden = options.declaredUnits !== undefined;
  const hintText = document.createElement('span');
  const declare = document.createElement('select');
  declare.className = 'dwg-takeoff-units';
  declare.title = 'What one drawing unit is — the file does not say';
  declare.setAttribute('aria-label', 'Drawing unit');
  const notSet = document.createElement('option');
  notSet.value = '';
  notSet.textContent = '1 unit = ?';
  declare.appendChild(notSet);
  for (const { code, label } of DECLARABLE_UNITS) {
    const option = document.createElement('option');
    option.value = String(code);
    option.textContent = `1 unit = 1 ${label}`;
    declare.appendChild(option);
  }
  declare.value = options.declaredUnits === undefined ? String(options.drawingUnits() ?? '') : '';
  const syncHint = () => {
    hintText.textContent =
      options.drawingUnits() === undefined
        ? 'This drawing does not declare a unit — the numbers are in drawing units. '
        : 'This drawing does not declare a unit — converted from the unit you chose. ';
  };
  declare.addEventListener('change', () => {
    options.onDrawingUnitsChange(declare.value ? Number(declare.value) : undefined);
    syncHint();
    syncUnitSelect();
    render();
  });
  syncHint();
  unitHint.append(hintText, declare);
  panel.appendChild(unitHint);

  // ── Tabs ──────────────────────────────────────────────────────────────────

  const tabs = document.createElement('div');
  tabs.className = 'dwg-takeoff-tabs';
  const tabButtons = new Map<Tab, HTMLElement>();
  for (const [id, label] of [
    ['blocks', 'Blocks'],
    ['layers', 'Layers'],
  ] as const) {
    const button = document.createElement('button');
    button.className = 'dwg-takeoff-tab';
    button.textContent = label;
    button.addEventListener('click', () => {
      tab = id;
      render();
    });
    tabButtons.set(id, button);
    tabs.appendChild(button);
  }
  panel.appendChild(tabs);

  const body = document.createElement('div');
  body.className = 'dwg-takeoff-body';
  panel.appendChild(body);

  // ── What gets copied and saved ────────────────────────────────────────────

  /** The open tab, as shown and as exported. */
  const tabTable = () => takeoffTable(takeoff, tab, { unit: options.unit(), insunits: options.drawingUnits() });

  /** The open tab as plain text for a spreadsheet: a header row, then one row per entry. */
  const currentRows = (): string[][] => {
    const { labels, rows } = tabTable();
    return [labels, ...rows.map((row) => row.exported)];
  };

  // ── Footer ────────────────────────────────────────────────────────────────

  const footer = document.createElement('div');
  footer.className = 'dwg-takeoff-footer';
  const copy = document.createElement('button');
  copy.className = 'dwg-takeoff-action';
  copy.textContent = 'Copy table';
  copy.addEventListener('click', () => options.onCopy(toTsv(currentRows())));
  const exportCsv = document.createElement('button');
  exportCsv.className = 'dwg-takeoff-action';
  exportCsv.textContent = 'Export CSV';
  exportCsv.addEventListener('click', () => options.onExportCsv(toCsv(currentRows())));
  footer.append(copy, exportCsv);
  panel.appendChild(footer);

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Rows on screen with what they select, to mark the one matching the selection. */
  let rowElements: { element: HTMLElement; objects: number[] }[] = [];

  const syncSelection = () => {
    const selection = options.selection();
    for (const { element, objects } of rowElements) {
      element.classList.toggle('dwg-takeoff-row-active', sameObjects(objects, selection));
    }
  };

  const buildRow = ({ cells, objects, color }: TableRow): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'dwg-takeoff-row';
    cells.forEach((text, column) => {
      const cell = document.createElement('span');
      if (column === 0) {
        cell.className = 'dwg-takeoff-name';
        if (color) {
          const swatch = document.createElement('span');
          swatch.className = 'dwg-layer-swatch';
          swatch.style.background = color;
          cell.appendChild(swatch);
        }
        const name = document.createElement('span');
        name.textContent = text;
        name.title = text;
        cell.appendChild(name);
      } else {
        cell.className = 'dwg-takeoff-number';
        cell.textContent = text;
      }
      row.appendChild(cell);
    });
    // Selects and zooms to exactly what the row counts.
    const locate = document.createElement('button');
    locate.className = 'dwg-takeoff-locate';
    locate.title = 'Select these objects and zoom to them';
    locate.setAttribute('aria-label', `Select ${cells[0]} on the drawing`);
    locate.appendChild(locateIcon());
    locate.addEventListener('click', () => {
      options.onSelect(objects);
      syncSelection();
    });
    row.appendChild(locate);
    rowElements.push({ element: row, objects });
    return row;
  };

  function render(): void {
    takeoff = options.compute();
    for (const [id, button] of tabButtons) button.classList.toggle('dwg-takeoff-tab-active', id === tab);

    const page = options.pageName();
    const name = tab === 'blocks' ? 'Blocks' : 'Layers';
    copy.title = `Copy the ${name} tab to the clipboard, ready to paste into a spreadsheet`;
    exportCsv.title = `Save the ${name} tab as a CSV file`;
    title.textContent =
      takeoff.totals.count === 0
        ? `Quantities · ${page}`
        : `Quantities · ${page} · ${formatCount(takeoff.totals.count)} objects`;

    body.textContent = '';
    rowElements = [];
    body.className = `dwg-takeoff-body dwg-takeoff-${tab}`;
    if (takeoff.totals.count === 0) {
      const empty = document.createElement('div');
      empty.className = 'dwg-layer-nomatch';
      empty.textContent = 'Nothing to measure on this sheet';
      body.appendChild(empty);
      return;
    }

    const { labels, rows, total } = tabTable();
    // Header, rows and total share one set of columns, so the numbers line up
    const line = (cells: string[], className: string) => {
      const row = document.createElement('div');
      row.className = `dwg-takeoff-row ${className}`;
      cells.forEach((text, column) => {
        const cell = document.createElement('span');
        cell.className = column === 0 ? 'dwg-takeoff-name' : 'dwg-takeoff-number';
        cell.textContent = text;
        row.appendChild(cell);
      });
      row.appendChild(document.createElement('span'));
      return row;
    };
    body.appendChild(line(labels, 'dwg-takeoff-head'));
    for (const row of rows) {
      const color = tab === 'layers' ? options.layerColor(row.name) : undefined;
      body.appendChild(buildRow({ cells: row.display, objects: row.objects, color }));
    }
    body.appendChild(line(total.display, 'dwg-takeoff-total'));
    syncSelection();
  }

  render();

  return {
    element: panel,
    refresh: render,
    syncSelection,
  };
}