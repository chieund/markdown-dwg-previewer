import * as path from 'path';
import { computeBounds } from '../shared/bounds';
import { takeOff } from '../shared/takeoff';
import type { Bounds, DrawingKey, DxfEntity, Point2D, ShowRequest, SnapshotRequest, TextEntity } from '../shared/types';
import { pathLength, polygonArea } from '../dxf/measure';
import { enclosuresAt, gapBetween, segmentsOf } from './measure';
import { fold, indexOf, type DrawingIndex } from './drawingIndex';
import type { DrawingStore, StoredDrawing } from './drawingStore';

export type { ShowRequest, SnapshotRequest };

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

export interface PreviewControl {
  /** Summary of what was done. */
  show(path: string, key: DrawingKey, req: ShowRequest): Promise<string>;
  /** Base64 PNG. */
  snapshot(path: string, key: DrawingKey, req: SnapshotRequest): Promise<string>;
}

export interface ToolHost {
  store: DrawingStore;
  /** Resolves to the real path, or rejects when the user has not allowed reading it. */
  checkAccess(path: string): Promise<string>;
  preview?: PreviewControl;
}

/** Text output is cut to this many characters; totals stay exact. */
export const MAX_OUTPUT_CHARS = 100_000;

const UNIT_NAMES: Record<number, string> = {
  1: 'inch', 2: 'foot', 3: 'mile', 4: 'millimetre', 5: 'centimetre', 6: 'metre', 7: 'kilometre',
  8: 'microinch', 9: 'mil', 10: 'yard', 11: 'angstrom', 12: 'nanometre', 13: 'micron', 14: 'decimetre',
  15: 'decametre', 16: 'hectometre', 17: 'gigametre', 18: 'astronomical unit', 19: 'light year', 20: 'parsec',
  21: 'US survey foot', 22: 'US survey inch', 23: 'US survey yard', 24: 'US survey mile',
};
const UNITS_NOT_DECLARED = 'NOT DECLARED';

const round = (v: number) => Math.round(v * 1000) / 1000;
const center = (b: Bounds) => ({ x: round((b.minX + b.maxX) / 2), y: round((b.minY + b.maxY) / 2) });
const box = (b: Bounds) => ({ minX: round(b.minX), minY: round(b.minY), maxX: round(b.maxX), maxY: round(b.maxY) });

const PATH_ARG = { type: 'string', description: 'Absolute path of the .dwg or .dxf file' };
const PAGE_ARG = { description: 'Page index (0 = Model Space) or page name; omit for all pages' };

