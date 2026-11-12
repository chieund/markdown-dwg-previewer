/**
 * Tables and leaders read straight out of the DXF text.
 *
 * dxf-parser has no reader for ACAD_TABLE, MULTILEADER or LEADER and drops
 * them, so a schedule, a callout and a note's arrow vanished from the sheet.
 * Like HATCH, they are scanned from the raw group codes and spliced back in as
 * entities the normal pipeline can draw.
 *
 * - A table is drawn from the anonymous block (`*T25`) AutoCAD writes for it:
 *   its lines and cell texts, laid out from the table's top-left corner.
 * - A multileader (callout) keeps its geometry in a CONTEXT_DATA section: leader
 *   lines, a landing and dogleg, and the note's text.
 * - A leader (the older, simple kind) is a polyline with an optional arrow; its
 *   arrow size comes from its dimension style.
 */
import { Pair, toPairs } from './hatch';
import { Point2D } from './types';

export interface AnnotationBase {
  handle?: string;
  layer: string;
  colorIndex?: number;
  inPaperSpace: boolean;
  /** Name of the block holding this entity, or null when it sits in ENTITIES. */
  blockName: string | null;
  /** Group 60 = 1: not drawn. */
  invisible: boolean;
}

export interface RawTable extends AnnotationBase {
  kind: 'table';
  /** The anonymous block that holds the table's drawing (`*T25`). */
  block: string;
  position: Point2D;
}

export interface LeaderArrow {
  tip: Point2D;
  /** Unit vector pointing from the line toward the tip. */
  direction: Point2D;
  size: number;
}

export interface LeaderText {
  /** MTEXT content, formatting codes included. */
  value: string;
  position: Point2D;
  height: number;
  /** Degrees. */
  rotation: number;
}

export interface RawLeader extends AnnotationBase {
  kind: 'multileader' | 'leader';
  strokes: Point2D[][];
  arrows: LeaderArrow[];
  text?: LeaderText;
}

export type RawAnnotation = RawTable | RawLeader;

const TARGETS = new Set(['ACAD_TABLE', 'MULTILEADER', 'LEADER']);

/** AutoCAD draws a closed filled arrowhead as long as its size and a third as wide. */
const ARROW_WIDTH_RATIO = 1 / 3;

interface DimStyle {
  scale: number;
  arrow: number;
}

/** DIMSCALE (40) and DIMASZ (41) by dimension style name, upper-cased. */
export function scanDimStyles(pairs: Pair[]): Map<string, DimStyle> {
  const styles = new Map<string, DimStyle>();
  let inTables = false;
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code !== 0) continue;
    if (value === 'SECTION') inTables = pairs[i + 1]?.[1] === 'TABLES';
    else if (value === 'ENDSEC') inTables = false;
    else if (value === 'DIMSTYLE' && inTables) {
      let name: string | undefined;
      let scale = 1;
      let arrow = 0;
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 2 && name === undefined) name = pairs[j][1];
        else if (pairs[j][0] === 40) scale = Number(pairs[j][1]);
        else if (pairs[j][0] === 41) arrow = Number(pairs[j][1]);
      }
      if (name !== undefined) styles.set(name.toUpperCase(), { scale: scale > 0 ? scale : 1, arrow });
    }
  }
  return styles;
}

function entityEnd(pairs: Pair[], from: number): number {
  for (let i = from; i < pairs.length; i++) if (pairs[i][0] === 0) return i;
  return pairs.length;
}

function header(body: Pair[], blockName: string | null): AnnotationBase {
  const base: AnnotationBase = { layer: '0', inPaperSpace: false, blockName, invisible: false };
  for (const [code, value] of body) {
    // Stop at the first subclass: the common header precedes it
    if (code === 100 && value !== 'AcDbEntity') break;
    if (code === 5 && base.handle === undefined) base.handle = value;
    else if (code === 8) base.layer = value;
    else if (code === 62) base.colorIndex = Number(value);
    else if (code === 67) base.inPaperSpace = Number(value) === 1;
    else if (code === 60) base.invisible = Number(value) === 1;
  }
  return base;
}

