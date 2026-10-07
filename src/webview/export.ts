import { ViewBox, getViewBox } from './panZoom';

const EXPORT_BACKGROUND = '#1e1e1e';
const PNG_MAX_EDGE = 2400;

/**
 * The rectangle to paint behind an exported view.
 *
 * Percentages would resolve from the user-space origin, not from the viewBox,
 * so a drawing away from (0,0) — nearly every real one — exported with no
 * background at all. Covering the viewBox itself, with a margin for viewers
 * that letterbox, always fills what is on screen.
 */
export function exportBackground(view: ViewBox): ViewBox {
  return { x: view.x - view.w, y: view.y - view.h, w: view.w * 3, h: view.h * 3 };
}

export function toStandaloneSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = pixelSize(svg);

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));
  clone.removeAttribute('style');
  // A selection is a viewing aid, not part of the drawing.
  clone.querySelectorAll('.dwg-highlight').forEach((group) => group.remove());
  clone.querySelectorAll('.dwg-dimmed').forEach((group) => group.classList.remove('dwg-dimmed'));

  const area = exportBackground(getViewBox(svg));
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', String(area.x));
  background.setAttribute('y', String(area.y));
  background.setAttribute('width', String(area.w));
  background.setAttribute('height', String(area.h));
  background.setAttribute('fill', EXPORT_BACKGROUND);
  clone.insertBefore(background, clone.firstChild);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

export async function toPngBase64(svg: SVGSVGElement): Promise<string> {
  const source = toStandaloneSvg(svg);
  const { width, height } = scaleToLimit(pixelSize(svg), PNG_MAX_EDGE);

  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to create canvas for PNG export.');
  context.fillStyle = EXPORT_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

function pixelSize(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  return { width: 1200, height: 800 };
}

function scaleToLimit(size: { width: number; height: number }, maxEdge: number) {
  const longest = Math.max(size.width, size.height);
  if (longest <= 0) return { width: maxEdge, height: maxEdge };
  const factor = maxEdge / longest;
  return { width: size.width * factor, height: size.height * factor };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to render image from SVG content.'));
    image.src = src;
  });
}