export const TOOL_DEFINITIONS: { name: string; description: string; inputSchema: object }[] = [
  {
    name: 'dwg_overview',
    description:
      'Start here. Summary of a DWG/DXF drawing: declared units, pages (model space, layouts) with extents and main extents (ignoring stray objects far away), layers, object types, block counts, title-block attributes from paper-space pages, entity types this reader cannot draw, and the longest notes (design notes often state spans, loads, pile sizes). Numbers in a drawing are in its units, never converted. If units are "NOT DECLARED", say so instead of assuming; infer a unit only with stated reasoning.',
    inputSchema: { type: 'object', properties: { path: PATH_ARG }, required: ['path'] },
  },
  {
    name: 'dwg_find_text',
    description:
      'Find text in the drawing: TEXT/MTEXT labels, dimension values, block names and attribute values. Search is case- and accent-insensitive ("coc" matches "cọc"). Each match has its id, layer, page, center and size in drawing units, what it sits "inside" (frames, big blocks) and the "nearby" objects, nearest first (to tell what a label refers to). Omit query to list all text. To count blocks or total lengths and areas use dwg_quantities, which is exact. When "truncated" is true, not all matches are returned: narrow the query or use page/layer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        query: { type: 'string' },
        page: PAGE_ARG,
        layer: { type: 'string' },
        limit: { type: 'number', description: 'Max matches returned (default 30, at most 200)' },
        nearby: { type: 'number', description: 'Nearest objects listed per match (default 5)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'dwg_dimensions',
    description:
      'Dimension lines placed by the drafter, with the value they display (the drafted text, exactly as drawn), how often each value occurs (valueCounts), the measured number when stored (measurement, separate from the text), position and orientation. A dimension with no drafted text has no value and is counted under noText; one with no stored text position has no center and never matches a near filter. Includes dimensions inside blocks. Filter by page, layer, or a circle around a point. These are the authoritative sizes in the drawing; take numbers from here, not from pictures or guesses.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        page: PAGE_ARG,
        layer: { type: 'string' },
        near: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, radius: { type: 'number' } },
          required: ['x', 'y', 'radius'],
        },
        limit: { type: 'number', description: 'Max dimensions listed (default 50, at most 300)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'dwg_quantities',
    description:
      'Count and measure what is drawn, the way an estimator takes off quantities. Use this for "how many doors / columns / piles" and "how much wall" instead of counting search results. Per page: every block with how many times it is inserted (with object ids to highlight), and per layer the object count, total length of linework, enclosed area of closed shapes and hatched area, in drawing units. Narrow it with block (part of a block name), layer, or a region. With block given, the attribute values of the matching blocks are counted too (door types, tags). Counts are exact for what is drawn: a door drawn as loose lines instead of a block is not a block here. Lengths and areas are as drawn, not converted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        page: PAGE_ARG,
        block: { type: 'string', description: 'Only blocks whose name contains this (case- and accent-insensitive)' },
        layer: { type: 'string', description: 'Only objects on this layer' },
        region: {
          type: 'object',
          description: 'Only objects whose centre is in this box, in drawing coordinates',
          properties: { minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } },
          required: ['minX', 'minY', 'maxX', 'maxY'],
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'dwg_measure',
    description:
      'Measure geometry as drawn, in drawing units, when no dimension line gives the answer. Give any of: objects (ids) for each one\'s length, enclosed area, width, height and centre; distance {from, to}, each an object id or a point {x, y}, for the shortest gap between their linework (0 when they touch) and the centre-to-centre distance; points [{x, y}, …] for the length of the path through them and the area it encloses; at {x, y} for the closed shapes drawn around that point, smallest first (a room boundary around its label). A drafted dimension from dwg_dimensions outranks a measurement: drawings are not always to scale, so say which one a number came from.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        objects: { type: 'array', items: { type: 'number' }, description: 'Object ids to measure (at most 100)' },
        distance: {
          type: 'object',
          properties: {
            from: { description: 'Object id, or a point {x, y}' },
            to: { description: 'Object id, or a point {x, y}' },
          },
          required: ['from', 'to'],
        },
        points: {
          type: 'array',
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
          description: 'Corners of a path or outline, in order',
        },
        at: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'A point; lists the closed shapes around it',
        },
        page: { description: 'Page of the at point: index or name (default 0, Model Space)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'dwg_show',
    description:
      'Show things in the VS Code preview for the user: highlight objects by id, switch page or layers, fit the view. Use it to point at what you are talking about.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        objects: { type: 'array', items: { type: 'number' }, description: 'Object ids to highlight' },
        page: PAGE_ARG,
        layers: {
          type: 'object',
          properties: {
            show: { type: 'array', items: { type: 'string' } },
            hide: { type: 'array', items: { type: 'string' } },
            only: { type: 'array', items: { type: 'string' } },
          },
        },
        fit: { type: 'boolean', description: 'Clear the highlight and fit the whole page in the view' },
      },
      required: ['path'],
    },
  },
  {
    name: 'dwg_snapshot',
    description:
      'Render a PNG of part of the drawing to look at it like an engineer would: the whole page, a region in drawing coordinates, or the area around an object id from another tool. Use it to understand layout; take numbers from the other tools, not from the picture.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        page: PAGE_ARG,
        region: {
          type: 'object',
          properties: { minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } },
        },
        around: { type: 'number', description: 'Object id to centre on' },
        margin: { type: 'number', description: 'Drawing units around the object (default 1.5× its size)' },
      },
      required: ['path'],
    },
  },
];

type Args = Record<string, unknown>;

const text = (value: unknown): ToolContent[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }];

function unitsOf(units: number | undefined): string {
  if (!units) return UNITS_NOT_DECLARED;
  return UNIT_NAMES[units] ?? `unit code ${units} (not recognised)`;
}

function pageIndex(stored: StoredDrawing, page: unknown): number | undefined {
  if (page === undefined || page === null || page === '') return undefined;
  const pages = stored.parsed.pages;
  if (typeof page === 'number') {
    if (!Number.isInteger(page) || page < 0 || page >= pages.length) {
      throw new Error(`No page ${page}. Pages: ${pages.map((p, i) => `${i} ${p.name}`).join(', ')}`);
    }
    return page;
  }
  if (typeof page === 'string' && /^\d+$/.test(page.trim())) return pageIndex(stored, Number(page));
  const i = pages.findIndex((p) => fold(p.name) === fold(String(page)));
  if (i < 0) throw new Error(`No page "${page}". Pages: ${pages.map((p) => p.name).join(', ')}`);
  return i;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return v === undefined || v === null ? undefined : String(v);
}

