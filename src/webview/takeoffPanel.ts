/**
 * The Quantities panel: block counts and per-layer length, area and hatch area
 * for the sheet on screen.
 *
 * It sits where the inspector sits — one of the two at a time, since both
 * describe the same selection and two panels on one canvas only get in the
 * way. Every row can select its objects, which is what makes the numbers
 * checkable: the estimator can jump to the fourteen doors and count them.
 */
import { DECLARABLE_UNITS, NO_VALUE, OUTPUT_UNITS, Unit, convertArea, convertLength, formatArea, formatLength, formatNumber } from './units';
import { toCsv, toTsv } from './table';
import { EMPTY_TAKEOFF, Takeoff } from './takeoff';

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
}

type Tab = 'blocks' | 'layers';

export function buildTakeoffPanel(options: TakeoffPanelOptions): TakeoffPanel {
  const panel = document.createElement('div');
  panel.className = 'dwg-takeoff';

  let tab: Tab = 'blocks';
  let takeoff: Takeoff = EMPTY_TAKEOFF;

  /** A length in drawing units, converted for display and export. */
  const toLength = (value: number) => convertLength(value, options.drawingUnits(), options.unit());
  /** An area in drawing units², converted for display and export. */
  const toArea = (value: number) => convertArea(value, options.drawingUnits(), options.unit());

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

  /** Column headings plus one line per entry, shared by the table and its exports. */
  const tabTable = (): { labels: string[]; rows: { cells: string[]; objects: number[] }[] } => {
    const unit = options.unit();
    if (tab === 'blocks') {
      return {
        labels: ['Block', 'Count'],
        rows: takeoff.blocks.map((row) => ({ cells: [row.name, String(row.count)], objects: row.objects })),
      };
    }
    // "Drawing units" after every number, or in every heading, crowds the table
    // off the panel; in drawing units the hint above the table says so once.
    const length = (value: number) => (unit ? formatLength(toLength(value), unit) : formatNumber(value));
    const area = (value: number) => (unit ? formatArea(toArea(value), unit) : formatNumber(value));
    const per = (suffix: string) => (unit ? ` (${unit.label}${suffix})` : '');
    return {
      labels: ['Layer', 'Objects', `Length${per('')}`, `Area${per('²')}`, `Hatch area${per('²')}`],
      rows: takeoff.layers.map((row) => ({
        cells: [row.name, String(row.count), length(row.length), area(row.area), area(row.hatchArea)],
        objects: row.objects,
      })),
    };
  };

  /** The open tab as plain text: a header row, then one row per entry. */
  const currentRows = (): string[][] => {
    const { labels, rows } = tabTable();
    return [labels, ...rows.map((row) => row.cells)];
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

  const buildRow = (cells: string[], objects: number[]): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'dwg-takeoff-row';
    for (const text of cells) {
      const cell = document.createElement('span');
      cell.textContent = text;
      row.appendChild(cell);
    }
    // ⌖ selects and zooms to exactly what the row counts.
    const locate = document.createElement('button');
    locate.className = 'dwg-takeoff-locate';
    locate.textContent = '⌖';
    locate.title = 'Select these objects and zoom to them';
    locate.setAttribute('aria-label', 'Select these objects');
    locate.addEventListener('click', () => options.onSelect(objects));
    row.appendChild(locate);
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
        : `Quantities · ${page} · ${takeoff.totals.count.toLocaleString()} objects`;

    body.textContent = '';
    if (takeoff.totals.count === 0) {
      const empty = document.createElement('div');
      empty.className = 'dwg-layer-nomatch';
      empty.textContent = 'Nothing to measure on this sheet';
      body.appendChild(empty);
      return;
    }

    const { labels, rows } = tabTable();
    const headerRow = document.createElement('div');
    headerRow.className = 'dwg-takeoff-row dwg-takeoff-head';
    for (const label of labels) {
      const cell = document.createElement('span');
      cell.textContent = label;
      headerRow.appendChild(cell);
    }
    headerRow.appendChild(document.createElement('span'));
    body.appendChild(headerRow);

    for (const row of rows) body.appendChild(buildRow(row.cells, row.objects));

    const total = document.createElement('div');
    total.className = 'dwg-takeoff-total';
    const length = toLength(takeoff.totals.length);
    const area = toArea(takeoff.totals.area);
    total.textContent = [
      `${takeoff.totals.count.toLocaleString()} objects`,
      length > 0 ? `length ${formatLength(length, options.unit())}` : NO_VALUE,
      area > 0 ? `area ${formatArea(area, options.unit())}` : NO_VALUE,
    ].join(' · ');
    body.appendChild(total);
  }

  render();

  return {
    element: panel,
    refresh: render,
  };
}