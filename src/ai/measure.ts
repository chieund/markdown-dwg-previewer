/**
 * Measuring geometry as drawn, for questions the drafter left no dimension
 * for: how far apart two things are, what a traced outline encloses, which
 * closed shape a label sits in.
 *
 * Everything is in drawing units and works on the drawn entities, so an
 * INSERT measures as the lines it expands to.
 */
import type { DxfEntity, Point2D } from '../shared/types';

export interface Segment {
  a: Point2D;
  b: Point2D;
}

/** Curves are measured as this many chords per full turn: within 0.5% of the arc. */
const CHORDS_PER_TURN = 64;

function arcPoints(center: Point2D, radius: number, startDeg: number, endDeg: number): Point2D[] {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  const steps = Math.max(2, Math.ceil((sweep / 360) * CHORDS_PER_TURN));
  const points: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDeg + (sweep * i) / steps) * Math.PI) / 180;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

function chain(points: Point2D[], closed: boolean, out: Segment[]): void {
  for (let i = 1; i < points.length; i++) out.push({ a: points[i - 1], b: points[i] });
  if (closed && points.length > 2) out.push({ a: points[points.length - 1], b: points[0] });
  if (points.length === 1) out.push({ a: points[0], b: points[0] });
}

/** The linework of some entities as straight segments; a point or a text is a zero-length one. */
export function segmentsOf(entities: DxfEntity[]): Segment[] {
  const out: Segment[] = [];
  for (const e of entities) {
    switch (e.type) {
      case 'LINE':
        out.push({ a: e.start, b: e.end });
        break;
      case 'POLYLINE':
        chain(e.points, e.closed, out);
        break;
      case 'CIRCLE':
        chain(arcPoints(e.center, e.radius, 0, 360), false, out);
        break;
      case 'ARC':
        chain(arcPoints(e.center, e.radius, e.startAngle, e.endAngle), false, out);
        break;
      case 'HATCH':
        for (const loop of e.loops) chain(loop, true, out);
        break;
      case 'POINT':
        out.push({ a: e.position, b: e.position });
        break;
      case 'TEXT':
        out.push({ a: e.position, b: e.position });
        break;
      case 'DIMENSION':
        out.push({ a: e.textPosition, b: e.textPosition });
        break;
    }
  }
  return out;
}

/** The point of segment `s` nearest to `p`. */
function nearestOn(s: Segment, p: Point2D): Point2D {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return s.a;
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
  return { x: s.a.x + t * dx, y: s.a.y + t * dy };
}

const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Where two segments properly cross, if they do. Touching ends are caught by the end-point distances. */
function crossing(s: Segment, t: Segment): Point2D | undefined {
  const d1 = cross(t.a, t.b, s.a);
  const d2 = cross(t.a, t.b, s.b);
  const d3 = cross(s.a, s.b, t.a);
  const d4 = cross(s.a, s.b, t.b);
  if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) || !((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return undefined;
  const k = d1 / (d1 - d2);
  return { x: s.a.x + k * (s.b.x - s.a.x), y: s.a.y + k * (s.b.y - s.a.y) };
}

export interface Gap {
  distance: number;
  from: Point2D;
  to: Point2D;
}

/** Pairs compared at most; past it the sets are thinned evenly and the result is marked approximate. */
const MAX_PAIRS = 4_000_000;

function thin(segments: Segment[], max: number): Segment[] {
  if (segments.length <= max) return segments;
  const step = segments.length / max;
  const out: Segment[] = [];
  for (let i = 0; i < max; i++) out.push(segments[Math.floor(i * step)]);
  return out;
}

/**
 * The shortest distance between two sets of linework and the points it runs
 * between: 0 where they touch or cross. `approximate` is set when the sets were
 * too large to compare in full.
 */
export function gapBetween(from: Segment[], to: Segment[]): (Gap & { approximate?: true }) | undefined {
  if (from.length === 0 || to.length === 0) return undefined;
  const approximate = from.length * to.length > MAX_PAIRS;
  const side = Math.floor(Math.sqrt(MAX_PAIRS));
  const a = approximate ? thin(from, side) : from;
  const b = approximate ? thin(to, side) : to;
  let best: Gap = { distance: Infinity, from: a[0].a, to: b[0].a };
  const consider = (p: Point2D, q: Point2D) => {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.distance) best = { distance: d, from: p, to: q };
  };
  for (const s of a) {
    for (const t of b) {
      const x = crossing(s, t);
      if (x) return { distance: 0, from: x, to: x, ...(approximate ? { approximate: true as const } : {}) };
      consider(s.a, nearestOn(t, s.a));
      consider(s.b, nearestOn(t, s.b));
      consider(nearestOn(s, t.a), t.a);
      consider(nearestOn(s, t.b), t.b);
    }
  }
  return approximate ? { ...best, approximate: true } : best;
}

/** Length of a path through the points, in order; `closed` adds the way back to the start. */
export function pathLength(points: Point2D[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (closed && points.length > 2) {
    total += Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
  }
  return total;
}

/** Area inside the outline through the points (shoelace), whichever way round they run. */
export function polygonArea(points: Point2D[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    twice += p.x * q.y - q.x * p.y;
  }
  return Math.abs(twice) / 2;
}

/** Even-odd test: is the point inside the outline through `polygon`? */
export function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface Enclosure {
  /** Object the closed shape belongs to. */
  obj: number;
  layer: string;
  kind: 'polyline' | 'circle' | 'hatch';
  area: number;
  width: number;
  height: number;
}

function extent(points: Point2D[]): { width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * The closed shapes drawn around a point, smallest first: closed polylines,
 * circles and hatch boundaries. A room outlined with separate lines is not a
 * closed shape and is not found here.
 */
export function enclosuresAt(entities: DxfEntity[], point: Point2D, max: number): Enclosure[] {
  const found: Enclosure[] = [];
  for (const e of entities) {
    if (e.obj === undefined) continue;
    if (e.type === 'POLYLINE' && e.closed && e.points.length > 2) {
      if (pointInPolygon(point, e.points)) {
        found.push({ obj: e.obj, layer: e.layer, kind: 'polyline', area: polygonArea(e.points), ...extent(e.points) });
      }
    } else if (e.type === 'CIRCLE') {
      if (Math.hypot(point.x - e.center.x, point.y - e.center.y) <= e.radius) {
        found.push({ obj: e.obj, layer: e.layer, kind: 'circle', area: Math.PI * e.radius * e.radius, width: 2 * e.radius, height: 2 * e.radius });
      }
    } else if (e.type === 'HATCH') {
      // Even-odd over all loops: a point in a hole is outside the hatch
      let inside = false;
      for (const loop of e.loops) if (loop.length > 2 && pointInPolygon(point, loop)) inside = !inside;
      if (inside) {
        const outer = e.loops.reduce((big, loop) => (polygonArea(loop) > polygonArea(big) ? loop : big), e.loops[0]);
        const holes = e.loops.reduce((sum, loop) => sum + polygonArea(loop), 0) - polygonArea(outer);
        found.push({ obj: e.obj, layer: e.layer, kind: 'hatch', area: Math.max(0, polygonArea(outer) - holes), ...extent(outer) });
      }
    }
  }
  return found.sort((a, b) => a.area - b.area).slice(0, max);
}
