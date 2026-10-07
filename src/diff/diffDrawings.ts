import { computeBounds } from '../shared/bounds';
import type {
  ChangeKind,
  DiffPage,
  DrawingDiff,
  DxfEntity,
  ObjectInfo,
  ParsedDxf,
} from '../shared/types';

/**
 * Numbers are compared on a grid this fine relative to the drawing's size.
 * An absolute grid, not significant digits: re-saving leaves noise like
 * -1.42e-14 where 0 was (significant digits would call that a change), and
 * survey coordinates in the millions still need millimetres (nine significant
 * digits would not see a 1 mm move at 4,500,000 m).
 */
const RELATIVE_TOLERANCE = 1e-9;

/**
 * When more than this share of handle-matched objects differ, the handles
 * themselves are suspect — a writer that renumbers sequentially after a
 * deletion shifts every later object by one — and the page is matched by
 * content instead. Below a handful of pairs, no conclusion is drawn.
 */
const MAX_CHANGED_SHARE = 0.5;
const MIN_PAIRS_FOR_RENUMBER_CHECK = 4;

/**
 * Below this share of handles in common, handles are treated as renumbered
 * (some writers renumber every entity on save) and objects are matched by content.
 */
const MIN_SHARED_HANDLES = 0.5;

/** One object as drawn on one page. */
interface Item {
  info: ObjectInfo;
  entities: DxfEntity[];
  signature: string;
}

/**
 * Compares two parsed drawings object by object.
 *
 * Objects pair up by handle — AutoCAD keeps an entity's handle across saves —
 * so a moved door is reported as changed rather than as a removal plus an
 * addition. When the two files share too few handles, or objects have none,
 * objects are matched by their content instead; that cannot tell "changed"
 * from "removed + added", which is still a truthful picture.
 */
export function diffDrawings(before: ParsedDxf, after: ParsedDxf, oldLabel: string, newLabel: string): DrawingDiff {
  const handleMatching = handlesLineUp(before.objects, after.objects);
  const grid = gridFor([before, after]);

  const oldPages = new Map(before.pages.map((page, index) => [page.name, index]));
  const newPages = new Map(after.pages.map((page, index) => [page.name, index]));
  const names = [...after.pages.map((p) => p.name), ...before.pages.map((p) => p.name).filter((n) => !newPages.has(n))];

  const pages = names.map((name) => {
    const page = diffPage(
      name,
      itemsOf(before, oldPages.get(name), grid),
      itemsOf(after, newPages.get(name), grid),
      handleMatching
    );
    // A sheet is mostly its viewports; without them it would look empty
    const views = newPages.has(name) ? after.pages[newPages.get(name)!].viewports : undefined;
    if (views?.length) {
      page.viewports = views.map((view) => ({ rect: view.rect, entities: view.entities.map(({ obj: _obj, ...e }) => e as DxfEntity) }));
    }
    return page;
  });

  // Each side's problems once, saying which side they belong to
  const warnings = [
    ...new Set(before.warnings ?? []).values(),
  ].map((w) => `${oldLabel}: ${w}`).concat([...new Set(after.warnings ?? []).values()].map((w) => `${newLabel}: ${w}`));
  const diff: DrawingDiff = { oldLabel, newLabel, pages, handleMatching };
  if (warnings.length) diff.warnings = warnings;
  return diff;
}

function handlesLineUp(before: ObjectInfo[], after: ObjectInfo[]): boolean {
  const oldHandles = new Set(before.map((o) => o.handle).filter((h): h is string => h !== undefined));
  const newHandles = after.map((o) => o.handle).filter((h): h is string => h !== undefined);
  if (oldHandles.size === 0 || newHandles.length === 0) return false;
  const shared = newHandles.filter((h) => oldHandles.has(h)).length;
  return shared / Math.min(oldHandles.size, newHandles.length) >= MIN_SHARED_HANDLES;
}

