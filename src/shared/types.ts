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

export interface ParsedDxf {
  pages: DxfPage[];
  skippedEntityTypes: string[];
}
