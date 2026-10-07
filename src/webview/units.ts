/**
 * Output units for the quantities panel.
 *
 * Lengths and areas are measured in drawing units, which only mean something
 * once the file says what one of them is worth (`$INSUNITS`). A drawing in
 * millimetres and one in metres hold the same numbers and mean different
 * things, so the unit is read from the file and then offered as a dropdown —
 * never guessed at.
 */

/** Metres per `$INSUNITS` code, per the DXF reference. Absent codes are not offered. */
const METRES_PER_UNIT: Record<number, number> = {
  1: 0.0254, // inch
  2: 0.3048, // foot
  3: 1609.344, // mile
  4: 0.001, // millimetre
  5: 0.01, // centimetre
  6: 1, // metre
  7: 1000, // kilometre
  8: 2.54e-8, // microinch
  9: 2.54e-5, // mil
  10: 0.9144, // yard
  11: 1e-10, // angstrom
  12: 1e-9, // nanometre
  13: 1e-6, // micron
  14: 0.1, // decimetre
  15: 10, // decametre
  16: 100, // hectometre
};

/** `$INSUNITS` codes that belong to the imperial system. */
const IMPERIAL_CODES = new Set([1, 2, 3, 8, 9, 10]);

export interface Unit {
  /** Value of the dropdown's `Unit` property. */
  id: string;
  /** Shown after every number, and in the panel header. */
  label: string;
  /** Metres per one of these units. */
  metres: number;
}

/** What a drawing without a declared unit gets: numbers as the file stores them. */
export const DRAWING_UNITS: Unit = { id: 'drawing', label: 'Drawing units', metres: 1 };

export const OUTPUT_UNITS: Unit[] = [
  { id: 'm', label: 'm', metres: 1 },
  { id: 'cm', label: 'cm', metres: 0.01 },
  { id: 'mm', label: 'mm', metres: 0.001 },
  { id: 'km', label: 'km', metres: 1000 },
  { id: 'ft', label: 'ft', metres: 0.3048 },
  { id: 'in', label: 'in', metres: 0.0254 },
  { id: 'yd', label: 'yd', metres: 0.9144 },
];

/**
 * The unit the panel starts in: metric drawings in metres, imperial ones in
 * feet. `undefined` when the file declares nothing usable, which leaves the
 * numbers in drawing units until the user picks something.
 */
export function defaultUnit(insunits: number | undefined): Unit | undefined {
  if (insunits === undefined || METRES_PER_UNIT[insunits] === undefined) return undefined;
  const wanted = IMPERIAL_CODES.has(insunits) ? 'ft' : 'm';
  return OUTPUT_UNITS.find((unit) => unit.id === wanted);
}

/** How long one drawing unit is in metres, for converting a measurement. */
export function metresPerDrawingUnit(insunits: number | undefined): number {
  if (insunits === undefined) return 1;
  return METRES_PER_UNIT[insunits] ?? 1;
}

/**
 * How many of the output unit one drawing unit is worth.
 *
 * Lengths scale by this once. Areas scale by its square — 1000 mm is 1 m, but
 * 1 000 000 mm² is 1 m², not 1000 m². Using the length factor for both was
 * quietly inflating every floor area by the linear scale.
 */
function scale(insunits: number | undefined, unit: Unit | undefined): number {
  return metresPerDrawingUnit(insunits) / (unit?.metres ?? 1);
}

/** Converts a length from drawing units into the chosen output unit. */
export function convertLength(value: number, insunits: number | undefined, unit: Unit | undefined): number {
  return value * scale(insunits, unit);
}

/** Converts an area from drawing units² into the chosen output unit squared. */
export function convertArea(value: number, insunits: number | undefined, unit: Unit | undefined): number {
  const factor = scale(insunits, unit);
  return value * factor * factor;
}

/** Shown wherever a column has nothing to report. */
export const NO_VALUE = '—';

/** `24.60 m`, or an em dash when there is nothing to show. */
export function formatLength(value: number | undefined, unit: Unit | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return NO_VALUE;
  return `${value.toFixed(2)} ${unit?.label ?? DRAWING_UNITS.label}`;
}

/** `41.25 m²`. Areas always carry the squared sign, in whatever unit is chosen. */
export function formatArea(value: number | undefined, unit: Unit | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return NO_VALUE;
  return `${value.toFixed(2)} ${unit?.label ?? DRAWING_UNITS.label}²`;
}