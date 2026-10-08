/**
 * The Quantities tables as text, twice over: grouped for the eye, and bare for
 * the clipboard and CSV.
 *
 * The unit is named once, in the column heading. A cell reading "86.04 m"
 * pastes into Excel as text, which cannot be summed — the whole point of
 * handing the numbers over.
 */
import { Unit, convertArea, convertLength, exportNumber, formatCount, formatNumber } from './units';
import type { Takeoff } from './takeoff';

export type TakeoffTab = 'blocks' | 'layers';

export interface TakeoffTableRow {
  name: string;
  /** Cells as shown: `12,600.00`, `—`. */
  display: string[];
  /** Cells as copied and saved: `12600.00`, empty. */
  exported: string[];
  /** Indices into the object table, so a row can select what it counts. */
  objects: number[];
}

export interface TakeoffTable {
  labels: string[];
  rows: TakeoffTableRow[];
  total: { display: string[]; exported: string[] };
}

export interface TableUnits {
  /** Output unit; none leaves the numbers in drawing units. */
  unit: Unit | undefined;
  /** `$INSUNITS` of the drawing (declared, or what the user said it is). */
  insunits: number | undefined;
}

/** A cell holds a count or a measurement; each formats its own way. */
type Cell = { count: number } | { length: number } | { area: number };

export function takeoffTable(takeoff: Takeoff, tab: TakeoffTab, { unit, insunits }: TableUnits): TakeoffTable {
  const show = (cell: Cell): string =>
    'count' in cell
      ? formatCount(cell.count)
      : formatNumber('length' in cell ? convertLength(cell.length, insunits, unit) : convertArea(cell.area, insunits, unit));
  const bare = (cell: Cell): string =>
    'count' in cell
      ? String(cell.count)
      : exportNumber('length' in cell ? convertLength(cell.length, insunits, unit) : convertArea(cell.area, insunits, unit));
  const line = (name: string, cells: Cell[]) => ({
    display: [name, ...cells.map(show)],
    exported: [name, ...cells.map(bare)],
  });

  if (tab === 'blocks') {
    const count = takeoff.blocks.reduce((sum, row) => sum + row.count, 0);
    return {
      labels: ['Block', 'Count'],
      rows: takeoff.blocks.map((row) => ({ name: row.name, objects: row.objects, ...line(row.name, [{ count: row.count }]) })),
      total: line('Total', [{ count }]),
    };
  }

  const per = (suffix: string) => (unit ? ` (${unit.label}${suffix})` : '');
  const measures = (row: { count: number; length: number; area: number; hatchArea: number }): Cell[] => [
    { count: row.count },
    { length: row.length },
    { area: row.area },
    { area: row.hatchArea },
  ];
  return {
    labels: ['Layer', 'Objects', `Length${per('')}`, `Area${per('²')}`, `Hatch area${per('²')}`],
    rows: takeoff.layers.map((row) => ({ name: row.name, objects: row.objects, ...line(row.name, measures(row)) })),
    total: line('Total', measures(takeoff.totals)),
  };
}
