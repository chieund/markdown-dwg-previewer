export type Point2D = { x: number; y: number };

interface EntityBase {
  layer: string;
  color: string;
  linetype?: string;
  lineweight?: number;
}

export type LineEntity = EntityBase & { type: 'LINE'; start: Point2D; end: Point2D };
export type CircleEntity = EntityBase & { type: 'CIRCLE'; center: Point2D; radius: number };
export type ArcEntity = EntityBase & {
  type: 'ARC';
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
};
export type PolylineEntity = EntityBase & {
  type: 'POLYLINE';
  points: Point2D[];
  closed: boolean;
  filled?: boolean;
};
export type PointEntity = EntityBase & { type: 'POINT'; position: Point2D };
export type HatchEntity = EntityBase & {
  type: 'HATCH';
  loops: Point2D[][];
  solid: boolean;
  patternAngle: number;
  patternSpacing: number;
};
export type TextEntity = EntityBase & {
  type: 'TEXT';
  position: Point2D;
  text: string;
  height: number;
  rotation: number;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
  fontFamily?: string;
};
export type DimensionEntity = EntityBase & {
  type: 'DIMENSION';
  textPosition: Point2D;
  text: string;
  height: number;
  linePoint1?: Point2D;
  linePoint2?: Point2D;
};

export type DxfEntity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity
  | PointEntity
  | HatchEntity
  | TextEntity
  | DimensionEntity;

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type LayerInfo = { name: string; color: string; entityCount: number };

export type ViewportView = {
  rect: { x: number; y: number; width: number; height: number };
  entities: DxfEntity[];
};

export type DxfPage = {
  name: string;
  entities: DxfEntity[];
  bounds: Bounds | null;
  layers: LayerInfo[];
  viewports?: ViewportView[];
};

export const SVG_NS = 'http://www.w3.org/2000/svg';

const DIMENSION_LINE_COLOR = '#808080';
const POINT_MARKER_SIZE = 4;

function applyStroke(el: SVGElement, color: string, linetype?: string, lineweight?: number): void {
  el.setAttribute('stroke', color);
  el.setAttribute('stroke-width', String(lineweight ?? 1));
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  el.setAttribute('fill', 'none');
  if (linetype) {
    el.setAttribute('stroke-dasharray', linetype);
  }
}

export function renderEntity(entity: DxfEntity): SVGElement | null {
  switch (entity.type) {
    case 'LINE': {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(entity.start.x));
      el.setAttribute('y1', String(entity.start.y));
      el.setAttribute('x2', String(entity.end.x));
      el.setAttribute('y2', String(entity.end.y));
      applyStroke(el, entity.color, entity.linetype, entity.lineweight);
      return el;
    }
    case 'CIRCLE': {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', String(entity.center.x));
      el.setAttribute('cy', String(entity.center.y));
      el.setAttribute('r', String(entity.radius));
      applyStroke(el, entity.color, entity.linetype, entity.lineweight);
      return el;
    }
    case 'ARC': {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', arcToPathData(entity.center, entity.radius, entity.startAngle, entity.endAngle));
      applyStroke(el, entity.color, entity.linetype, entity.lineweight);
      return el;
    }
    case 'POLYLINE': {
      const el = document.createElementNS(SVG_NS, entity.closed ? 'polygon' : 'polyline');
      el.setAttribute('points', entity.points.map((p) => `${p.x},${p.y}`).join(' '));
      applyStroke(el, entity.color, entity.linetype, entity.lineweight);
      if (entity.filled) el.setAttribute('fill', entity.color);
      return el;
    }

    case 'HATCH':
      return renderHatch(entity);

    case 'POINT': {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(entity.position.x));
      el.setAttribute('y1', String(entity.position.y));
      el.setAttribute('x2', String(entity.position.x));
      el.setAttribute('y2', String(entity.position.y));
      applyStroke(el, entity.color);
      el.setAttribute('stroke-width', String(POINT_MARKER_SIZE));
      el.setAttribute('stroke-linecap', 'round');
      return el;
    }
    case 'TEXT':
      return renderText(entity.position, entity.text, entity.height, entity.rotation, entity.color, entity.hAlign, entity.vAlign, entity.fontFamily);
    case 'DIMENSION': {
      const group = document.createElementNS(SVG_NS, 'g');
      if (entity.linePoint1 && entity.linePoint2) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(entity.linePoint1.x));
        line.setAttribute('y1', String(entity.linePoint1.y));
        line.setAttribute('x2', String(entity.linePoint2.x));
        line.setAttribute('y2', String(entity.linePoint2.y));
        applyStroke(line, DIMENSION_LINE_COLOR);
        line.setAttribute('stroke-dasharray', '4 2');
        group.appendChild(line);
      }
      if (entity.text) {
        const label = renderText(entity.textPosition, entity.text, entity.height, 0, entity.color);
        if (label) group.appendChild(label);
      }
      return group;
    }
    default:
      return null;
  }
}

