/**
 * Shared types between extension host and webview.
 *
 * This is the wire format transmitted via postMessage. Both sides import from
 * here — changing a field in one place will cause a compile error in the other,
 * preventing silent runtime mismatches.
 */

export interface Point2D {
  x: number;
  y: number;
}

interface EntityBase {
  layer: string;
  color: string;
  /** Index into `ParsedDxf.objects`: the top-level object (e.g. the outermost INSERT) this was drawn for. */
  obj?: number;
  linetype?: string;
  lineweight?: number;
}

export interface LineEntity extends EntityBase {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
}

export interface CircleEntity extends EntityBase {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
}

export interface ArcEntity extends EntityBase {
  type: 'ARC';
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface PolylineEntity extends EntityBase {
  type: 'POLYLINE';
  points: Point2D[];
  closed: boolean;
  filled?: boolean;
}

export interface PointEntity extends EntityBase {
  type: 'POINT';
  position: Point2D;
}

export interface HatchEntity extends EntityBase {
  type: 'HATCH';
  loops: Point2D[][];
  solid: boolean;
  patternAngle: number;
  patternSpacing: number;
}

export interface TextEntity extends EntityBase {
  type: 'TEXT';
  position: Point2D;
  text: string;
  height: number;
  rotation: number;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
  fontFamily?: string;
}

export interface DimensionEntity extends EntityBase {
  type: 'DIMENSION';
  textPosition: Point2D;
  text: string;
  height: number;
  linePoint1?: Point2D;
  linePoint2?: Point2D;
}

export type DxfEntity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity
  | PointEntity
  | HatchEntity
  | TextEntity
  | DimensionEntity;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayerInfo {
  name: string;
  color: string;
  entityCount: number;
  /** Switched off in the CAD file itself; the viewer starts with it hidden. */
  off?: boolean;
}

export interface ViewportView {
  rect: { x: number; y: number; width: number; height: number };
  entities: DxfEntity[];
}

export interface DxfPage {
  name: string;
  entities: DxfEntity[];
  bounds: Bounds | null;
  layers: LayerInfo[];
  viewports?: ViewportView[];
}

export interface Attribute {
  tag: string;
  value: string;
  /** An invisible attribute: not drawn, but still part of the block's data. */
  hidden?: boolean;
}

/**
 * One top-level entity of the file, as the user thinks of it: a door block is
 * one object however many lines it expands to. Search and the inspector work
 * on these; drawn entities point back at them through `obj`.
 */
export interface ObjectInfo {
  /** DXF entity type: INSERT, LINE, TEXT … */
  type: string;
  layer: string;
  handle?: string;
  /** Index of the page the object sits on. */
  page: number;
  /** INSERT only. */
  block?: string;
  position?: Point2D;
  /** Degrees. */
  rotation?: number;
  scale?: { x: number; y: number };
  attributes?: Attribute[];
  /** TEXT, MTEXT and DIMENSION: the text as displayed. */
  text?: string;
  /**
   * What the object measures, in drawing units — an INSERT carries the totals
   * of the geometry it expands to. Zero values are left out.
   *
   * `hatchArea` is kept apart from `area`: a hatch normally fills a closed
   * polyline that `area` already counts, and adding them would count the floor
   * twice.
   */
  length?: number;
  area?: number;
  hatchArea?: number;
  /**
   * The share of those totals drawn on layers other than `layer`, by layer — a
   * block whose door swing sits on its own layer. Already included in the
   * totals; kept so switching that layer off takes its share out of a takeoff.
   * Left out when everything is on the object's own layer.
   */
  parts?: Record<string, LayerMeasure>;
  /** Nothing was drawn for it (invisible, unsupported, or cut off by the entity limit). */
  empty?: true;
}

/** What one layer's share of an object measures, in drawing units. */
export interface LayerMeasure {
  length?: number;
  area?: number;
  hatchArea?: number;
}

export interface ParsedDxf {
  pages: DxfPage[];
  objects: ObjectInfo[];
  skippedEntityTypes: string[];
  /** Problems worth telling the user about, e.g. a drawing cut short at the entity limit. */
  warnings?: string[];
  /**
   * `$INSUNITS`: what one drawing unit is worth, as the DXF reference numbers
   * them (4 = mm, 5 = cm, 6 = m, 1 = inch, 2 = foot …). Left out when the file
   * declares none, which is the normal case for R12 and for many drawings.
   */
  units?: number;
}

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface DiffChange {
  kind: ChangeKind;
  /** e.g. `Changed · TEXT "LIVING ROOM" → "LOUNGE"`. */
  label: string;
  /** Covers both the old and the new shape. */
  bounds: Bounds | null;
}

/**
 * One page of a comparison. Entities of added, removed and changed objects
 * carry `obj` = the index of their entry in `changes`, so the view can
 * highlight a change; unchanged entities carry none.
 */
export interface DiffPage {
  name: string;
  bounds: Bounds | null;
  unchanged: DxfEntity[];
  added: DxfEntity[];
  removed: DxfEntity[];
  changedOld: DxfEntity[];
  changedNew: DxfEntity[];
  changes: DiffChange[];
  /** The newer side's viewports, shown as context; their content is not compared. */
  viewports?: ViewportView[];
}

export interface DrawingDiff {
  oldLabel: string;
  newLabel: string;
  pages: DiffPage[];
  /** False when handles did not line up and objects were matched by their content. */
  handleMatching: boolean;
  warnings?: string[];
}
