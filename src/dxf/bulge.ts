import { Point2D } from './types';

/** Segments used for a full circle; a partial arc gets a proportional share. */
const SEGMENTS_PER_TURN = 64;
const MIN_SEGMENTS = 2;

/**
 * Expands polyline vertices into a point list, turning bulge values into arcs.
 *
 * A vertex's bulge describes the arc reaching the *next* vertex, stored as
 * `tan(includedAngle / 4)`. It is negative when the arc runs clockwise, and a
 * bulge of 1 is a semicircle. Vertices without a bulge join with a straight
 * line, which is what every segment used to be.
 *
 * The returned list never repeats the first point for a closed polyline; the
 * renderer closes the shape itself.
 */
export function expandBulges(
  vertices: (Point2D & { bulge?: number })[],
  closed: boolean
): Point2D[] {
  if (vertices.length < 2) return vertices.map((v) => ({ x: v.x, y: v.y }));

  const points: Point2D[] = [];
  const lastIndex = closed ? vertices.length - 1 : vertices.length - 2;

  for (let i = 0; i <= lastIndex; i++) {
    const from = vertices[i];
    const to = vertices[(i + 1) % vertices.length];

    points.push({ x: from.x, y: from.y });

    const bulge = from.bulge;
    if (bulge) points.push(...arcBetween(from, to, bulge));
  }

  if (!closed) {
    const last = vertices[vertices.length - 1];
    points.push({ x: last.x, y: last.y });
  }

  return points;
}

/** Interior points of the arc from `from` to `to`, excluding both endpoints. */
function arcBetween(from: Point2D, to: Point2D, bulge: number): Point2D[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return [];

  // Perpendicular offset from the chord midpoint to the arc centre.
  const k = (1 - bulge * bulge) / (2 * bulge);
  const center = {
    x: (from.x + to.x) / 2 - (dy / 2) * k,
    y: (from.y + to.y) / 2 + (dx / 2) * k,
  };

  const radius = Math.hypot(from.x - center.x, from.y - center.y);
  if (!isFinite(radius) || radius === 0) return [];

  const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  const endAngle = Math.atan2(to.y - center.y, to.x - center.x);

  // A positive bulge sweeps counter-clockwise, a negative one clockwise.
  let sweep = endAngle - startAngle;
  if (bulge > 0) {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2;
  }

  const segments = Math.max(
    MIN_SEGMENTS,
    Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * SEGMENTS_PER_TURN)
  );

  const interior: Point2D[] = [];
  for (let i = 1; i < segments; i++) {
    const angle = startAngle + (sweep * i) / segments;
    interior.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return interior;
}
