export interface Point2D {
  x: number;
  y: number;
}

interface EntityBase {
  layer: string;
  /** CSS hex color, e.g. "#ff0000" — resolved from the entity's own color or its layer's default. */
  color: string;
  /** SVG stroke-dasharray value, e.g. "6 2 1 2". Omitted (or undefined) means solid/continuous. */
  linetype?: string;
  /** Stroke width in logical units (mapped from DXF lineweight). Omitted means default (1). */
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
  startAngle: number; // radians
  endAngle: number; // radians
}

export interface PolylineEntity extends EntityBase {
  type: 'POLYLINE';
  points: Point2D[];
  closed: boolean;
  /** Filled shapes (SOLID) paint their interior; outlines leave it transparent. */
  filled?: boolean;
}

export interface PointEntity extends EntityBase {
  type: 'POINT';
  position: Point2D;
}

export interface HatchEntity extends EntityBase {
  type: 'HATCH';
  /** Boundary loops; inner loops cut holes via the even-odd fill rule. */
  loops: Point2D[][];
  /** Solid fills paint flat; patterned ones get a line pattern approximation. */
  solid: boolean;
  /** Degrees, for the line pattern. */
  patternAngle: number;
  patternSpacing: number;
}

export interface TextEntity extends EntityBase {
  type: 'TEXT';
  position: Point2D;
  text: string;
  height: number;
  rotation: number; // degrees
  /** Horizontal alignment: 'left' | 'center' | 'right' (default 'left'). */
  hAlign?: 'left' | 'center' | 'right';
  /** Vertical alignment: 'baseline' | 'bottom' | 'middle' | 'top' (default 'baseline'). */
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
  /** CSS font-family resolved from the DXF text style. */
  fontFamily?: string;
}

/** Simplified rendering of DIMENSION: just the measurement label plus, when available, the line between the two measured points. Not a full extension-line/arrow reconstruction. */
export interface DimensionEntity extends EntityBase {
  type: 'DIMENSION';
  textPosition: Point2D;
  text: string;
  /** Label height in drawing units, scaled with whatever transform placed it. */
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

/** Model-space geometry shown through a window on a paper-space sheet. */
export interface ViewportView {
  /** The window on the sheet; content outside it is clipped away. */
  rect: { x: number; y: number; width: number; height: number };
  entities: DxfEntity[];
}

export interface DxfPage {
  name: string;
  entities: DxfEntity[];
  bounds: Bounds | null;
  /** Layers carrying geometry *on this page*, sorted by name. */
  layers: LayerInfo[];
  /** Populated for paper-space sheets that frame part of the model. */
  viewports?: ViewportView[];
}

export interface LayerInfo {
  name: string;
  /** Representative swatch color: the layer's own color when the table defines one. */
  color: string;
  /** How many drawable entities ended up on this layer. */
  entityCount: number;
}

export interface ParsedDxf {
  pages: DxfPage[];
  skippedEntityTypes: string[];
}
