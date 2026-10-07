import { expandBulges } from './bulge';
import { sampleSpline } from './spline';
import { Point2D } from './types';

/**
 * A HATCH read straight out of the DXF text.
 *
 * dxf-parser has no reader for HATCH and drops the entity entirely, so the
 * filled regions of a drawing — wall poché, roof fill, floor patterns — simply
 * vanish. This scanner recovers them from the raw group codes.
 */
export interface RawHatch {
  /** Entity handle (group 5), used to put the hatch back at its place in the draw order. */
  handle?: string;
  layer: string;
  colorIndex?: number;
  inPaperSpace: boolean;
  /** Name of the block holding this hatch, or null when it sits in ENTITIES. */
  blockName: string | null;
  solid: boolean;
  patternName: string;
  /** Degrees. */
  patternAngle: number;
  patternScale: number;
  /** Boundary loops, already flattened to polygons. Inner loops cut holes. */
  loops: Point2D[][];
  /** Extrusion direction (210/220/230); the loops are in this OCS. */
  extrusion?: { x: number; y: number; z: number };
}

const ARC_SEGMENTS_PER_TURN = 64;

/** Boundary path type flag bit 1 (value 2): the loop is stored as a polyline. */
const PATH_IS_POLYLINE = 2;

export function scanHatches(text: string): RawHatch[] {
  const pairs = toPairs(text);
  const hatches: RawHatch[] = [];

  let section: string | null = null;
  let blockName: string | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];

    if (code === 0) {
      if (value === 'SECTION') {
        section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1][1] : null;
      } else if (value === 'ENDSEC') {
        section = null;
        blockName = null;
      } else if (value === 'BLOCK') {
        blockName = nextValue(pairs, i, 2);
      } else if (value === 'ENDBLK') {
        blockName = null;
      } else if (value === 'HATCH' && (section === 'ENTITIES' || section === 'BLOCKS')) {
        const end = findEntityEnd(pairs, i + 1);
        const hatch = parseHatch(pairs.slice(i + 1, end), section === 'BLOCKS' ? blockName : null);
        if (hatch) hatches.push(hatch);
        i = end - 1;
      }
    }
  }

  return hatches;
}

type Pair = [number, string];

function toPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function findEntityEnd(pairs: Pair[], from: number): number {
  for (let i = from; i < pairs.length; i++) {
    if (pairs[i][0] === 0) return i;
  }
  return pairs.length;
}

function nextValue(pairs: Pair[], from: number, code: number): string | null {
  for (let i = from + 1; i < pairs.length && pairs[i][0] !== 0; i++) {
    if (pairs[i][0] === code) return pairs[i][1];
  }
  return null;
}

function parseHatch(body: Pair[], blockName: string | null): RawHatch | null {
  const hatch: RawHatch = {
    layer: '0',
    inPaperSpace: false,
    blockName,
    solid: false,
    patternName: '',
    patternAngle: 0,
    patternScale: 1,
    loops: [],
  };

  const extrusion = { x: 0, y: 0, z: 1 };
  let index = 0;
  // Header: everything before the first boundary path (group 92).
  for (; index < body.length && body[index][0] !== 92; index++) {
    const [code, value] = body[index];
    if (code === 5) hatch.handle = value;
    else if (code === 210) extrusion.x = Number(value);
    else if (code === 220) extrusion.y = Number(value);
    else if (code === 230) extrusion.z = Number(value);
    else if (code === 8) hatch.layer = value;
    else if (code === 62) hatch.colorIndex = Number(value);
    else if (code === 67) hatch.inPaperSpace = Number(value) === 1;
    else if (code === 2) hatch.patternName = value;
    else if (code === 70) hatch.solid = Number(value) === 1;
  }

  if (extrusion.x !== 0 || extrusion.y !== 0 || extrusion.z !== 1) hatch.extrusion = extrusion;

  while (index < body.length) {
    if (body[index][0] !== 92) {
      // Pattern data trails the loops.
      const [code, value] = body[index];
      if (code === 52) hatch.patternAngle = Number(value);
      else if (code === 41) hatch.patternScale = Number(value) || 1;
      index++;
      continue;
    }

    const pathFlag = Number(body[index][1]);
    index++;
    const end = nextLoopBoundary(body, index);
    const loop =
      pathFlag & PATH_IS_POLYLINE
        ? parsePolylineLoop(body.slice(index, end))
        : parseEdgeLoop(body.slice(index, end));
    if (loop.length >= 3) hatch.loops.push(loop);
    index = end;
  }

  return hatch.loops.length > 0 ? hatch : null;
}