/** The comparison grid: a billionth of the larger drawing's size, and never finer than 1e-9. */
function gridFor(drawings: ParsedDxf[]): number {
  let extent = 0;
  for (const drawing of drawings) {
    for (const page of drawing.pages) {
      const bounds = page.bounds ?? computeBounds(page.entities);
      // The drawing's size, not its distance from the origin: doubles keep about
      // 1e-9 m of precision even at survey coordinates in the millions
      if (bounds) extent = Math.max(extent, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    }
  }
  return Math.max(extent * RELATIVE_TOLERANCE, RELATIVE_TOLERANCE);
}

/**
 * The objects drawn on one page. Viewport content is left to the model page.
 * An entity that belongs to no object (an attribute whose INSERT could not be
 * found, say) becomes an object of its own, so it is still drawn and compared.
 */
function itemsOf(drawing: ParsedDxf, pageIndex: number | undefined, grid: number): Item[] {
  if (pageIndex === undefined) return [];
  const byObject = new Map<number, DxfEntity[]>();
  const items: Item[] = [];
  for (const entity of drawing.pages[pageIndex].entities) {
    if (entity.obj === undefined) {
      const info: ObjectInfo = { type: entity.type, layer: entity.layer, page: pageIndex };
      if (entity.type === 'TEXT') info.text = entity.text;
      items.push({ info, entities: [entity], signature: signatureOf(info, [entity], grid) });
      continue;
    }
    let list = byObject.get(entity.obj);
    if (!list) byObject.set(entity.obj, (list = []));
    list.push(entity);
  }
  for (const [obj, entities] of byObject) {
    const info = drawing.objects[obj];
    items.push({ info, entities, signature: signatureOf(info, entities, grid) });
  }
  return items;
}

/**
 * Everything that makes an object look or read differently. Numbers snap to
 * `grid`, and the pieces are sorted, so re-saving a block with its entities in
 * another order is not a change.
 */
export function signatureOf(info: ObjectInfo, entities: DxfEntity[], grid: number): string {
  const snap = (key: string, value: unknown) => {
    if (key === 'obj') return undefined;
    // `+ 0` turns -0 into 0, so a value that snapped from either side of zero matches
    return typeof value === 'number' ? Math.round(value / grid) + 0 : value;
  };
  const pieces = entities.map((entity) => JSON.stringify(entity, snap)).sort();
  return JSON.stringify(
    { type: info.type, layer: info.layer, block: info.block, text: info.text, attributes: info.attributes },
    snap
  ) + pieces.join('');
}

function diffPage(name: string, before: Item[], after: Item[], handleMatching: boolean): DiffPage {
  const page: DiffPage = {
    name, bounds: null, unchanged: [], added: [], removed: [], changedOld: [], changedNew: [], changes: [],
  };

  const record = (kind: ChangeKind, label: string, oldItem: Item | null, newItem: Item | null) => {
    const index = page.changes.length;
    const tag = (entities: DxfEntity[]) => entities.map((e) => ({ ...e, obj: index }));
    const drawn = [...(oldItem?.entities ?? []), ...(newItem?.entities ?? [])];
    page.changes.push({ kind, label, bounds: computeBounds(drawn) });
    if (kind === 'added') page.added.push(...tag(newItem!.entities));
    if (kind === 'removed') page.removed.push(...tag(oldItem!.entities));
    if (kind === 'changed') {
      page.changedOld.push(...tag(oldItem!.entities));
      page.changedNew.push(...tag(newItem!.entities));
    }
  };
  const keep = (item: Item) => page.unchanged.push(...item.entities.map(({ obj: _obj, ...entity }) => entity as DxfEntity));

  let oldLeft = before;
  let newLeft = after;

  const pairs = handleMatching ? pairByHandle(before, after) : null;
  if (pairs) {
    for (const [old, item] of pairs.matched) {
      if (old.signature === item.signature) keep(item);
      else record('changed', changedLabel(old.info, item.info), old, item);
    }
    oldLeft = pairs.oldLeft;
    newLeft = pairs.newLeft;
  }

  // Whatever handles did not settle is matched by content, duplicates counted
  const pool = new Map<string, Item[]>();
  for (const item of oldLeft) {
    let list = pool.get(item.signature);
    if (!list) pool.set(item.signature, (list = []));
    list.push(item);
  }
  for (const item of newLeft) {
    const twin = pool.get(item.signature)?.shift();
    if (twin) keep(item);
    else record('added', `Added · ${describe(item.info)}`, null, item);
  }
  for (const list of pool.values()) {
    for (const item of list) record('removed', `Removed · ${describe(item.info)}`, item, null);
  }

  page.bounds = computeBounds([
    ...page.unchanged, ...page.added, ...page.removed, ...page.changedOld, ...page.changedNew,
  ]);
  return page;
}

/**
 * Pairs objects with the same handle and type. Returns null when the pairing
 * looks like renumbering rather than editing — most pairs differ — so the
 * caller matches the page by content instead.
 */
function pairByHandle(
  before: Item[],
  after: Item[]
): { matched: [Item, Item][]; oldLeft: Item[]; newLeft: Item[] } | null {
  const oldByHandle = new Map(before.filter((i) => i.info.handle !== undefined).map((i) => [i.info.handle!, i]));
  const matched: [Item, Item][] = [];
  const used = new Set<Item>();
  const newLeft: Item[] = [];
  for (const item of after) {
    const old = item.info.handle !== undefined ? oldByHandle.get(item.info.handle) : undefined;
    if (old && !used.has(old) && old.info.type === item.info.type) {
      matched.push([old, item]);
      used.add(old);
    } else {
      newLeft.push(item);
    }
  }

  const differing = matched.filter(([old, item]) => old.signature !== item.signature).length;
  if (matched.length >= MIN_PAIRS_FOR_RENUMBER_CHECK && differing > matched.length * MAX_CHANGED_SHARE) return null;

  return { matched, oldLeft: before.filter((item) => !used.has(item)), newLeft };
}

function describe(info: ObjectInfo): string {
  const parts = [info.type];
  if (info.block) parts.push(info.block);
  if (info.text) parts.push(`"${shorten(info.text)}"`);
  return `${parts.join(' ')} · ${info.layer}`;
}

function changedLabel(before: ObjectInfo, after: ObjectInfo): string {
  const subject = [after.type, after.block].filter(Boolean).join(' ');
  if ((before.text ?? '') !== (after.text ?? '')) {
    return `Changed · ${subject} "${shorten(before.text ?? '')}" → "${shorten(after.text ?? '')}"`;
  }
  const oldValues = new Map((before.attributes ?? []).map((a) => [a.tag, a.value]));
  const edited = (after.attributes ?? []).find((a) => oldValues.get(a.tag) !== a.value);
  if (edited) {
    return `Changed · ${subject} · ${edited.tag} ${oldValues.get(edited.tag) ?? '(none)'} → ${edited.value}`;
  }
  if (before.layer !== after.layer) return `Changed · ${subject} · layer ${before.layer} → ${after.layer}`;
  return `Changed · ${subject} · ${after.layer}`;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

