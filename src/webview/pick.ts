import { textBoxCorners } from '../shared/bounds';
import type { DxfEntity, DxfPage, Point2D } from '../shared/types';

/**
 * Finds the object under a click, in drawing coordinates.
 *
 * The browser's own hit testing cannot be trusted here: lines are drawn with
 * `vector-effect: non-scaling-stroke` through a flipped, scaled viewBox, and
 * Chromium misses such strokes entirely — only filled text was clickable.
 * Measuring distances in the drawing works for every shape and every zoom.
 *
 * Outlines (lines, arcs, open shapes) count within `tolerance`; filled shapes,
 * hatches and text count anywhere inside. The nearest wins, and on a tie the
 * one drawn later — the one on top. Being inside an area ranks as far as an
 * outline can be: a wall line drawn across a room's hatch or a label's box is
 * what the user aimed at, as in CAD software.
 */
export function pickObject(page: DxfPage, point: Point2D, tolerance: number, hiddenLayers: Set<string>): number | undefined {
  let best: number | undefined;
  let bestDistance = Infinity;

  const consider = (entity: DxfEntity) => {
    if (entity.obj === undefined || hiddenLayers.has(entity.layer)) return;
    const raw = distanceTo(entity, point);
    const d = raw === INSIDE ? tolerance : raw;
    if (d <= tolerance && d <= bestDistance) {
      best = entity.obj;
      bestDistance = d;
    }
  };

  // Viewport content sits behind the sheet, and only shows inside its window
  for (const view of page.viewports ?? []) {
    const r = view.rect;
    if (point.x < r.x || point.x > r.x + r.width || point.y < r.y || point.y > r.y + r.height) continue;
    view.entities.forEach(consider);
  }
  page.entities.forEach(consider);
  return best;
}

/** Returned for a point inside a filled area, text box or hatch. */
const INSIDE = -1;

function distanceTo(entity: DxfEntity, p: Point2D): number {
  switch (entity.type) {
    case 'LINE':
      return segmentDistance(p, entity.start, entity.end);
    case 'POLYLINE': {
      if (entity.filled && entity.closed && insidePolygon(p, entity.points)) return INSIDE;
      return polylineDistance(p, entity.points, entity.closed);
    }
    case 'CIRCLE':
      return Math.abs(Math.hypot(p.x - entity.center.x, p.y - entity.center.y) - entity.radius);
    case 'ARC': {
      const ends = [entity.startAngle, entity.endAngle].map((a) => ({
        x: entity.center.x + entity.radius * Math.cos(a),
        y: entity.center.y + entity.radius * Math.sin(a),
      }));
      const angle = Math.atan2(p.y - entity.center.y, p.x - entity.center.x);
      if (withinSweep(angle, entity.startAngle, entity.endAngle)) {
        return Math.abs(Math.hypot(p.x - entity.center.x, p.y - entity.center.y) - entity.radius);
      }
      return Math.min(...ends.map((end) => Math.hypot(p.x - end.x, p.y - end.y)));
    }
    case 'HATCH': {
      // Even-odd: inside an odd number of loops means inside the fill
      const inside = entity.loops.filter((loop) => insidePolygon(p, loop)).length % 2 === 1;
      return inside ? INSIDE : Math.min(...entity.loops.map((loop) => polylineDistance(p, loop, true)));
    }
    case 'TEXT': {
      const box = textBoxCorners(entity);
      return insidePolygon(p, box) ? INSIDE : polylineDistance(p, box, true);
    }
    case 'POINT':
      return Math.hypot(p.x - entity.position.x, p.y - entity.position.y);
    case 'DIMENSION': {
      const label = Math.hypot(p.x - entity.textPosition.x, p.y - entity.textPosition.y) - entity.height;
      const line =
        entity.linePoint1 && entity.linePoint2 ? segmentDistance(p, entity.linePoint1, entity.linePoint2) : Infinity;
      return Math.max(0, Math.min(label, line));
    }
  }
}

function withinSweep(angle: number, start: number, end: number): boolean {
  const turn = Math.PI * 2;
  const sweep = (((end - start) % turn) + turn) % turn || turn;
  const offset = (((angle - start) % turn) + turn) % turn;
  return offset <= sweep;
}

function segmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function polylineDistance(p: Point2D, points: Point2D[], closed: boolean): number {
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    best = Math.min(best, segmentDistance(p, points[i], points[(i + 1) % points.length]));
  }
  return best;
}

function insidePolygon(p: Point2D, points: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
