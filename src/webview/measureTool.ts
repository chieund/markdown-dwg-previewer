/**
 * The click-two-points ruler: where a click lands, and what the pair measures.
 * Kept free of the DOM so it can be tested.
 */
import type { DxfEntity, Point2D } from '../shared/types';

/** Corners and centres a click can lock onto: line ends, polyline corners, circle and arc centres, points. */
function anchorsOf(entity: DxfEntity, visit: (p: Point2D) => void): void {
  switch (entity.type) {
    case 'LINE':
      visit(entity.start);
      visit(entity.end);
      break;
    case 'POLYLINE':
      for (const p of entity.points) visit(p);
      break;
    case 'CIRCLE':
    case 'ARC':
      visit(entity.center);
      break;
    case 'POINT':
      visit(entity.position);
      break;
    case 'HATCH':
      for (const loop of entity.loops) for (const p of loop) visit(p);
      break;
  }
}

/**
 * The anchor nearest to `point` within `radius`, or `point` itself when none
 * is that close. Entities on hidden layers do not attract the click.
 */
export function snapPoint(
  entities: DxfEntity[],
  hiddenLayers: Set<string>,
  point: Point2D,
  radius: number
): { point: Point2D; snapped: boolean } {
  let best: Point2D | undefined;
  let bestDistance = radius;
  for (const entity of entities) {
    if (hiddenLayers.has(entity.layer)) continue;
    anchorsOf(entity, (p) => {
      // Cheap reject before the square root: most anchors are far away
      if (Math.abs(p.x - point.x) > bestDistance || Math.abs(p.y - point.y) > bestDistance) return;
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = p;
      }
    });
  }
  return best ? { point: { x: best.x, y: best.y }, snapped: true } : { point, snapped: false };
}

export interface Ruler {
  distance: number;
  dx: number;
  dy: number;
}

/** What two points measure, in drawing units. */
export function rulerBetween(a: Point2D, b: Point2D): Ruler {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return { distance: Math.hypot(dx, dy), dx, dy };
}
