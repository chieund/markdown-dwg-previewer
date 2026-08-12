/**
 * Re-export all types from the shared module.
 * This file exists for backward compatibility with imports in dxf/*.ts files.
 */
export {
  Point2D,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  PointEntity,
  HatchEntity,
  TextEntity,
  DimensionEntity,
  DxfEntity,
  Bounds,
  LayerInfo,
  ViewportView,
  DxfPage,
  ParsedDxf,
} from '../shared/types';