function num(args: Args, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(Math.floor(v), max));
}

/** The longest prefix of `items` whose JSON, with the rest of `result`, fits the cap. */
function fitList<T>(items: T[], render: (kept: T[]) => string): { kept: T[]; json: string } {
  let json = render(items);
  if (json.length <= MAX_OUTPUT_CHARS) return { kept: items, json };
  let lo = 0;
  let hi = items.length; // hi does not fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (render(items.slice(0, mid)).length <= MAX_OUTPUT_CHARS) lo = mid;
    else hi = mid;
  }
  json = render(items.slice(0, lo));
  return { kept: items.slice(0, lo), json };
}

function describe(stored: StoredDrawing, index: DrawingIndex, id: number): Record<string, unknown> {
  const o = stored.parsed.objects[id];
  const b = index.bounds(id);
  const out: Record<string, unknown> = { id, type: o.type, layer: o.layer, page: stored.parsed.pages[o.page]?.name };
  if (o.block) out.block = o.block;
  if (o.text) out.text = o.text;
  if (o.attributes?.length) out.attributes = Object.fromEntries(o.attributes.map((a) => [a.tag, a.value]));
  if (b) {
    out.center = center(b);
    out.size = { width: round(b.maxX - b.minX), height: round(b.maxY - b.minY) };
  }
  return out;
}

/**
 * A TEXT/MTEXT drawn inside a block. `ObjectInfo` only describes the INSERT,
 * so without this its label would be invisible to `dwg_find_text`; the id is
 * the INSERT, which is also what `dwg_show` can highlight.
 */
function describeNestedText(stored: StoredDrawing, ownerId: number, page: number, entity: TextEntity): Record<string, unknown> {
  const owner = stored.parsed.objects[ownerId];
  const out: Record<string, unknown> = {
    id: ownerId,
    type: entity.type,
    layer: entity.layer,
    page: stored.parsed.pages[page]?.name,
    text: entity.text,
    inBlock: true,
  };
  if (owner.block) out.block = owner.block;
  const b = computeBounds([entity]);
  if (b) {
    out.center = center(b);
    out.size = { width: round(b.maxX - b.minX), height: round(b.maxY - b.minY) };
  }
  return out;
}

function overview(stored: StoredDrawing, file: string): ToolContent[] {
  const { parsed } = stored;
  const index = indexOf(stored);
  const types = new Map<string, number>();
  const blocks = new Map<string, number>();
  const layers = new Map<string, number>();
  const perPage = parsed.pages.map(() => 0);
  const titleBlocks: Record<string, unknown>[] = [];
  parsed.objects.forEach((o, id) => {
    if (o.empty) return;
    types.set(o.type, (types.get(o.type) ?? 0) + 1);
    layers.set(o.layer, (layers.get(o.layer) ?? 0) + 1);
    if (o.block) blocks.set(o.block, (blocks.get(o.block) ?? 0) + 1);
    perPage[o.page] = (perPage[o.page] ?? 0) + 1;
    if (o.page > 0 && o.type === 'INSERT' && o.attributes?.length && titleBlocks.length < 20) {
      titleBlocks.push({
        id,
        page: parsed.pages[o.page]?.name,
        block: o.block,
        attributes: Object.fromEntries(o.attributes.map((a) => [a.tag, a.value])),
      });
    }
  });
  const sorted = (m: Map<string, number>, n: number) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n));
  const NOTE_CHARS = 5000;
  // Long notes are where an engineer finds the design basis: span, loads, piles
  const longNotes = parsed.objects
    .map((o, id) => ({ o, id }))
    .filter(({ o }) => o.text && o.text.length > 120)
    .sort((a, b) => b.o.text!.length - a.o.text!.length)
    .slice(0, 5)
    .map(({ o, id }) => ({
      id,
      layer: o.layer,
      page: parsed.pages[o.page]?.name,
      text: o.text!.length > NOTE_CHARS ? o.text!.slice(0, NOTE_CHARS) : o.text,
      ...(o.text!.length > NOTE_CHARS ? { truncated: true, totalChars: o.text!.length } : {}),
    }));
  const units = unitsOf(parsed.units);
  const layerList = Object.entries(sorted(layers, 80));
  const blockList = Object.entries(sorted(blocks, 40));
  const render = (keep: number) => {
    const cut = (n: number) => Math.max(0, Math.floor(n * keep));
    const l = layerList.slice(0, cut(layerList.length));
    const bl = blockList.slice(0, cut(blockList.length));
    const tb = titleBlocks.slice(0, cut(titleBlocks.length));
    const notes = longNotes.slice(0, cut(longNotes.length));
    const truncated = l.length < layerList.length || bl.length < blockList.length || tb.length < titleBlocks.length || notes.length < longNotes.length;
    return JSON.stringify(
      {
        file: path.basename(file),
        units,
        ...(units === UNITS_NOT_DECLARED
          ? { unitsNote: 'The drawing does not declare ($INSUNITS missing or 0). Do not assume a unit; infer only with stated reasoning.' }
          : {}),
        ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}),
        ...(truncated ? { truncated: true } : {}),
        totalObjects: parsed.objects.reduce((n, o) => n + (o.empty ? 0 : 1), 0),
        totalLayers: layers.size,
        totalBlocks: blocks.size,
        pages: parsed.pages.map((p, i) => ({
          index: i,
          name: p.name,
          objects: perPage[i],
          extents: p.bounds ? box(p.bounds) : null,
          mainExtents: index.mainExtents(i) ? box(index.mainExtents(i)!) : null,
          viewports: p.viewports?.length ?? 0,
        })),
        objectTypes: sorted(types, 30),
        layers: Object.fromEntries(l),
        blocks: Object.fromEntries(bl),
        titleBlockAttributes: tb,
        notSupportedEntityTypes: parsed.skippedEntityTypes,
        longNotes: notes,
      },
      null,
      1
    );
  };
  // Shrink the long lists together until the whole fits
  let keep = 1;
  let json = render(keep);
  while (json.length > MAX_OUTPUT_CHARS && keep > 0) {
    keep = keep > 0.01 ? keep / 2 : 0;
    json = render(keep);
  }
  return [{ type: 'text', text: json }];
}

