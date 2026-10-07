/**
 * The Quantities panel: block counts and per-layer length, area and hatch area
 * for the sheet on screen.
 *
 * It sits where the inspector sits — one of the two at a time, since both
 * describe the same selection and two panels on one canvas only get in the
 * way. Every row can select its objects, which is what makes the numbers
 * checkable: the estimator can jump to the fourteen doors and count them.
 */
import { DRAWING_UNITS, NO_VALUE, OUTPUT_UNITS, Unit, convert, formatArea, formatLength } from './units';
import { toCsv, toTsv } from './table';
import { EMPTY_TAKEOFF, Takeoff } from './takeoff';

export interface TakeoffPanelOptions {
  /** Name of the page being measured, for the panel header. */
  pageName(): string;
  /** `$INSUNITS` of the drawing, if it declares one. */
  insunits: number | undefined;
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

  const unitLabel = () => (options.unit() ?? DRAWING_UNITS).label;
  /** A length or area in drawing units, converted for display and export. */
  const to = (value: number) => convert(value, options.insunits, options.unit());

  // ── Header ────────────────────────────────────────────────────────────────

  const header = document.createElement('div');
  header.className = 'dwg-takeoff-header';

  const title = document.createElement('div');
  title.className = 'dwg-takeoff-title';

  const unitSelect = document.createElement('select');
  unitSelect.className = 'dwg-takeoff-units';
  unitSelect.title = 'Unit the numbers are shown and exported in';
  unitSelect.setAttribute('aria-label', 'Output unit');
  // A drawing that declares no unit offers "Drawing units" as an explicit
  // choice rather than falling silently back to metres.
  for (const choice of options.unit() ? OUTPUT_UNITS : [DRAWING_UNITS, ...OUTPUT_UNITS]) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    unitSelect.appendChild(option);
  }
  unitSelect.value = options.unit()?.id ?? DRAWING_UNITS.id;
  unitSelect.addEventListener('change', () => {
    const chosen = [...OUTPUT_UNITS, DRAWING_UNITS].find((choice) => choice.id === unitSelect.value);
    if (chosen) options.onUnitChange(chosen);
    render();
  });

  const close = document.createElement('button');
  close.className = 'dwg-inspector-close';
  close.textContent = '×';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close quantities');
  close.addEventListener('click', () => options.onClose());

  header.append(title, unitSelect, close);
  panel.appendChild(header);

  // Never guessed: the numbers only mean something once the unit is known.
  const unitHint = document.createElement('div');
  unitHint.className = 'dwg-takeoff-hint';
  unitHint.hidden = options.insunits !== undefined;
  unitHint.textContent = 'This drawing does not declare a unit — the numbers are in drawing units.';
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
    const label = unitLabel();
    return {
      labels: ['Layer', 'Objects', `Length (${label})`, `Area (${label}²)`, `Hatch area (${label}²)`],
      rows: takeoff.layers.map((row) => ({
        cells: [
          row.name,
          String(row.count),
          formatLength(to(row.length), unit),
          formatArea(to(row.area), unit),
          formatArea(to(row.hatchArea), unit),
        ],
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
    const length = to(takeoff.totals.length);
    const area = to(takeoff.totals.area);
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