/**
 * Turns the objects of a drawing into the quantities an estimator asks for:
 * how many of each block, and per layer how much linework and area.
 *
 * The unit of work is the object — one wall polyline, one door INSERT — the same
 * unit search and the inspector use, so a number here always refers to
 * something the user can click and see.
 */
import type { ObjectInfo } from '../shared/types';

export interface BlockRow {
  name: string;
  count: number;
  /** Indices into the object table, so a row can select its blocks. */
  objects: number[];
}

export interface LayerRow {
  name: string;
  count: number;
  length: number;
  area: number;
  hatchArea: number;
  objects: number[];
}

export interface Takeoff {
  blocks: BlockRow[];
  layers: LayerRow[];
  totals: Totals;
}

/** A sheet with nothing on it: the panel's starting state. */
export const EMPTY_TAKEOFF: Takeoff = {
  blocks: [],
  layers: [],
  totals: { count: 0, length: 0, area: 0, hatchArea: 0 },
};

export interface Totals {
  count: number;
  length: number;
  area: number;
  hatchArea: number;
}

/**
 * Counts what is on the page the user is looking at.
 *
 * Layers that are switched off are left out: the panel measures what the screen
 * shows, so a layer switched off does not quietly inflate the totals. Objects
 * that were never drawn — invisible, unsupported, or cut off by the entity
 * limit — are left out too, since there is nothing on screen to account for.
 */
export function takeOff(objects: ObjectInfo[], page: number, hiddenLayers: Set<string>): Takeoff {
  const blocks = new Map<string, BlockRow>();
  const layers = new Map<string, LayerRow>();
  const totals: Totals = { count: 0, length: 0, area: 0, hatchArea: 0 };

  objects.forEach((object, index) => {
    if (object.page !== page || object.empty) return;
    if (hiddenLayers.has(object.layer)) return;

    const layer = layers.get(object.layer) ?? {
      name: object.layer,
      count: 0,
      length: 0,
      area: 0,
      hatchArea: 0,
      objects: [],
    };
    const measure = visibleMeasure(object, hiddenLayers);
    layer.count++;
    layer.length += measure.length;
    layer.area += measure.area;
    layer.hatchArea += measure.hatchArea;
    layer.objects.push(index);
    layers.set(object.layer, layer);

    totals.count++;
    totals.length += measure.length;
    totals.area += measure.area;
    totals.hatchArea += measure.hatchArea;

    // Only INSERTs name a block; a wall drawn as a polyline has none.
    if (!object.block) return;
    const block = blocks.get(object.block) ?? { name: object.block, count: 0, objects: [] };
    block.count++;
    block.objects.push(index);
    blocks.set(object.block, block);
  });

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    blocks: [...blocks.values()].sort(byName),
    layers: [...layers.values()].sort(byName),
    totals,
  };
}

/**
 * Totals for whatever is selected on the canvas.
 *
 * The selection can only hold objects the user can see; the share of a block
 * drawn on a layer switched off is left out, as in the tables.
 */
export function measureSelection(objects: ObjectInfo[], selection: number[], hiddenLayers: Set<string> = NONE): Totals {
  const totals: Totals = { count: 0, length: 0, area: 0, hatchArea: 0 };
  for (const index of selection) {
    const object = objects[index];
    if (!object) continue;
    const measure = visibleMeasure(object, hiddenLayers);
    totals.count++;
    totals.length += measure.length;
    totals.area += measure.area;
    totals.hatchArea += measure.hatchArea;
  }
  return totals;
}

const NONE = new Set<string>();

/**
 * What an object measures on screen: its totals, less the share drawn on
 * layers that are switched off (a block's door swing on its own layer).
 */
function visibleMeasure(object: ObjectInfo, hiddenLayers: Set<string>): Omit<Totals, 'count'> {
  const measure = { length: object.length ?? 0, area: object.area ?? 0, hatchArea: object.hatchArea ?? 0 };
  for (const [layer, part] of Object.entries(object.parts ?? {})) {
    if (!hiddenLayers.has(layer)) continue;
    measure.length -= part.length ?? 0;
    measure.area -= part.area ?? 0;
    measure.hatchArea -= part.hatchArea ?? 0;
  }
  // Subtracting floats can leave -1e-13 where the whole object is hidden
  for (const key of ['length', 'area', 'hatchArea'] as const) measure[key] = Math.max(0, measure[key]);
  return measure;
}