/** Objects whose drawn text is listed as theirs: a block's labels, a table's cells. */
const TEXT_OWNERS = new Set(['INSERT', 'ACAD_TABLE']);

type TextHit =
  | { kind: 'object'; id: number }
  | { kind: 'nested'; owner: number; page: number; entity: TextEntity };

function findText(stored: StoredDrawing, args: Args): ToolContent[] {
  const index = indexOf(stored);
  const page = pageIndex(stored, args.page);
  const query = str(args, 'query');
  const q = query ? fold(query) : '';
  const layer = str(args, 'layer');
  const limit = num(args, 'limit', 30, 200);
  const nearby = num(args, 'nearby', 5, 30);
  const hits: TextHit[] = [];
  let total = 0;
  const want = (text: string, textPage: number, textLayer: string): boolean => {
    if (page !== undefined && textPage !== page) return false;
    if (layer && fold(textLayer) !== fold(layer)) return false;
    return !q || fold(text).includes(q);
  };
  stored.parsed.objects.forEach((o, i) => {
    if (o.empty) return;
    const haystack = [o.text ?? '', o.block ?? '', ...(o.attributes ?? []).map((a) => `${a.tag} ${a.value}`)].join(' ');
    if (!haystack.trim() || !want(haystack, o.page, o.layer)) return;
    total++;
    if (hits.length < limit) hits.push({ kind: 'object', id: i });
  });
  // Text inside a block is drawn on the page but only the INSERT is an object.
  // Scan those entities too, or a door/window label inside its block is lost.
  stored.parsed.pages.forEach((p, pageIndex) => {
    for (const entity of p.entities) {
      if (entity.type !== 'TEXT' || !entity.text || entity.obj === undefined) continue;
      const owner = stored.parsed.objects[entity.obj];
      if (!owner || !TEXT_OWNERS.has(owner.type) || owner.empty) continue;
      // A drawn ATTRIB is text of its INSERT too, but the INSERT's own match already lists it
      if (owner.attributes?.some((a) => !a.hidden && a.value === entity.text)) continue;
      if (!want(entity.text, pageIndex, entity.layer)) continue;
      total++;
      if (hits.length < limit) hits.push({ kind: 'nested', owner: entity.obj, page: pageIndex, entity });
    }
  });
  // Surroundings are the costly part: stop computing once the output cap is reached
  const matches: Record<string, unknown>[] = [];
  let size = 0;
  for (const hit of hits) {
    const m =
      hit.kind === 'object'
        ? { ...describe(stored, index, hit.id), ...index.surroundings(hit.id, nearby) }
        : { ...describeNestedText(stored, hit.owner, hit.page, hit.entity), ...index.surroundings(hit.owner, nearby) };
    matches.push(m);
    size += JSON.stringify(m, null, 1).length;
    if (size > MAX_OUTPUT_CHARS) break;
  }
  const render = (kept: unknown[]) =>
    JSON.stringify(
      {
        query: query ?? null,
        totalMatches: total,
        returned: kept.length,
        truncated: kept.length < total,
        ...(stored.parsed.warnings?.length ? { warnings: stored.parsed.warnings } : {}),
        matches: kept,
      },
      null,
      1
    );
  return [{ type: 'text', text: fitList(matches, render).json }];
}