const finite = (n: number) => Number.isFinite(n);

function unit(dx: number, dy: number): Point2D | undefined {
  const length = Math.hypot(dx, dy);
  return length > 0 && finite(length) ? { x: dx / length, y: dy / length } : undefined;
}

/** The arrow at the end of a path, from the segment that reaches it. */
function arrowAt(from: Point2D, tip: Point2D, size: number): LeaderArrow | undefined {
  const direction = unit(tip.x - from.x, tip.y - from.y);
  return direction && size > 0 && finite(size) ? { tip, direction, size } : undefined;
}

function parseTable(body: Pair[], base: AnnotationBase): RawTable | null {
  const from = body.findIndex(([code, value]) => code === 100 && value === 'AcDbBlockReference');
  if (from < 0) return null;
  let block: string | undefined;
  const position = { x: 0, y: 0 };
  for (let i = from + 1; i < body.length; i++) {
    const [code, value] = body[i];
    if (code === 100) break;
    if (code === 2 && block === undefined) block = value;
    else if (code === 10) position.x = Number(value);
    else if (code === 20) position.y = Number(value);
  }
  if (!block || !finite(position.x) || !finite(position.y)) return null;
  return { ...base, kind: 'table', block, position };
}

/** A multileader's CONTEXT_DATA: the lines, landing, dogleg and note text, in world coordinates. */
function parseMultileader(body: Pair[], base: AnnotationBase): RawLeader | null {
  const result: RawLeader = { ...base, kind: 'multileader', strokes: [], arrows: [] };
  let arrowSize = 0;
  let textHeight = 0;
  let content: string | undefined;
  const location = { x: NaN, y: NaN };
  const direction = { x: 1, y: 0 };
  let inContext = false;
  let leader: { landing: Point2D; dir?: Point2D; dogleg: number; hasDogleg: boolean; lines: Point2D[][] } | null = null;
  let line: Point2D[] | null = null;

  for (const [code, value] of body) {
    if (code === 300 && value === 'CONTEXT_DATA{') inContext = true;
    if (!inContext) continue;

    if (code === 302 && value === 'LEADER{') {
      leader = { landing: { x: NaN, y: NaN }, dogleg: 0, hasDogleg: true, lines: [] };
    } else if (code === 304 && value === 'LEADER_LINE{') {
      line = [];
    } else if (code === 305) {
      if (leader && line && line.length > 0) leader.lines.push(line);
      line = null;
    } else if (code === 303) {
      if (leader) finishLeader(leader, result, arrowSize);
      leader = null;
    } else if (code === 301) {
      inContext = false;
    } else if (line) {
      if (code === 10) line.push({ x: Number(value), y: NaN });
      else if (code === 20 && line.length > 0) line[line.length - 1].y = Number(value);
    } else if (leader) {
      if (code === 10) leader.landing.x = Number(value);
      else if (code === 20) leader.landing.y = Number(value);
      else if (code === 11) leader.dir = { x: Number(value), y: leader.dir?.y ?? 0 };
      else if (code === 21) leader.dir = { x: leader.dir?.x ?? 0, y: Number(value) };
      else if (code === 40) leader.dogleg = Number(value);
      else if (code === 291) leader.hasDogleg = value === '1';
    } else if (code === 41 && textHeight === 0) textHeight = Number(value);
    else if (code === 140) arrowSize = Number(value);
    else if (code === 304) content = value;
    else if (code === 12) location.x = Number(value);
    else if (code === 22) location.y = Number(value);
    else if (code === 13) direction.x = Number(value);
    else if (code === 23) direction.y = Number(value);
  }

  if (content && finite(location.x) && finite(location.y)) {
    result.text = {
      value: content,
      position: { x: location.x, y: location.y },
      height: textHeight > 0 ? textHeight : 1,
      rotation: (Math.atan2(direction.y, direction.x) * 180) / Math.PI,
    };
  }
  return result.strokes.length > 0 || result.text ? result : null;
}

