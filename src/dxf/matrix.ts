import { Point2D } from './types';

/**
 * 2D affine transform, applied as:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translate(tx: number, ty: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scale(sx: number, sy: number): Matrix2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotate(radians: number): Matrix2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Returns a transform equivalent to applying `inner` first, then `outer`. */
export function multiply(outer: Matrix2D, inner: Matrix2D): Matrix2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function applyToPoint(m: Matrix2D, p: Point2D): Point2D {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * True when the transform maps circles to circles — i.e. it is a rotation,
 * uniform scale, mirror, or any composition of those. Non-uniform scaling
 * fails this test, because it turns a circle into an ellipse.
 */
export function isSimilarity(m: Matrix2D): boolean {
  const rowA = m.a * m.a + m.b * m.b;
  const rowB = m.c * m.c + m.d * m.d;
  const tolerance = 1e-9 * Math.max(1, rowA, rowB);
  return Math.abs(rowA - rowB) < tolerance && Math.abs(m.a * m.c + m.b * m.d) < tolerance;
}

/** Uniform scale factor. Only meaningful when `isSimilarity(m)` holds. */
export function similarityScale(m: Matrix2D): number {
  return Math.sqrt(m.a * m.a + m.b * m.b);
}

export function rotationAngle(m: Matrix2D): number {
  return Math.atan2(m.b, m.a);
}

/** Negative when the transform mirrors — which reverses the sweep direction of arcs. */
export function determinant(m: Matrix2D): number {
  return m.a * m.d - m.b * m.c;
}
