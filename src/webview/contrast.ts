/**
 * Keeps dark drawing colours readable on the dark canvas.
 *
 * A CAD file is drawn for whatever background its author used: walls in dark
 * red or navy read well on white paper and vanish on #1e1e1e. Colours too
 * close to the canvas are lightened, keeping their hue, until they stand out.
 */

/** The canvas the viewer and its exports draw on (`--dwg-canvas`). */
export const CANVAS_COLOR = '#1e1e1e';

/** Contrast against the canvas a line needs to be picked out; WCAG asks 3:1 of graphics. */
const MIN_CONTRAST = 3;

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return undefined;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function luminance([r, g, b]: Rgb): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const CANVAS_LUMINANCE = luminance(parseHex(CANVAS_COLOR)!);

/** Contrast ratio of a colour against the canvas, 1 (same) to 21. */
export function contrastOnCanvas(rgb: Rgb): number {
  const l = luminance(rgb);
  return (Math.max(l, CANVAS_LUMINANCE) + 0.05) / (Math.min(l, CANVAS_LUMINANCE) + 0.05);
}

const toHex = (rgb: Rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const cache = new Map<string, string>();

/**
 * The colour to draw with: itself when it already stands out, otherwise the
 * same hue moved toward white just far enough. Anything that is not a hex
 * colour is returned as it is.
 */
export function legibleColor(color: string): string {
  const known = cache.get(color);
  if (known !== undefined) return known;
  let out = color;
  const rgb = parseHex(color);
  if (rgb && contrastOnCanvas(rgb) < MIN_CONTRAST) {
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const mixed = rgb.map((v) => v + (255 - v) * t) as Rgb;
      if (contrastOnCanvas(mixed) >= MIN_CONTRAST) {
        out = toHex(mixed);
        break;
      }
    }
  }
  cache.set(color, out);
  return out;
}