function dimensions(stored: StoredDrawing, args: Args): ToolContent[] {
  const { parsed } = stored;
  const index = indexOf(stored);
  const page = pageIndex(stored, args.page);
  const layer = str(args, 'layer');
  const near = args.near as { x: number; y: number; radius: number } | undefined;
  if (near && ![near.x, near.y, near.radius].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('near needs numeric x, y and radius');
  }
  const rows: Record<string, unknown>[] = [];
  const counts = new Map<string, number>();
  let noText = 0;
  for (const d of parsed.dimensions ?? []) {
    const o = parsed.objects[d.obj];
    if (!o || o.empty) continue;
    if (page !== undefined && o.page !== page) continue;
    if (layer && fold(d.layer) !== fold(layer)) continue;
    // Only the stored text position places a dimension; a geometry box would be a guess
    const c = d.position ? { x: round(d.position.x), y: round(d.position.y) } : undefined;
    if (near && (!c || Math.hypot(c.x - near.x, c.y - near.y) > near.radius)) continue;
    const row: Record<string, unknown> = { id: d.obj, layer: d.layer, page: parsed.pages[o.page]?.name };
    if (d.text) {
      row.value = d.text;
      counts.set(d.text, (counts.get(d.text) ?? 0) + 1);
    } else {
      noText++;
    }
    if (d.measurement !== undefined) row.measurement = round(d.measurement);
    if (c) row.center = c;
    if (o.type === 'DIMENSION') {
      const b = index.bounds(d.obj);
      if (b) row.orientation = b.maxX - b.minX >= b.maxY - b.minY ? 'horizontal' : 'vertical';
    }
    if (o.type === 'INSERT') row.inBlock = o.block;
    rows.push(row);
  }
  const limit = num(args, 'limit', 50, 300);
  const valueCounts = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 200));
  const render = (kept: unknown[]) =>
    JSON.stringify(
      {
        total: rows.length,
        returned: kept.length,
        truncated: kept.length < rows.length,
        ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}),
        noText,
        valueCounts,
        dimensions: kept,
      },
      null,
      1
    );
  return [{ type: 'text', text: fitList(rows.slice(0, limit), render).json }];
}

const unitsBlock = (units: number | undefined) => {
  const name = unitsOf(units);
  return {
    units: name,
    ...(name === UNITS_NOT_DECLARED
      ? { unitsNote: 'The drawing does not declare ($INSUNITS missing or 0). Do not assume a unit; infer only with stated reasoning.' }
      : {}),
  };
};

