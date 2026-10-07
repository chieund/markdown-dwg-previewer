import type { Bounds, DxfEntity, Point2D, TextEntity } from './types';

/**
 * Bounding boxes of drawn entities. Shared by the parser (page bounds,
 * viewport culling) and the webview (zooming to a search result), so both
 * agree on how much room a piece of text takes.
 */

/** Rough advance width of a glyph relative to the font size, for sans-serif text. */
const GLYPH_WIDTH_RATIO = 0.6;
/** Distance between MTEXT baselines in text heights; matches the renderer. */
const LINE_SPACING = 5 / 3;
/** Descenders reach this far below the baseline, in text heights. */
const DESCENT = 0.25;

/**
 * Corners of the box a text entity occupies, in drawing coordinates.
 *
 * The width is estimated from the character count, which is approximate but
 * far closer than treating text as a zero-size point. The box follows the
 * alignment the renderer uses: right-aligned text runs back from its anchor,
 * and extra MTEXT lines run downward. Viewports cull on this box, so getting
 * the side wrong drops text that reaches into the window.
 */
export function textBoxCorners(e: TextEntity): Point2D[] {
  const lines = e.text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const width = longest * e.height * GLYPH_WIDTH_RATIO;
  const block = e.height * (1 + (lines.length - 1) * LINE_SPACING);

  const left = e.hAlign === 'right' ? -width : e.hAlign === 'center' ? -width / 2 : 0;
  let bottom: number;
  switch (e.vAlign) {
    case 'top': bottom = -block; break;
    case 'middle': bottom = -block / 2; break;
    case 'bottom': bottom = 0; break;
    default: bottom = -(block - e.height) - e.height * DESCENT; // baseline of the first line
  }
  const top = e.vAlign === undefined || e.vAlign === 'baseline' ? e.height : bottom + block;

  const radians = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return [
    { x: left, y: bottom },
    { x: left + width, y: bottom },
    { x: left + width, y: top },
    { x: left, y: top },
  ].map((corner) => ({
    x: e.position.x + corner.x * cos - corner.y * sin,
    y: e.position.y + corner.x * sin + corner.y * cos,
  }));
}

export function computeBounds(entities: DxfEntity[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const consider = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const e of entities) {
    switch (e.type) {
      case 'LINE':
        consider(e.start.x, e.start.y);
        consider(e.end.x, e.end.y);
        break;
      case 'CIRCLE':
      case 'ARC':
        consider(e.center.x - e.radius, e.center.y - e.radius);
        consider(e.center.x + e.radius, e.center.y + e.radius);
        break;
      case 'POLYLINE':
        for (const p of e.points) consider(p.x, p.y);
        break;
      case 'HATCH':
        for (const loop of e.loops) for (const p of loop) consider(p.x, p.y);
        break;
      case 'POINT':
        consider(e.position.x, e.position.y);
        break;
      case 'TEXT':
        for (const corner of textBoxCorners(e)) consider(corner.x, corner.y);
        break;
      case 'DIMENSION':
        consider(e.textPosition.x, e.textPosition.y);
        if (e.linePoint1) consider(e.linePoint1.x, e.linePoint1.y);
        if (e.linePoint2) consider(e.linePoint2.x, e.linePoint2.y);
        break;
    }
  }

  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}
