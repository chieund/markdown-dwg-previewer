import { Matrix2D, multiply, rotate, scale, translate } from './matrix';

/**
 * A window from a paper-space sheet onto model space.
 *
 * dxf-parser has no VIEWPORT reader, so these are scanned from the raw file the
 * same way hatches are. Without them a layout renders as a title block around
 * an empty rectangle, because the drawing it frames lives in model space.
 */
export interface RawViewport {
  /** Which block holds it, or null when it sits in the ENTITIES section. */
  blockName: string | null;
  /** Rectangle occupied on the sheet, in paper units. */
  paper: { x: number; y: number; width: number; height: number };
  /** Centre of the view, relative to `target` (DXF stores it in display coordinates). */
  viewCenter: { x: number; y: number };
  /**
   * View target point (17/27). A view panned with the target rather than the
   * centre shows `target + viewCenter`; ignoring it framed empty model space.
   */
  target?: { x: number; y: number };
  /** Height of the model-space window, in drawing units. */
  viewHeight: number;
  /** View twist, in degrees. */
  twist: number;
  /** Layer handles frozen specifically in this viewport (group code 331). */
  frozenLayerHandles: string[];
}

export function scanViewports(text: string): RawViewport[] {
  const lines = text.split(/\r\n|\r|\n/);
  const viewports: RawViewport[] = [];

  let section: string | null = null;
  let blockName: string | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code !== '0') continue;

    if (value === 'SECTION') {
      section = lines[i + 3]?.trim() ?? null;
    } else if (value === 'ENDSEC') {
      section = null;
      blockName = null;
    } else if (value === 'BLOCK') {
      blockName = readValue(lines, i + 2, '2');
    } else if (value === 'ENDBLK') {
      blockName = null;
    } else if (value === 'VIEWPORT' && (section === 'ENTITIES' || section === 'BLOCKS')) {
      const viewport = parseViewport(lines, i + 2, section === 'BLOCKS' ? blockName : null);
      if (viewport) viewports.push(viewport);
    }
  }

  return viewports;
}

function readValue(lines: string[], from: number, code: string): string | null {
  for (let i = from; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === '0') return null;
    if (lines[i].trim() === code) return lines[i + 1].trim();
  }
  return null;
}

function parseViewport(lines: string[], from: number, blockName: string | null): RawViewport | null {
  const values = new Map<string, number>();
  const frozenLayerHandles: string[] = [];
  for (let i = from; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (code === '0') break;
    if (code === '331') {
      frozenLayerHandles.push(lines[i + 1].trim());
    } else if (!values.has(code)) {
      values.set(code, Number(lines[i + 1].trim()));
    }
  }

  const paperX = values.get('10');
  const paperY = values.get('20');
  const width = values.get('40');
  const height = values.get('41');
  const viewX = values.get('12');
  const viewY = values.get('22');
  const viewHeight = values.get('45');

  if ([paperX, paperY, width, height, viewX, viewY, viewHeight].some((n) => !Number.isFinite(n))) {
    return null;
  }
  if (width! <= 0 || height! <= 0 || viewHeight! <= 0) return null;

  // Every layout also carries a pseudo-viewport standing for the sheet itself:
  // it shows the paper at 1:1, so its view centre and height equal the paper's.
  // Rendering model space through that would paste the drawing over the sheet.
  const showsThePaperItself =
    Math.abs(viewX! - paperX!) < 1e-6 &&
    Math.abs(viewY! - paperY!) < 1e-6 &&
    Math.abs(viewHeight! - height!) < 1e-6;
  if (showsThePaperItself) return null;

  return {
    blockName,
    paper: { x: paperX!, y: paperY!, width: width!, height: height! },
    viewCenter: { x: viewX!, y: viewY! },
    target: { x: values.get('17') ?? 0, y: values.get('27') ?? 0 },
    viewHeight: viewHeight!,
    twist: values.get('51') ?? 0,
    frozenLayerHandles,
  };
}

/**
 * Transform taking model-space coordinates into their place on the sheet.
 *
 * The viewport shows a `viewHeight`-tall slice of the model, centred on
 * `target + viewCenter`, inside a rectangle `paper.height` tall — so the scale is the
 * ratio between the two, and the view centre lands on the rectangle's centre.
 */
export function viewportTransform(viewport: RawViewport): Matrix2D {
  const factor = viewport.paper.height / viewport.viewHeight;
  return multiply(
    translate(viewport.paper.x, viewport.paper.y),
    multiply(
      scale(factor, factor),
      multiply(
        rotate((-viewport.twist * Math.PI) / 180),
        translate(
          -(viewport.viewCenter.x + (viewport.target?.x ?? 0)),
          -(viewport.viewCenter.y + (viewport.target?.y ?? 0))
        )
      )
    )
  );
}