function regionArg(v: unknown): Bounds | undefined {
  if (v === undefined || v === null) return undefined;
  const r = v as Bounds;
  if (!(['minX', 'minY', 'maxX', 'maxY'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
    throw new Error('region needs numeric minX, minY, maxX, maxY');
  }
  return { minX: Math.min(r.minX, r.maxX), minY: Math.min(r.minY, r.maxY), maxX: Math.max(r.minX, r.maxX), maxY: Math.max(r.minY, r.maxY) };
}

/** Ids listed per block row; the count stays exact. */
const IDS_PER_ROW = 50;
const VALUES_PER_TAG = 30;
const TAGS_PER_PAGE = 40;
const VALUE_CHARS = 80;

function quantities(stored: StoredDrawing, args: Args): ToolContent[] {
  const { parsed } = stored;
  const index = indexOf(stored);
  const onlyPage = pageIndex(stored, args.page);
  const block = str(args, 'block');
  const blockQuery = block ? fold(block) : undefined;
  const layer = str(args, 'layer');
  const layerQuery = layer ? fold(layer) : undefined;
  const region = regionArg(args.region);
  // Folding is per distinct name: a drawing has millions of objects and a few hundred names
  const verdicts = new Map<string, boolean>();
  const once = (key: string, test: () => boolean): boolean => {
    let v = verdicts.get(key);
    if (v === undefined) verdicts.set(key, (v = test()));
    return v;
  };
  const include = (o: (typeof parsed.objects)[number], id: number): boolean => {
    if (layerQuery !== undefined && !once(`L${o.layer}`, () => fold(o.layer) === layerQuery)) return false;
    if (blockQuery !== undefined && !(o.block && once(`B${o.block}`, () => fold(o.block!).includes(blockQuery)))) return false;
    if (region) {
      const b = index.bounds(id);
      if (!b) return false;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      if (cx < region.minX || cx > region.maxX || cy < region.minY || cy > region.maxY) return false;
    }
    return true;
  };
  const none = new Set<string>();
  const measures = (m: { length: number; area: number; hatchArea: number }) => ({
    ...(m.length ? { length: round(m.length) } : {}),
    ...(m.area ? { area: round(m.area) } : {}),
    ...(m.hatchArea ? { hatchArea: round(m.hatchArea) } : {}),
  });
  const pages: Record<string, unknown>[] = [];
  parsed.pages.forEach((p, i) => {
    if (onlyPage !== undefined && i !== onlyPage) return;
    const t = takeOff(parsed.objects, i, none, include);
    if (t.totals.count === 0 && onlyPage === undefined) return;
    // Anonymous blocks (`*U12`) are the file's own bookkeeping names: after the named ones
    const anonymous = (name: string) => (name.startsWith('*') ? 1 : 0);
    const blocks = t.blocks
      .sort((a, b) => anonymous(a.name) - anonymous(b.name) || b.count - a.count || a.name.localeCompare(b.name))
      .map((row) => ({
        block: row.name,
        count: row.count,
        ids: row.objects.slice(0, IDS_PER_ROW),
        ...(row.objects.length > IDS_PER_ROW ? { idsTruncated: true } : {}),
      }));
    const out: Record<string, unknown> = {
      page: p.name,
      index: i,
      totals: { objects: t.totals.count, ...measures(t.totals) },
      blocks,
      // With a block filter the layer rows would only repeat the blocks
      ...(blockQuery === undefined
        ? {
            layers: t.layers
              .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
              .map((row) => ({ layer: row.name, objects: row.count, ...measures(row) })),
          }
        : {}),
    };
    if (blockQuery !== undefined) {
      // What the matching blocks say about themselves: door type, mark, size
      const tags = new Map<string, Map<string, number>>();
      for (const row of t.blocks) {
        for (const id of row.objects) {
          for (const a of parsed.objects[id].attributes ?? []) {
            if (!a.value) continue;
            const value = a.value.length > VALUE_CHARS ? `${a.value.slice(0, VALUE_CHARS)}…` : a.value;
            const values = tags.get(a.tag) ?? new Map<string, number>();
            values.set(value, (values.get(value) ?? 0) + 1);
            tags.set(a.tag, values);
          }
        }
      }
      if (tags.size) {
        out.attributeValues = Object.fromEntries(
          [...tags].slice(0, TAGS_PER_PAGE).map(([tag, values]) => [
            tag,
            Object.fromEntries([...values].sort((a, b) => b[1] - a[1]).slice(0, VALUES_PER_TAG)),
          ])
        );
      }
    }
    pages.push(out);
  });
  const filter = {
    ...(block ? { block } : {}),
    ...(layer ? { layer } : {}),
    ...(region ? { region: box(region) } : {}),
  };
  const render = (keep: number) => {
    let truncated = false;
    const cut = <T,>(list: T[]): T[] => {
      const n = Math.max(0, Math.ceil(list.length * keep));
      if (n < list.length) truncated = true;
      return list.slice(0, n);
    };
    const shown = pages.map((pg) => ({
      ...pg,
      blocks: cut(pg.blocks as unknown[]),
      ...(pg.layers ? { layers: cut(pg.layers as unknown[]) } : {}),
    }));
    return JSON.stringify(
      {
        ...unitsBlock(parsed.units),
        ...(Object.keys(filter).length ? { filter } : {}),
        ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}),
        ...(truncated ? { truncated: true, note: 'Lists are cut, most frequent first; totals are exact. Narrow with page, block or layer.' } : {}),
        pages: shown,
      },
      null,
      1
    );
  };
  let keep = 1;
  let json = render(keep);
  while (json.length > MAX_OUTPUT_CHARS && keep > 0) {
    keep = keep > 0.01 ? keep / 2 : 0;
    json = render(keep);
  }
  return [{ type: 'text', text: json }];
}

