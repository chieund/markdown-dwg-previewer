import { Point2D } from './types';

const SAMPLES_PER_SPAN = 8;
const MAX_SAMPLES = 4000;

/**
 * Samples a B-spline curve into a polyline.
 *
 * Uses de Boor's algorithm against the control points and knot vector. Weights
 * (rational/NURBS splines) are not applied — dxf-parser doesn't expose them,
 * so rational splines render as their non-rational approximation.
 *
 * Returns an empty array when the spline is too malformed to evaluate, so
 * callers can fall back to drawing the control polygon.
 */
export function sampleSpline(
  controlPoints: Point2D[],
  knots: number[],
  degree: number
): Point2D[] {
  const n = controlPoints.length;
  if (n === 0) return [];
  if (degree < 1 || n <= degree) return [];
  if (knots.length !== n + degree + 1) return [];

  const domainStart = knots[degree];
  const domainEnd = knots[n];
  if (!(domainEnd > domainStart)) return [];

  const spanCount = n - degree;
  const sampleCount = Math.min(MAX_SAMPLES, Math.max(2, spanCount * SAMPLES_PER_SPAN));

  const points: Point2D[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = domainStart + ((domainEnd - domainStart) * i) / sampleCount;
    const point = evaluate(controlPoints, knots, degree, i === sampleCount ? domainEnd : t);
    if (point) points.push(point);
  }
  return points;
}

function evaluate(controlPoints: Point2D[], knots: number[], degree: number, t: number): Point2D | null {
  const n = controlPoints.length;
  const span = findSpan(knots, degree, n, t);
  if (span < 0) return null;

  // de Boor: repeatedly interpolate the degree+1 control points affecting this span.
  const working: Point2D[] = [];
  for (let i = 0; i <= degree; i++) {
    const cp = controlPoints[span - degree + i];
    working.push({ x: cp.x, y: cp.y });
  }

  for (let r = 1; r <= degree; r++) {
    for (let i = degree; i >= r; i--) {
      const knotIndex = span - degree + i;
      const lower = knots[knotIndex];
      const upper = knots[knotIndex + degree - r + 1];
      const denominator = upper - lower;
      const alpha = denominator === 0 ? 0 : (t - lower) / denominator;
      working[i] = {
        x: working[i - 1].x * (1 - alpha) + working[i].x * alpha,
        y: working[i - 1].y * (1 - alpha) + working[i].y * alpha,
      };
    }
  }

  return working[degree];
}

/** Index of the knot span containing t, clamped to the valid evaluation range. */
function findSpan(knots: number[], degree: number, controlPointCount: number, t: number): number {
  const last = controlPointCount - 1;
  if (t >= knots[controlPointCount]) return last;
  if (t <= knots[degree]) return degree;

  let low = degree;
  let high = controlPointCount;
  let mid = Math.floor((low + high) / 2);
  while (t < knots[mid] || t >= knots[mid + 1]) {
    if (t < knots[mid]) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
    if (mid <= degree) return degree;
    if (mid >= controlPointCount) return last;
  }
  return mid;
}
