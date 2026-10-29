import { computeBounds } from '../shared/bounds';
import type { Bounds, DxfEntity } from '../shared/types';
import type { ParsedDxf } from '../shared/types';
import type { StoredDrawing } from './drawingStore';

export interface Brief {
  id: number;
  type: string;
  layer: string;
  block?: string;
  text?: string;
  distance?: number;
}

/** Case- and accent-insensitive form, so "coc" finds "cọc" and "dam" finds "Dầm". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** Insert into a short ascending list, dropping the worst past `max`; ties keep the earlier object. */
function insertSorted<T>(list: T[], item: T, max: number, key: (t: T) => number): void {
  let k = list.length;
  while (k > 0 && key(list[k - 1]) > key(item)) k--;
  list.splice(k, 0, item);
  if (list.length > max) list.pop();
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Where each object is, computed once per parsed drawing. */
export class DrawingIndex {
  private readonly boxes = new Map<number, Bounds>();
  private readonly main = new Map<number, Bounds | null>();

  constructor(private readonly parsed: ParsedDxf) {
    const pieces = new Map<number, DxfEntity[]>();
    for (const page of parsed.pages) {
      for (const e of page.entities) {
        if (e.obj === undefined) continue;
        const list = pieces.get(e.obj);
        if (list) list.push(e);
        else pieces.set(e.obj, [e]);
      }
    }
    for (const [obj, list] of pieces) {
      const b = computeBounds(list);
      if (b) this.boxes.set(obj, b);
    }
  }

  bounds(id: number): Bounds | undefined {
    return this.boxes.get(id);
  }

  /**
   * Extents of the middle 98% of objects. A stray point a kilometre off makes
   * the true extents useless: the sheet shrinks to a speck.
   */
  mainExtents(page: number): Bounds | null {
    if (this.main.has(page)) return this.main.get(page)!;
    const boxes: Bounds[] = [];
    this.parsed.objects.forEach((o, i) => {
      const b = this.boxes.get(i);
      if (o.page === page && b) boxes.push(b);
    });
    let out: Bounds | null = null;
    if (boxes.length === 0) {
      out = this.parsed.pages[page]?.bounds ?? null;
    } else {
      const cx = boxes.map((b) => (b.minX + b.maxX) / 2);
      const cy = boxes.map((b) => (b.minY + b.maxY) / 2);
      const pick = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(q * v.length))];
      const loX = pick(cx, 0.01), hiX = pick(cx, 0.99), loY = pick(cy, 0.01), hiY = pick(cy, 0.99);
      boxes.forEach((b, k) => {
        if (cx[k] < loX || cx[k] > hiX || cy[k] < loY || cy[k] > hiY) return;
        out = out
          ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) }
          : { ...b };
      });
    }
    this.main.set(page, out);
    return out;
  }

  /**
   * What a label sits in and what it sits next to. Frames and big blocks
   * contain the label and would crowd out the pile or beam it names, so they
   * are listed apart as "inside", smallest first.
   */
  surroundings(id: number, count: number): { inside: Brief[]; nearby: Brief[] } {
    const self = this.boxes.get(id);
    const me = this.parsed.objects[id];
    if (!self || !me) return { inside: [], nearby: [] };
    const cx = (self.minX + self.maxX) / 2;
    const cy = (self.minY + self.maxY) / 2;
    const selfSize = Math.max(self.maxX - self.minX, self.maxY - self.minY, 1e-9);
    // Bounded insertion: millions of objects must not allocate or sort per match
    const inside: { i: number; area: number }[] = [];
    const near: { i: number; dist: number }[] = [];
    const objects = this.parsed.objects;
    for (let i = 0; i < objects.length; i++) {
      if (i === id) continue;
      const other = objects[i];
      if (other.page !== me.page || other.empty) continue;
      const b = this.boxes.get(i);
      if (!b) continue;
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      if (b.minX <= cx && cx <= b.maxX && b.minY <= cy && cy <= b.maxY && Math.max(w, h) > selfSize * 5) {
        const area = w * h;
        if (inside.length < 3 || area < inside[inside.length - 1].area) insertSorted(inside, { i, area }, 3, (x) => x.area);
        continue;
      }
      if (count === 0) continue;
      const dist = Math.hypot(Math.max(b.minX - cx, 0, cx - b.maxX), Math.max(b.minY - cy, 0, cy - b.maxY));
      if (near.length < count || dist < near[near.length - 1].dist) insertSorted(near, { i, dist }, count, (x) => x.dist);
    }
    return {
      inside: inside.map(({ i }) => this.brief(i)),
      nearby: near.map(({ i, dist }) => this.brief(i, round(dist))),
    };
  }

  private brief(i: number, distance?: number): Brief {
    const n = this.parsed.objects[i];
    const r: Brief = { id: i, type: n.type, layer: n.layer };
    if (distance !== undefined) r.distance = distance;
    if (n.block) r.block = n.block;
    if (n.text) r.text = n.text.length > 80 ? n.text.slice(0, 80) + '…' : n.text;
    return r;
  }
}

const memo = new WeakMap<object, DrawingIndex>();

export function indexOf(stored: StoredDrawing): DrawingIndex {
  let index = memo.get(stored.parsed);
  if (!index) {
    index = new DrawingIndex(stored.parsed);
    memo.set(stored.parsed, index);
  }
  return index;
}