const MAX_MEASURED = 100;

function pointArg(v: unknown, what: string): Point2D {
  const p = v as Point2D;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new Error(`${what} needs numeric x and y`);
  }
  return { x: p.x, y: p.y };
}

const pt = (p: Point2D) => ({ x: round(p.x), y: round(p.y) });

/** The entities drawn for one object, with the page they are on. */
function entitiesOfObject(stored: StoredDrawing, id: number): { page: number; entities: DxfEntity[] } {
  const o = stored.parsed.objects[id];
  if (!Number.isInteger(id) || !o) throw new Error(`No object ${id}`);
  const entities = (stored.parsed.pages[o.page]?.entities ?? []).filter((e) => e.obj === id);
  if (o.empty || entities.length === 0) throw new Error(`Object ${id} has no geometry`);
  return { page: o.page, entities };
}

function measure(stored: StoredDrawing, args: Args): ToolContent[] {
  const { parsed } = stored;
  const index = indexOf(stored);
  const out: Record<string, unknown> = { ...unitsBlock(parsed.units) };
  let asked = false;

  const ids = numberList(args.objects) && [...new Set(numberList(args.objects))];
  if (ids?.length) {
    asked = true;
    if (ids.length > MAX_MEASURED) throw new Error(`At most ${MAX_MEASURED} objects per call`);
    const totals = { length: 0, area: 0, hatchArea: 0 };
    out.objects = ids.map((id) => {
      const o = parsed.objects[id];
      if (!o) throw new Error(`No object ${id}`);
      const b = index.bounds(id);
      totals.length += o.length ?? 0;
      totals.area += o.area ?? 0;
      totals.hatchArea += o.hatchArea ?? 0;
      return {
        id,
        type: o.type,
        layer: o.layer,
        page: parsed.pages[o.page]?.name,
        ...(o.block ? { block: o.block } : {}),
        ...(o.length ? { length: round(o.length) } : {}),
        ...(o.area ? { area: round(o.area) } : {}),
        ...(o.hatchArea ? { hatchArea: round(o.hatchArea) } : {}),
        ...(b ? { width: round(b.maxX - b.minX), height: round(b.maxY - b.minY), center: center(b) } : { noGeometry: true }),
      };
    });
    if (ids.length > 1) {
      out.totals = { objects: ids.length, length: round(totals.length), area: round(totals.area), hatchArea: round(totals.hatchArea) };
    }
  }

  if (args.distance !== undefined && args.distance !== null) {
    asked = true;
    const d = args.distance as { from?: unknown; to?: unknown };
    const end = (v: unknown, what: string) => {
      if (typeof v === 'number') {
        const { page, entities } = entitiesOfObject(stored, v);
        const b = index.bounds(v);
        if (!b) throw new Error(`Object ${v} has no geometry`);
        return { page, segments: segmentsOf(entities), centre: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, label: { object: v } };
      }
      const p = pointArg(v, `distance.${what}`);
      return { page: undefined, segments: [{ a: p, b: p }], centre: p, label: { point: pt(p) } };
    };
    const from = end(d.from, 'from');
    const to = end(d.to, 'to');
    if (from.page !== undefined && to.page !== undefined && from.page !== to.page) {
      throw new Error(
        `Objects are on different pages (${parsed.pages[from.page]?.name} and ${parsed.pages[to.page]?.name}); a distance between them means nothing`
      );
    }
    const gap = gapBetween(from.segments, to.segments);
    if (!gap) throw new Error('Nothing to measure between');
    out.distance = {
      from: from.label,
      to: to.label,
      gap: round(gap.distance),
      gapFrom: pt(gap.from),
      gapTo: pt(gap.to),
      dx: round(Math.abs(gap.to.x - gap.from.x)),
      dy: round(Math.abs(gap.to.y - gap.from.y)),
      centerToCenter: round(Math.hypot(to.centre.x - from.centre.x, to.centre.y - from.centre.y)),
      centerDx: round(Math.abs(to.centre.x - from.centre.x)),
      centerDy: round(Math.abs(to.centre.y - from.centre.y)),
      ...(gap.approximate ? { approximate: true } : {}),
    };
  }

  if (args.points !== undefined && args.points !== null) {
    asked = true;
    if (!Array.isArray(args.points) || args.points.length < 2) throw new Error('points needs at least two points');
    if (args.points.length > 10_000) throw new Error('At most 10000 points per call');
    const points = args.points.map((p, i) => pointArg(p, `points[${i}]`));
    out.path = {
      points: points.length,
      length: round(pathLength(points, false)),
      ...(points.length > 2 ? { closedLength: round(pathLength(points, true)), area: round(polygonArea(points)) } : {}),
    };
  }

  if (args.at !== undefined && args.at !== null) {
    asked = true;
    const at = pointArg(args.at, 'at');
    const page = pageIndex(stored, args.page) ?? 0;
    const shapes = enclosuresAt(parsed.pages[page]?.entities ?? [], at, 10);
    out.at = pt(at);
    out.page = parsed.pages[page]?.name;
    out.enclosing = shapes.map((s) => {
      const o = parsed.objects[s.obj];
      return {
        id: s.obj,
        type: o?.type,
        layer: s.layer,
        ...(o?.block ? { block: o.block } : {}),
        shape: s.kind,
        area: round(s.area),
        width: round(s.width),
        height: round(s.height),
      };
    });
    if (shapes.length === 0) {
      out.enclosingNote =
        'No closed polyline, circle or hatch is drawn around this point. A room outlined with separate lines is not a closed shape: measure it with points or distance instead.';
    }
  }

  if (!asked) throw new Error('Give at least one of: objects, distance, points, at');
  return text(out);
}

