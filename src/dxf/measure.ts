/**
 * Length and area of drawing objects, in drawing units.
 *
 * An estimator wants the exact number, so the formulas below are used wherever
 * the shape allows it: a bulge segment is a true circular arc and a circle is a
 * true circle. Only geometry that a non-uniform scale has already turned into
 * curves (an ellipse, a sampled spline, a circle in a stretched block) has to
 * be measured from the polyline the renderer produced, which is accurate to
 * well under a tenth of a percent.
 */
import { Matrix2D, isSimilarity, similarityScale } from './matrix';
import { Point2D } from './types';

/**
 * What one object measures. Fields are absent when the object has no such
 * dimension — text and points have neither length nor area.
 *
 * `hatchArea` is separate from `area` on purpose: a hatch usually fills a
 * closed polyline that is already counted in `area`, and adding the two would
 * count the floor twice.
 */
export interface Measure {
  length?: number;
  area?: number;
  hatchArea?: number;
}

/** A polyline vertex; `bulge` describes the arc reaching the next vertex. */
export type BulgeVertex = Point2D & { bulge?: number };

/** Circumference of a circle, and the disc it bounds. */
export function circleMeasure(radius: number): Measure {
  return { length: 2 * Math.PI * radius, area: Math.PI * radius * radius };
}

/**
 * Length of an arc. Angles are in radians, as DXF hands them over; a sweep
 * running backwards measures the same as one running forwards.
 */
export function arcLength(radius: number, sweep: number): number {
  return radius * Math.abs(sweep);
}

/**
 * Shoelace area of a closed ring.
 *
 * `0` for anything with fewer than three vertices: two points and a hole in
 * the middle of a drawing both come through here, and neither encloses
 * anything. The result is unsigned — a ring listed clockwise encloses the same
 * area as one listed counter-clockwise.
 */
export function polygonArea(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const to = points[(i + 1) % points.length];
    sum += from.x * to.y - to.x * from.y;
  }
  return Math.abs(sum) / 2;
}

/** Length of a run of points, adding the closing segment for a closed shape. */
export function pathLength(points: Point2D[], closed: boolean): number {
  if (points.length < 2) return 0;
  let total = 0;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const from = points[i];
    const to = points[(i + 1) % points.length];
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

/**
 * Length and area of an already-flattened shape — what a non-uniform scale
 * leaves behind, and what true polygons turn into.
 */
export function polygonMeasure(points: Point2D[], closed: boolean): Measure {
  return { length: pathLength(points, closed), area: closed ? polygonArea(points) : 0 };
}

/**
 * Length and area of a smooth curve that was sampled into a polygon.
 *
 * The polygon runs through the sample points, so it stays *inside* the curve:
 * with the 64 segments a circle or ellipse is drawn with, the enclosed area
 * comes out 0.16 % small and the perimeter 0.04 % short — enough to matter on a
 * floor area. Both are corrected by the ratio of the curve to its chord, which
 * is exact in the limit and only ever slightly over-corrects otherwise.
 *
 * Only closed curves are corrected: for an open one the total sweep is unknown,
 * and an open polyline is short by much less anyway.
 */
export function sampledMeasure(points: Point2D[], closed: boolean): Measure {
  const measure = polygonMeasure(points, closed);
  const segments = closed ? points.length - 1 : 0;
  if (segments < 4) return measure;

  const step = (Math.PI * 2) / segments;
  const lengthFactor = step / (2 * Math.sin(step / 2));
  return {
    length: measure.length === undefined ? undefined : measure.length * lengthFactor,
    area: measure.area === undefined ? undefined : (measure.area * 2 * Math.PI) / (segments * Math.sin(step)),
  };
}

/**
 * Length and area of a polyline with bulges, measured before any transform.
 *
 * Length is the sum of the true arcs and straight chords. Area is the area
 * enclosed by the chords (shoelace) plus, for every bulge, the circular
 * segment between its chord and its arc — a semicircle bulge of radius r
 * therefore encloses exactly πr²/2.
 */
export function polylineMeasure(vertices: BulgeVertex[], closed: boolean): Measure {
  if (vertices.length < 2) return { length: 0, area: 0 };

  let length = 0;
  let area = 0;
  const edges = closed ? vertices.length : vertices.length - 1;

  for (let i = 0; i < edges; i++) {
    const from = vertices[i];
    const to = vertices[(i + 1) % vertices.length];
    const chord = Math.hypot(to.x - from.x, to.y - from.y);
    const bulge = from.bulge;

    if (!bulge) {
      length += chord;
      if (closed) area += (from.x * to.y - to.x * from.y) / 2;
      continue;
    }

    // A bulge is tan(includedAngle / 4); a bulge of 1 is a semicircle, and a
    // negative one runs the arc the other way round.
    const sweep = 4 * Math.atan(bulge);
    const halfChord = Math.abs(Math.sin(sweep / 2));
    if (!Number.isFinite(halfChord) || halfChord === 0) {
      length += chord;
      continue;
    }
    const radius = chord / (2 * halfChord);
    length += radius * Math.abs(sweep);
    if (closed) {
      // Signed shoelace of the chord, plus the segment the arc adds on top.
      area += (from.x * to.y - to.x * from.y) / 2 + (radius * radius * (sweep - Math.sin(sweep))) / 2;
    }
  }

  return { length, area: closed ? Math.abs(area) : 0 };
}

/**
 * Area covered by a hatch, in its own column.
 *
 * Boundary loops follow the even-odd rule: an outer loop adds, a hole in it
 * (a window in a wall, say) subtracts. AutoCAD already resolves which loop is
 * which, so nesting depth is not tracked — parity is what decides, which also
 * makes the result independent of the direction each loop happens to be listed
 * in, and so survives a mirrored block that flips them all over.
 */
export function hatchArea(loops: Point2D[][]): number {
  let area = 0;
  loops.forEach((loop, index) => {
    const enclosed = polygonArea(loop);
    if (enclosed === 0) return;
    area += index % 2 === 0 ? enclosed : -enclosed;
  });
  return Math.abs(area);
}

/**
 * Multiplies a measurement taken in block space by the transform that places
 * it in the world. Lengths follow the scale, areas its square.
 */
export function scaleMeasure(measure: Measure, m: Matrix2D): Measure {
  if (!isSimilarity(m)) return measure;
  const factor = similarityScale(m);
  const squared = factor * factor;
  return {
    length: measure.length === undefined ? undefined : measure.length * factor,
    area: measure.area === undefined ? undefined : measure.area * squared,
    hatchArea: measure.hatchArea === undefined ? undefined : measure.hatchArea * squared,
  };
}