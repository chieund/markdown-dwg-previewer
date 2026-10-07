import type { DiffPage, DxfEntity } from '../shared/types';

/** Colours of the diff view; the same in legend, toolbar toggles and drawing. */
export const DIFF_COLORS = {
  added: '#73c991',
  removed: '#f14c4c',
  changed: '#e2c08d',
  unchanged: '#8a8a8a',
} as const;

/** Dash pattern for the old shape of a changed object, so it reads as "was here". */
const OLD_SHAPE_DASH = '6 4';

/** Copies of `entities` drawn in `color`, optionally dashed. */
export function paint(entities: DxfEntity[], color: string, dashed = false): DxfEntity[] {
  return entities.map((entity) => (dashed ? { ...entity, color, linetype: OLD_SHAPE_DASH } : { ...entity, color }));
}

export function pageLabel(page: DiffPage): string {
  const count = page.changes.length;
  if (count === 0) return `${page.name} (no changes)`;
  return `${page.name} (${count} ${count === 1 ? 'change' : 'changes'})`;
}

/** Next (delta 1) or previous (delta -1) change, wrapping; -1 when there is none. */
export function stepIndex(current: number, total: number, delta: 1 | -1): number {
  if (total === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}