function numberList(v: unknown): number[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && n >= 0)) throw new Error('objects must be a list of object ids');
  return v as number[];
}

function nameList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) throw new Error('layer lists must be lists of layer names');
  return v as string[];
}

function requirePreview(host: ToolHost): PreviewControl {
  if (!host.preview) {
    throw new Error('This needs the DWG Previewer panel: open VS Code with the DWG Previewer extension to use dwg_show and dwg_snapshot.');
  }
  return host.preview;
}

export interface ToolResult {
  content: ToolContent[];
  /** Set when the call failed; the text then starts with "Error:". */
  isError?: true;
}

/** The tool's MCP result: a failure is `isError: true`, so the agent can tell it from data. */
export async function callToolResult(host: ToolHost, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return { content: await runTool(host, name, args) };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

/** The result's content alone; failures come back as an "Error: …" text. */
export async function callTool(host: ToolHost, name: string, args: Record<string, unknown>): Promise<ToolContent[]> {
  return (await callToolResult(host, name, args)).content;
}

async function runTool(host: ToolHost, name: string, args: Record<string, unknown>): Promise<ToolContent[]> {
  {
    if (!TOOL_DEFINITIONS.some((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
    const given = args?.path;
    if (typeof given !== 'string' || !given) throw new Error('path is required: the absolute path of the .dwg or .dxf file');
    const real = await host.checkAccess(given);
    const stored = await host.store.get(real, { persist: true });
    switch (name) {
      case 'dwg_overview':
        return overview(stored, real);
      case 'dwg_find_text':
        return findText(stored, args);
      case 'dwg_dimensions':
        return dimensions(stored, args);
      case 'dwg_quantities':
        return quantities(stored, args);
      case 'dwg_measure':
        return measure(stored, args);
      case 'dwg_show': {
        const preview = requirePreview(host);
        const layers = args.layers as Record<string, unknown> | undefined;
        const req: ShowRequest = {
          objects: numberList(args.objects),
          page: pageIndex(stored, args.page),
          layers: layers && { show: nameList(layers.show), hide: nameList(layers.hide), only: nameList(layers.only) },
          fit: typeof args.fit === 'boolean' ? args.fit : undefined,
        };
        return [{ type: 'text', text: await preview.show(real, stored.key, req) }];
      }
      case 'dwg_snapshot': {
        const preview = requirePreview(host);
        const index = indexOf(stored);
        const around = typeof args.around === 'number' ? args.around : undefined;
        let page = pageIndex(stored, args.page) ?? 0;
        if (around !== undefined) {
          const o = stored.parsed.objects[around];
          if (!o || !index.bounds(around)) throw new Error(`Object ${around} has no geometry`);
          page = o.page;
        }
        const r = args.region as Bounds | undefined;
        if (r && !(['minX', 'minY', 'maxX', 'maxY'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
          throw new Error('region needs numeric minX, minY, maxX, maxY');
        }
        const req: SnapshotRequest = {
          page,
          region: r,
          around,
          margin: typeof args.margin === 'number' ? args.margin : undefined,
        };
        return [{ type: 'image', data: await preview.snapshot(real, stored.key, req), mimeType: 'image/png' }];
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }
}