let patternCounter = 0;

function renderHatch(entity: HatchEntity): SVGElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    entity.loops
      .map((loop) => `M ${loop.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`)
      .join(' ')
  );
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('stroke', 'none');

  if (entity.solid) {
    path.setAttribute('fill', entity.color);
    return path;
  }

  const group = document.createElementNS(SVG_NS, 'g');
  const id = `dwg-hatch-${patternCounter++}`;
  const spacing = Math.max(entity.patternSpacing, 1e-6);

  const defs = document.createElementNS(SVG_NS, 'defs');
  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', id);
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', String(spacing));
  pattern.setAttribute('height', String(spacing));
  pattern.setAttribute('patternTransform', `rotate(${-entity.patternAngle})`);

  const stroke = document.createElementNS(SVG_NS, 'line');
  stroke.setAttribute('x1', '0');
  stroke.setAttribute('y1', '0');
  stroke.setAttribute('x2', '0');
  stroke.setAttribute('y2', String(spacing));
  stroke.setAttribute('stroke', entity.color);
  stroke.setAttribute('stroke-width', '1');
  stroke.setAttribute('vector-effect', 'non-scaling-stroke');

  pattern.appendChild(stroke);
  defs.appendChild(pattern);
  path.setAttribute('fill', `url(#${id})`);

  group.appendChild(defs);
  group.appendChild(path);
  return group;
}

function renderText(
  position: Point2D,
  text: string,
  height: number,
  rotationDeg: number,
  color: string,
  hAlign?: 'left' | 'center' | 'right',
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top',
  fontFamily?: string
): SVGElement {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', '0');
  el.setAttribute('y', '0');
  el.setAttribute('font-size', String(height));
  el.setAttribute('fill', color);
  el.setAttribute('stroke', 'none');
  el.setAttribute('font-family', fontFamily || "Arial, 'Helvetica Neue', sans-serif");

  if (hAlign === 'center') el.setAttribute('text-anchor', 'middle');
  else if (hAlign === 'right') el.setAttribute('text-anchor', 'end');

  if (vAlign === 'top') el.setAttribute('dominant-baseline', 'text-before-edge');
  else if (vAlign === 'middle') el.setAttribute('dominant-baseline', 'central');
  else if (vAlign === 'bottom') el.setAttribute('dominant-baseline', 'text-after-edge');

  el.setAttribute('transform', `translate(${position.x} ${position.y}) scale(1,-1) rotate(${-rotationDeg})`);
  el.textContent = text;
  return el;
}

export function arcToPathData(center: Point2D, radius: number, startAngle: number, endAngle: number): string {
  const start = {
    x: center.x + radius * Math.cos(startAngle),
    y: center.y + radius * Math.sin(startAngle),
  };
  const end = {
    x: center.x + radius * Math.cos(endAngle),
    y: center.y + radius * Math.sin(endAngle),
  };

  let sweep = endAngle - startAngle;
  while (sweep < 0) sweep += 2 * Math.PI;
  const largeArcFlag = sweep > Math.PI ? 1 : 0;

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}