/** A loop runs until the next path (92) or the source-object count (97) that closes it. */
function nextLoopBoundary(body: Pair[], from: number): number {
  for (let i = from; i < body.length; i++) {
    if (body[i][0] === 92 || body[i][0] === 97) return i;
  }
  return body.length;
}

function parsePolylineLoop(body: Pair[]): Point2D[] {
  const vertices: (Point2D & { bulge?: number })[] = [];
  let closed = false;
  let current: (Point2D & { bulge?: number }) | null = null;

  for (const [code, value] of body) {
    if (code === 73) closed = Number(value) === 1;
    else if (code === 10) {
      current = { x: Number(value), y: 0 };
      vertices.push(current);
    } else if (code === 20 && current) current.y = Number(value);
    else if (code === 42 && current) {
      const bulge = Number(value);
      if (bulge) current.bulge = bulge;
    }
  }

  if (vertices.length < 2) return vertices;
  return expandBulges(vertices, closed);
}

function parseEdgeLoop(body: Pair[]): Point2D[] {
  const points: Point2D[] = [];
  let index = 0;

  while (index < body.length) {
    if (body[index][0] !== 72) {
      index++;
      continue;
    }
    const edgeType = Number(body[index][1]);
    index++;
    const end = nextEdgeBoundary(body, index);
    points.push(...parseEdge(edgeType, body.slice(index, end)));
    index = end;
  }

  return points;
}

function nextEdgeBoundary(body: Pair[], from: number): number {
  for (let i = from; i < body.length; i++) {
    if (body[i][0] === 72) return i;
  }
  return body.length;
}

function parseEdge(edgeType: number, body: Pair[]): Point2D[] {
  const numbers = new Map<number, number[]>();
  for (const [code, value] of body) {
    const list = numbers.get(code) ?? [];
    list.push(Number(value));
    numbers.set(code, list);
  }
  const at = (code: number, index = 0) => numbers.get(code)?.[index];

  switch (edgeType) {
    case 1: {
      // Line: start (10,20) to end (11,21).
      const x1 = at(10);
      const y1 = at(20);
      const x2 = at(11);
      const y2 = at(21);
      if ([x1, y1, x2, y2].some((n) => n === undefined)) return [];
      return [
        { x: x1!, y: y1! },
        { x: x2!, y: y2! },
      ];
    }
    case 2: {
      // Circular arc: centre (10,20), radius 40, angles 50/51 in degrees.
      const cx = at(10);
      const cy = at(20);
      const radius = at(40);
      if (cx === undefined || cy === undefined || radius === undefined) return [];
      return sampleArc(
        { x: cx, y: cy },
        radius,
        ((at(50) ?? 0) * Math.PI) / 180,
        ((at(51) ?? 360) * Math.PI) / 180,
        at(73) !== 0
      );
    }
    case 3: {
      // Elliptic arc: centre (10,20), major axis vector (11,21), ratio 40.
      const cx = at(10);
      const cy = at(20);
      const mx = at(11);
      const my = at(21);
      const ratio = at(40) ?? 1;
      if ([cx, cy, mx, my].some((n) => n === undefined)) return [];
      return sampleEllipse(
        { x: cx!, y: cy! },
        { x: mx!, y: my! },
        ratio,
        ((at(50) ?? 0) * Math.PI) / 180,
        ((at(51) ?? 360) * Math.PI) / 180,
        at(73) !== 0
      );
    }
    case 4: {
      // Spline: degree 94, knots 40, control points 10/20.
      const degree = at(94) ?? 3;
      const knots = numbers.get(40) ?? [];
      const xs = numbers.get(10) ?? [];
      const ys = numbers.get(20) ?? [];
      const control = xs.map((x, i) => ({ x, y: ys[i] ?? 0 }));
      const sampled = sampleSpline(control, knots, degree);
      return sampled.length > 0 ? sampled : control;
    }
    default:
      return [];
  }
}

function sampleArc(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean
): Point2D[] {
  let sweep = endAngle - startAngle;
  if (counterClockwise) {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2;
  }

  const segments = Math.max(
    2,
    Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * ARC_SEGMENTS_PER_TURN)
  );
  const points: Point2D[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + (sweep * i) / segments;
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return points;
}

function sampleEllipse(
  center: Point2D,
  major: Point2D,
  ratio: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean
): Point2D[] {
  let sweep = endAngle - startAngle;
  if (counterClockwise) {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2;
  }

  const segments = Math.max(
    4,
    Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * ARC_SEGMENTS_PER_TURN)
  );
  const points: Point2D[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = startAngle + (sweep * i) / segments;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    points.push({
      x: center.x + major.x * cos - major.y * ratio * sin,
      y: center.y + major.y * cos + major.x * ratio * sin,
    });
  }
  return points;
}