/** Turns one leader's landing, lines and dogleg into strokes and arrows. */
function finishLeader(
  leader: { landing: Point2D; dir?: Point2D; dogleg: number; hasDogleg: boolean; lines: Point2D[][] },
  into: RawLeader,
  arrowSize: number
): void {
  const { landing } = leader;
  if (!finite(landing.x) || !finite(landing.y)) return;
  for (const raw of leader.lines) {
    const vertices = raw.filter((p) => finite(p.x) && finite(p.y));
    if (vertices.length === 0) continue;
    // The line runs from the landing out to its last vertex, where the arrow sits
    const path = [landing, ...vertices];
    into.strokes.push(path);
    const arrow = arrowAt(path[path.length - 2], path[path.length - 1], arrowSize);
    if (arrow) into.arrows.push(arrow);
  }
  if (leader.hasDogleg && leader.dogleg > 0 && leader.dir && unit(leader.dir.x, leader.dir.y)) {
    const d = unit(leader.dir.x, leader.dir.y)!;
    into.strokes.push([landing, { x: landing.x + d.x * leader.dogleg, y: landing.y + d.y * leader.dogleg }]);
  }
}

function parseLeader(body: Pair[], base: AnnotationBase, styles: Map<string, DimStyle>): RawLeader | null {
  let styleName = '';
  let hasArrow = true;
  let count = -1;
  const points: Point2D[] = [];
  let reading = false;
  for (const [code, value] of body) {
    if (code === 3) styleName = value;
    else if (code === 71) hasArrow = Number(value) === 1;
    else if (code === 76) {
      count = Number(value);
      reading = true;
    } else if (reading && code === 10) points.push({ x: Number(value), y: NaN });
    else if (reading && code === 20 && points.length > 0) points[points.length - 1].y = Number(value);
    else if (code === 210) reading = false;
  }
  const vertices = points.filter((p) => finite(p.x) && finite(p.y)).slice(0, count > 0 ? count : undefined);
  if (vertices.length < 2) return null;
  const result: RawLeader = { ...base, kind: 'leader', strokes: [vertices], arrows: [] };
  const style = styles.get(styleName.toUpperCase());
  if (hasArrow && style) {
    const arrow = arrowAt(vertices[1], vertices[0], style.arrow * style.scale);
    if (arrow) result.arrows.push(arrow);
  }
  return result;
}

/** Tables, multileaders and leaders of the file, in file order. */
export function scanAnnotations(text: string): { found: RawAnnotation[]; unreadable: Set<string> } {
  const pairs = toPairs(text);
  const styles = scanDimStyles(pairs);
  const found: RawAnnotation[] = [];
  const unreadable = new Set<string>();
  let section: string | null = null;
  let blockName: string | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code !== 0) continue;
    if (value === 'SECTION') section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1][1] : null;
    else if (value === 'ENDSEC') {
      section = null;
      blockName = null;
    } else if (value === 'BLOCK') {
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 2) {
          blockName = pairs[j][1];
          break;
        }
      }
    } else if (value === 'ENDBLK') blockName = null;
    else if (TARGETS.has(value) && (section === 'ENTITIES' || section === 'BLOCKS')) {
      const end = entityEnd(pairs, i + 1);
      const body = pairs.slice(i + 1, end);
      const base = header(body, section === 'BLOCKS' ? blockName : null);
      const annotation =
        value === 'ACAD_TABLE' ? parseTable(body, base) : value === 'MULTILEADER' ? parseMultileader(body, base) : parseLeader(body, base, styles);
      if (annotation) found.push(annotation);
      else unreadable.add(value);
      i = end - 1;
    }
  }
  return { found, unreadable };
}

/** The triangle of an arrow: tip first, then the two base corners. */
export function arrowPolygon(arrow: LeaderArrow): Point2D[] {
  const { tip, direction, size } = arrow;
  const base = { x: tip.x - direction.x * size, y: tip.y - direction.y * size };
  const half = (size * ARROW_WIDTH_RATIO) / 2;
  const nx = -direction.y * half;
  const ny = direction.x * half;
  return [tip, { x: base.x + nx, y: base.y + ny }, { x: base.x - nx, y: base.y - ny }];
}
