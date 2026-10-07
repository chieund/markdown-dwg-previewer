import DxfParser, {
  I3DfaceEntity,
  IArcEntity,
  IBlock,
  ICircleEntity,
  IDimensionEntity,
  IEllipseEntity,
  IEntity,
  IInsertEntity,
  ILayer,
  ILineEntity,
  ILwpolylineEntity,
  IMtextEntity,
  IPointEntity,
  IPolylineEntity,
  ISolidEntity,
  ISplineEntity,
  ITextEntity,
} from 'dxf-parser';
import {
  IDENTITY,
  Matrix2D,
  applyToPoint,
  determinant,
  extrusionMatrix,
  isSimilarity,
  multiply,
  rotate,
  rotationAngle,
  scale,
  similarityScale,
  translate,
} from './matrix';
import AUTO_CAD_COLOR_INDEX from 'dxf-parser/dist/AutoCadColorIndex';
import { expandBulges } from './bulge';
import { EntityExtras, Vector3D, scanEntityExtras } from './extras';
import { scanHatches } from './hatch';
import { RawViewport, scanViewports, viewportTransform } from './viewport';
import { sampleSpline } from './spline';
import {
  Bounds,
  DxfEntity,
  DxfPage,
  LayerInfo,
  ParsedDxf,
  Point2D,
  TextEntity,
  ViewportView,
} from './types';

const FALLBACK_COLOR = '#d4d4d4';

/**
 * Types we deliberately draw nothing for, so they must not be reported as
 * unsupported. ATTDEF is an attribute *template* living in a block definition;
 * CAD software renders the ATTRIB values attached to an INSERT, never the
 * ATTDEF itself.
 */
const INTENTIONALLY_NOT_DRAWN = new Set(['ATTDEF', 'ATTRIB', 'SEQEND', 'VERTEX']);

/** Blocks can reference other blocks; this bounds the recursion in case a file contains a cycle. */
const MAX_BLOCK_DEPTH = 16;

const CIRCLE_SAMPLE_SEGMENTS = 64;

/**
 * Most entities one parse may produce. INSERT arrays multiply (rows × columns,
 * nested), so a 200-byte file can otherwise ask for a billion entities and take
 * the whole extension host down with it. The largest real drawing in the corpus
 * has under 40k.
 */
export const MAX_ENTITIES = 500_000;

/**
 * Fallback label height for DIMENSION, in drawing units.
 *
 * The real height lives in the DIMSTYLE table, which dxf-parser does not
 * expose. Whatever it is, it must scale with the transform that places the
 * entity: a fixed height is unnoticeable on a 4000-unit model and enormous once
 * that model is squeezed into a 36-unit sheet through a viewport.
 */
const DIMENSION_TEXT_HEIGHT = 2.5;

interface ParseContext {
  layers: Record<string, ILayer>;
  blocks: Record<string, IBlock>;
  skippedEntityTypes: Set<string>;
  /** LTYPE table: linetype name → dash pattern (positive = dash, negative = gap, 0 = dot). */
  lineTypes: Record<string, number[]>;
  /** Layer name → linetype name, scanned from raw text (dxf-parser drops this). */
  layerLineTypes: Record<string, string>;
  /** Layer handle → layer name, for resolving per-viewport frozen layer references. */
  layerHandleMap: Record<string, string>;
  /** Text style name → CSS font-family, resolved from STYLE table font filenames. */
  textStyles: Record<string, string>;
  /** Extrusion, text style and file position per entity handle. */
  extras: EntityExtras;
  trustLayerOffFlags: boolean;
  maxEntities: number;
  /**
   * While collecting for a viewport: which entities it can show. Applied before
   * counting, so model geometry outside the window never uses up the budget.
   */
  keep: ((entity: DxfEntity) => boolean) | null;
  /** Entities produced so far, checked against maxEntities. */
  emitted: number;
  limitReached: boolean;
}

/**
 * Converts a DXF linetype pattern (array of dash lengths: positive = dash,
 * negative = gap, 0 = dot) into an SVG `stroke-dasharray` string.
 *
 * The values are in drawing units. Since we use `vector-effect: non-scaling-stroke`,
 * we multiply by a fixed factor to get reasonable pixel sizes.
 */
function patternToDashArray(pattern: number[], lineTypeScale: number): string | undefined {
  if (!pattern || pattern.length === 0) return undefined;
  // A single-element pattern of [0] is the dot linetype — translate to tiny dash + gap.
  const SCALE = 4; // base multiplier so patterns are visible on screen
  const parts: number[] = [];
  for (const value of pattern) {
    if (value === 0) {
      // Dot: render as a very short dash
      parts.push(0.5 * SCALE * lineTypeScale);
    } else {
      parts.push(Math.abs(value) * SCALE * lineTypeScale);
    }
  }
  // SVG stroke-dasharray alternates dash/gap; DXF pattern starts with a dash.
  // If the pattern has odd length, double it so SVG renders correctly.
  if (parts.length % 2 !== 0) parts.push(...parts);
  return parts.join(' ');
}

/**
 * Scans layer→linetype assignments from the raw DXF text.
 *
 * dxf-parser reads layer name (code 2), color (code 62), and frozen flag (code 70)
 * but ignores code 6 (linetype name). We need this to resolve BYLAYER linetypes.
 */
function scanLayerLineTypes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r\n|\r|\n/);
  let inLayerTable = false;
  let currentLayerName: string | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    // Detect LAYER table
    if (code === '0' && value === 'TABLE') {
      const nextCode = lines[i + 2]?.trim();
      const nextValue = lines[i + 3]?.trim();
      if (nextCode === '2' && nextValue === 'LAYER') {
        inLayerTable = true;
      }
    } else if (code === '0' && value === 'ENDTAB') {
      if (inLayerTable) break;
    } else if (inLayerTable) {
      if (code === '0' && value === 'LAYER') {
        currentLayerName = null;
      } else if (code === '2' && currentLayerName === null) {
        currentLayerName = value;
      } else if (code === '6' && currentLayerName !== null) {
        result[currentLayerName] = value;
      }
    }
  }

  return result;
}

/**
 * Scans layer handle → name mappings from the raw LAYER table.
 *
 * Per-viewport frozen layers are stored as handles (group code 331 in VIEWPORT
 * entities). We need to resolve these handles back to layer names to filter
 * entities during viewport rendering.
 */
function scanLayerHandles(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r\n|\r|\n/);
  let inLayerTable = false;
  let currentHandle: string | null = null;
  let currentName: string | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '0' && value === 'TABLE') {
      const nextCode = lines[i + 2]?.trim();
      const nextValue = lines[i + 3]?.trim();
      if (nextCode === '2' && nextValue === 'LAYER') {
        inLayerTable = true;
      }
    } else if (code === '0' && value === 'ENDTAB') {
      if (inLayerTable) break;
    } else if (inLayerTable) {
      if (code === '0' && value === 'LAYER') {
        if (currentHandle && currentName) {
          result[currentHandle] = currentName;
        }
        currentHandle = null;
        currentName = null;
      } else if (code === '5') {
        currentHandle = value;
      } else if (code === '2') {
        currentName = value;
      }
    }
  }
  // Last layer
  if (currentHandle && currentName) {
    result[currentHandle] = currentName;
  }

  return result;
}

/**
 * Maps DXF font filenames to CSS font-family values.
 *
 * SHX fonts are AutoCAD's native vector fonts — they don't exist as web fonts,
 * so we map them to the closest visual match. TTF font names pass through
 * with a sans-serif fallback.
 */
const DXF_FONT_MAP: Record<string, string> = {
  // SHX fonts → CSS equivalents
  'romans': "'Courier New', monospace",
  'romans.shx': "'Courier New', monospace",
  'romand': "'Times New Roman', serif",
  'romand.shx': "'Times New Roman', serif",
  'romanc': "'Times New Roman', serif",
  'romanc.shx': "'Times New Roman', serif",
  'romant': "'Times New Roman', serif",
  'romant.shx': "'Times New Roman', serif",
  'simplex': "'Courier New', monospace",
  'simplex.shx': "'Courier New', monospace",
  'complex': "'Times New Roman', serif",
  'complex.shx': "'Times New Roman', serif",
  'isocp': "'Arial Narrow', Arial, sans-serif",
  'isocp.shx': "'Arial Narrow', Arial, sans-serif",
  'isocpeur': "'Arial Narrow', Arial, sans-serif",
  'isocpeur.shx': "'Arial Narrow', Arial, sans-serif",
  'italic': "'Times New Roman', serif",
  'italic.shx': "'Times New Roman', serif",
  'gothice': "Arial, sans-serif",
  'gothice.shx': "Arial, sans-serif",
  'gothicg': "Arial, sans-serif",
  'gothicg.shx': "Arial, sans-serif",
  'gothici': "Arial, sans-serif",
  'gothici.shx': "Arial, sans-serif",
  'txt': "'Courier New', monospace",
  'txt.shx': "'Courier New', monospace",
  'monotxt': "'Courier New', monospace",
  'monotxt.shx': "'Courier New', monospace",
  'architxt': "Arial, sans-serif",
  'architxt.shx': "Arial, sans-serif",
  'archtitl': "'Arial Black', Arial, sans-serif",
  'archtitl.shx': "'Arial Black', Arial, sans-serif",
  'hztxt.shx': "'Microsoft YaHei', 'Noto Sans CJK', sans-serif",
  // TTF fonts
  'arial.ttf': "Arial, 'Helvetica Neue', sans-serif",
  'arial': "Arial, 'Helvetica Neue', sans-serif",
  'times.ttf': "'Times New Roman', serif",
  'times new roman': "'Times New Roman', serif",
  'courier.ttf': "'Courier New', monospace",
  'courier new': "'Courier New', monospace",
};

/** Default font-family when no style or unknown font is specified. */
const DEFAULT_FONT_FAMILY = "Arial, 'Helvetica Neue', sans-serif";

/**
 * Scans the STYLE table to build a style name → CSS font-family map.
 *
 * DXF text entities reference a style name (group code 7); the style table
 * maps that name to a font filename (group code 3). We resolve the filename
 * to a CSS font-family for use in the SVG renderer.
 */
function scanTextStyles(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r\n|\r|\n/);
  let inStyleTable = false;
  let styleName: string | null = null;
  let fontFile: string | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '0' && value === 'TABLE') {
      const nextCode = lines[i + 2]?.trim();
      const nextValue = lines[i + 3]?.trim();
      if (nextCode === '2' && nextValue === 'STYLE') {
        inStyleTable = true;
      }
    } else if (code === '0' && value === 'ENDTAB') {
      if (inStyleTable) {
        // Save last style
        if (styleName) result[styleName.toUpperCase()] = resolveDxfFont(fontFile);
        break;
      }
    } else if (inStyleTable) {
      if (code === '0' && value === 'STYLE') {
        // Save previous style
        if (styleName) result[styleName.toUpperCase()] = resolveDxfFont(fontFile);
        styleName = null;
        fontFile = null;
      } else if (code === '2') {
        styleName = value;
      } else if (code === '3') {
        fontFile = value;
      }
    }
  }

  return result;
}

function resolveDxfFont(fontFile: string | null): string {
  if (!fontFile) return DEFAULT_FONT_FAMILY;
  const key = fontFile.toLowerCase();
  return DXF_FONT_MAP[key] ?? DEFAULT_FONT_FAMILY;
}

interface RawAttrib {
  layer: string;
  style?: string;
  position: Point2D;
  text: string;
  height: number;
  rotation: number;
  inPaperSpace: boolean;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
}

/**
 * Scans ATTRIB entities from the raw DXF text.
 *
 * ATTRIBs are text labels attached to INSERT entities — they carry labels like
 * room numbers, part IDs, door tags. dxf-parser has no ATTRIB handler and drops
 * them. Their positions are already in world coordinates (the CAD software
 * writes them already transformed by the INSERT's placement).
 */
function scanAttribs(text: string): RawAttrib[] {
  const lines = text.split(/\r\n|\r|\n/);
  const attribs: RawAttrib[] = [];

  let section: string | null = null;
  let inPaperSpace = false;
  let insertLayer = '0';

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '0') {
      if (value === 'SECTION') {
        section = lines[i + 3]?.trim() ?? null;
      } else if (value === 'ENDSEC') {
        section = null;
      } else if (value === 'INSERT' && section === 'ENTITIES') {
        // Track the INSERT's paper-space flag and layer for ATTRIB inheritance
        inPaperSpace = false;
        insertLayer = '0';
        for (let j = i + 2; j + 1 < lines.length && lines[j].trim() !== '0'; j += 2) {
          const c = lines[j].trim();
          const v = lines[j + 1].trim();
          if (c === '67' && v === '1') inPaperSpace = true;
          if (c === '8') insertLayer = v;
        }
      } else if (value === 'ATTRIB' && section === 'ENTITIES') {
        const attrib = parseAttrib(lines, i + 2, inPaperSpace, insertLayer);
        if (attrib) attribs.push(attrib);
      }
    }
  }

  return attribs;
}

function parseAttrib(lines: string[], from: number, inPaperSpace: boolean, insertLayer: string): RawAttrib | null {
  let layer = '0';
  let x = 0, y = 0;
  let height = 1;
  let textValue = '';
  let rotation = 0;
  let halign = 0;
  let valign = 0;
  let flags = 0;
  let style: string | undefined;
  let ax: number | undefined, ay: number | undefined;

  for (let i = from; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === '0') break;

    switch (code) {
      case '8': layer = value; break;
      case '10': x = Number(value); break;
      case '20': y = Number(value); break;
      case '11': ax = Number(value); break;
      case '21': ay = Number(value); break;
      case '40': height = Number(value) || 1; break;
      case '1': textValue = value; break;
      case '50': rotation = Number(value) || 0; break;
      case '72': halign = Number(value) || 0; break;
      case '74': valign = Number(value) || 0; break;
      case '70': flags = Number(value) || 0; break;
      case '7': style = value; break;
    }
  }

  // Flag bit 1: an invisible attribute, kept in the file but never drawn.
  if (!textValue || flags & 1) return null;

  // Layer 0 ATTRIBs inherit the layer of their parent INSERT, just like
  // block content on layer 0 inherits from the INSERT that places it.
  if (layer === '0' && insertLayer !== '0') layer = insertLayer;

  const position =
    usesAlignmentPoint(halign, valign) && ax !== undefined && ay !== undefined ? { x: ax, y: ay } : { x, y };

  return {
    layer,
    style,
    position,
    text: decodeTextValue(textValue),
    height,
    rotation,
    inPaperSpace,
    hAlign: textHAlign(halign),
    vAlign: textVAlign(valign, halign),
  };
}

/** Pulls linetype patterns from the parsed DXF tables. */
function extractLineTypes(dxf: ReturnType<DxfParser['parseSync']>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  const ltypes = (dxf?.tables as any)?.lineType?.lineTypes;
  if (!ltypes) return result;
  for (const [name, ltype] of Object.entries(ltypes) as [string, any][]) {
    if (ltype.pattern && ltype.pattern.length > 0) {
      result[name.toUpperCase()] = ltype.pattern;
    }
  }
  return result;
}

export interface ParseOptions {
  /**
   * Honour layer on/off (a negative layer colour). Off for DWGs converted by
   * libredwg, which writes every layer's colour negative — trusting it would
   * open every drawing with all layers hidden.
   */
  trustLayerOffFlags?: boolean;
  /** Overrides MAX_ENTITIES. */
  maxEntities?: number;
}

export function parseDxf(text: string, options: ParseOptions = {}): ParsedDxf {
  const dxf = parseWithRecovery(text);
  const extras = scanEntityExtras(text);
  injectHatches(text, dxf, extras);

  const context: ParseContext = {
    layers: dxf?.tables?.layer?.layers ?? {},
    blocks: dxf?.blocks ?? {},
    skippedEntityTypes: new Set<string>(),
    lineTypes: extractLineTypes(dxf),
    layerLineTypes: scanLayerLineTypes(text),
    layerHandleMap: scanLayerHandles(text),
    textStyles: scanTextStyles(text),
    extras,
    trustLayerOffFlags: options.trustLayerOffFlags ?? true,
    maxEntities: options.maxEntities ?? MAX_ENTITIES,
    keep: null,
    emitted: 0,
    limitReached: false,
  };

  const modelEntities: DxfEntity[] = [];
  const paperEntities: DxfEntity[] = [];

  for (const raw of dxf?.entities ?? []) {
    const target = raw.inPaperSpace ? paperEntities : modelEntities;
    collectEntity(raw, context, IDENTITY, null, 0, target);
  }

  // ATTRIBs are text labels attached to INSERTs. dxf-parser has no ATTRIB
  // handler, so they are scanned from the raw file and added as text entities.
  // Their positions are already in world coordinates.
  for (const attrib of scanAttribs(text)) {
    const color = layerColor(attrib.layer, context) ?? FALLBACK_COLOR;
    const entity: TextEntity = {
      type: 'TEXT',
      layer: attrib.layer,
      color,
      position: attrib.position,
      text: attrib.text,
      height: attrib.height,
      rotation: attrib.rotation,
      hAlign: attrib.hAlign,
      vAlign: attrib.vAlign,
    };
    const font = attrib.style ? context.textStyles[attrib.style.toUpperCase()] : undefined;
    if (font) entity.fontFamily = font;
    const target = attrib.inPaperSpace ? paperEntities : modelEntities;
    target.push(entity);
  }

  const rawModelEntities = (dxf?.entities ?? []).filter((e) => !e.inPaperSpace);
  const viewports = scanViewports(text);

  const buildPage = (name: string, entities: DxfEntity[]): DxfPage => ({
    name,
    entities,
    bounds: computeBounds(entities),
    layers: collectLayers(entities, context),
  });

  /** Paper sheets additionally frame part of the model through their viewports. */
  const buildSheet = (name: string, entities: DxfEntity[], layoutBlock: string | null): DxfPage => {
    const views = buildViewports(viewports, layoutBlock, rawModelEntities, context);
    const page = buildPage(name, entities);
    return views.length > 0 ? { ...page, viewports: views } : page;
  };

  const pages: DxfPage[] = [buildPage('Model Space', modelEntities)];
  if (paperEntities.length > 0) {
    pages.push(buildSheet('Paper Space', paperEntities, null));
  }
  const alreadyDrawn = new Set(
    (dxf?.entities ?? []).map((e) => e.handle).filter((handle) => handle !== undefined)
  );
  for (const [name, blockName, entities] of extraLayouts(context, alreadyDrawn)) {
    const collected: DxfEntity[] = [];
    for (const raw of entities) collectEntity(raw, context, IDENTITY, null, 0, collected);
    if (collected.length > 0) pages.push(buildSheet(name, collected, blockName));
  }

  const result: ParsedDxf = { pages, skippedEntityTypes: Array.from(context.skippedEntityTypes) };
  if (context.limitReached) {
    result.warnings = [
      `Drawing cut short: it expands to more than ${context.maxEntities.toLocaleString('en-US')} objects (the limit), ` +
        'usually because of a huge block array.',
    ];
  }
  return result;
}

/**
 * Renders model space through each of a sheet's viewports.
 *
 * A layout is a title block wrapped around windows onto the model; without this
 * the sheet draws its border and legend around empty rectangles. Model entities
 * are re-collected through the viewport's transform rather than transforming
 * already-built ones, so text heights, arc sweeps and block expansion all scale
 * correctly instead of being patched up afterwards.
 */
function buildViewports(
  viewports: RawViewport[],
  layoutBlock: string | null,
  rawModelEntities: IEntity[],
  context: ParseContext
): ViewportView[] {
  const views: ViewportView[] = [];

  for (const viewport of viewports) {
    if ((viewport.blockName ?? null) !== layoutBlock) continue;

    // Resolve per-viewport frozen layer handles to names
    const frozenLayers = new Set(
      viewport.frozenLayerHandles
        .map((handle) => context.layerHandleMap[handle])
        .filter((name): name is string => !!name)
    );

    const rect = {
      x: viewport.paper.x - viewport.paper.width / 2,
      y: viewport.paper.y - viewport.paper.height / 2,
      width: viewport.paper.width,
      height: viewport.paper.height,
    };

    // Keep what this viewport can actually show: not on a layer frozen in it,
    // and touching its window. Each viewport re-collects the whole model, so
    // without the window test a sheet of detail views carries the full model
    // once per viewport.
    const transform = viewportTransform(viewport);
    const visible: DxfEntity[] = [];
    context.keep = (e) => !frozenLayers.has(e.layer) && overlaps(computeBounds([e]), rect);
    try {
      for (const raw of rawModelEntities) {
        collectEntity(raw, context, transform, null, 0, visible);
      }
    } finally {
      context.keep = null;
    }
    if (visible.length === 0) continue;

    views.push({ rect, entities: visible });
  }

  return views;
}

function overlaps(bounds: Bounds | null, rect: { x: number; y: number; width: number; height: number }): boolean {
  if (!bounds) return false;
  return (
    bounds.maxX >= rect.x &&
    bounds.minX <= rect.x + rect.width &&
    bounds.maxY >= rect.y &&
    bounds.minY <= rect.y + rect.height
  );
}

/**
 * Paper-space layouts held in block records rather than the ENTITIES section.
 *
 * A drawing can carry several sheets. Each lives in a `*Paper_Space<n>` block
 * that nothing ever inserts, so it renders nowhere unless picked up here.
 *
 * The catch is that the *active* layout is stored twice — once in its block
 * record and again in the ENTITIES section flagged with group code 67. Adding
 * it back would show the same sheet as two identical pages, so any layout whose
 * entities have already been drawn is skipped, matched on entity handles.
 *
 * Real layout names live in the OBJECTS section, which dxf-parser does not
 * expose, so sheets are numbered instead.
 */
function extraLayouts(
  context: ParseContext,
  alreadyDrawn: Set<unknown>
): [string, string, IEntity[]][] {
  const pending = Object.keys(context.blocks)
    .filter((name) => /^\*paper_space.+/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name): [string, IEntity[]] => [name, context.blocks[name].entities ?? []])
    .filter(
      ([, entities]) =>
        entities.length > 0 && !entities.some((e) => alreadyDrawn.has(e.handle))
    );

  return pending.map(([blockName, entities], index): [string, string, IEntity[]] => [
    `Paper Space ${index + 2}`,
    blockName,
    entities,
  ]);
}

/**
 * Lists the layers carrying geometry on one page.
 *
 * Layers are counted per page, not per drawing: in the AEC sample every entity
 * on layer 0 lives in paper space, so offering a layer 0 switch while model
 * space is on screen would give the user a control that does nothing.
 *
 * Layers defined in the table but never drawn on are left out too — a drawing
 * with 24 declared layers and 8 used ones should offer 8 switches, not 24.
 *
 * The layer table's frozen flag is deliberately ignored. dxf-parser sets it for
 * flag bit 2 as well as bit 1, but bit 2 means "frozen in new viewports", not
 * "hidden here" — honouring it would hide the walls of a drawing that shows
 * them fine in CAD software.
 */
function collectLayers(entities: DxfEntity[], context: ParseContext): LayerInfo[] {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    counts.set(entity.layer, (counts.get(entity.layer) ?? 0) + 1);
  }

  return Array.from(counts, ([name, entityCount]): LayerInfo => {
    const info: LayerInfo = { name, color: layerColor(name, context) ?? FALLBACK_COLOR, entityCount };
    // A negative colour in the layer table means the layer is switched off.
    if (context.trustLayerOffFlags && context.layers[name]?.visible === false) info.off = true;
    return info;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Feeds HATCH entities back into the parsed drawing.
 *
 * dxf-parser has no HATCH reader and drops them silently, so they are scanned
 * out of the raw text separately. Splicing them into the entity lists — the
 * top-level one, or the block that holds them — means block expansion, layer
 * inheritance, colour resolution and transforms all apply as they would to any
 * other entity, rather than needing a parallel path.
 */
function injectHatches(
  text: string,
  dxf: ReturnType<DxfParser['parseSync']>,
  extras: EntityExtras
): void {
  if (!dxf) return;

  const pending = new Map<IEntity[], IEntity[]>();
  for (const hatch of scanHatches(text)) {
    const pseudoEntity = {
      type: 'HATCH',
      handle: hatch.handle,
      extrusionDirection: hatch.extrusion,
      layer: hatch.layer,
      colorIndex: hatch.colorIndex,
      color: hatch.colorIndex !== undefined ? aciToTrueColor(hatch.colorIndex) : undefined,
      inPaperSpace: hatch.inPaperSpace,
      loops: hatch.loops,
      solid: hatch.solid,
      patternAngle: hatch.patternAngle,
      patternScale: hatch.patternScale,
    } as unknown as IEntity;

    const list = hatch.blockName ? dxf.blocks?.[hatch.blockName]?.entities : dxf.entities;
    if (!list) continue;
    if (!pending.has(list)) pending.set(list, []);
    pending.get(list)!.push(pseudoEntity);
  }

  for (const [list, hatches] of pending) mergeInFileOrder(list, hatches, extras);
}

/**
 * Puts hatches back where the file had them. Draw order matters for fills: a
 * solid hatch appended at the end would paint over the text and linework the
 * file drew on top of it. Both lists are already in file order, so one merge
 * pass places them all. Without handles there is no order to go by, and the
 * hatches are appended.
 */
function mergeInFileOrder(list: IEntity[], hatches: IEntity[], extras: EntityExtras): void {
  const position = (entity: IEntity) =>
    entity.handle !== undefined ? extras.ordinal.get(String(entity.handle)) : undefined;

  const merged: IEntity[] = [];
  let next = 0;
  for (const entity of list) {
    const at = position(entity);
    if (at !== undefined) {
      while (next < hatches.length && (position(hatches[next]) ?? Infinity) < at) {
        merged.push(hatches[next++]);
      }
    }
    merged.push(entity);
  }
  while (next < hatches.length) merged.push(hatches[next++]);

  list.length = 0;
  for (const entity of merged) list.push(entity);
}

function aciToTrueColor(index: number): number | undefined {
  return AUTO_CAD_COLOR_INDEX[Math.abs(index)];
}

/**
 * Parses the file, retrying once on sanitized input if the first attempt fails.
 *
 * dxf-parser insists group codes 290-299 hold only "0" or "1" and throws on
 * anything else. Real files break that assumption — AutoCAD writes
 * `$XCLIPFRAME = 2`, for instance — and the throw kills the whole parse over a
 * header variable we never read. Rewriting those flags lets such files load.
 */
function parseWithRecovery(text: string): ReturnType<DxfParser['parseSync']> {
  try {
    return new DxfParser().parseSync(text);
  } catch (firstError) {
    const sanitized = sanitizeBooleanFlags(text);
    if (sanitized === text) throw firstError;
    return new DxfParser().parseSync(sanitized);
  }
}

function sanitizeBooleanFlags(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let changed = false;
  // DXF alternates group-code and value lines, so codes sit at even indices.
  // Walking in pairs avoids mistaking a *value* of e.g. "290" for a code.
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (code < 290 || code > 299) continue;
    const value = lines[i + 1].trim();
    if (value === '0' || value === '1') continue;
    lines[i + 1] = Number(value) ? '1' : '0';
    changed = true;
  }
  return changed ? lines.join('\n') : text;
}

/**
 * Maps one raw entity into zero or more renderable entities, applying `transform`
 * (the accumulated block-insertion transform) to its geometry. INSERT entities
 * recurse into their block definition rather than producing geometry directly.
 */
function collectEntity(
  raw: IEntity,
  context: ParseContext,
  transform: Matrix2D,
  host: BlockHost | null,
  depth: number,
  out: DxfEntity[]
): void {
  if (context.limitReached) return;
  // Group 60 = 1 marks an entity invisible; CAD software does not draw it.
  if ((raw as IEntity & { visible?: boolean }).visible === false) return;

  const layer = resolveLayer(raw, host);
  const color = resolveColor(raw, layer, context, host?.color ?? null);

  if (raw.type === 'INSERT') {
    expandInsert(raw as IInsertEntity, context, transform, { layer, color }, depth, out);
    return;
  }

  const linetype = resolveLinetype(raw, layer, context);
  const lineweight = resolveLineweight(raw, layer, context);

  // mapEntity records anything it doesn't recognise in skippedEntityTypes; a
  // recognised type yielding nothing (an empty TEXT, say) is not a gap.
  const entities = mapEntity(raw, layer, color, transform, context);
  for (const entity of entities) {
    if (context.keep && !context.keep(entity)) continue;
    if (context.emitted >= context.maxEntities) {
      context.limitReached = true;
      return;
    }
    if (linetype) entity.linetype = linetype;
    if (lineweight !== undefined) entity.lineweight = lineweight;
    out.push(entity);
    context.emitted++;
  }
}

/** The layer and color an INSERT passes down to the geometry inside its block. */
interface BlockHost {
  layer: string;
  color: string;
}

/**
 * Layer 0 is special inside a block: geometry drawn there adopts the layer of
 * the INSERT that places it, which is exactly why draftsmen build blocks on
 * layer 0. Attributing it to "0" instead lumped unrelated symbols together —
 * in the AEC sample that inflated layer 0 to 1838 entities against 60 actually
 * drawn on it, so hiding "FURNITURE" left the furniture on screen.
 */
function resolveLayer(raw: IEntity, host: BlockHost | null): string {
  const layer = raw.layer ?? '0';
  if (host && layer === '0') return host.layer;
  return layer;
}

function expandInsert(
  insert: IInsertEntity,
  context: ParseContext,
  transform: Matrix2D,
  host: BlockHost,
  depth: number,
  out: DxfEntity[]
): void {
  if (depth >= MAX_BLOCK_DEPTH) return;

  const block = context.blocks[insert.name];
  if (!block?.entities?.length) return;

  const basePoint = block.position ?? { x: 0, y: 0 };
  const sx = insert.xScale ?? 1;
  const sy = insert.yScale ?? 1;
  const rotationRad = ((insert.rotation ?? 0) * Math.PI) / 180;

  // An INSERT may lay its block out as a grid of copies.
  const columns = Math.max(1, insert.columnCount ?? 1);
  const rows = Math.max(1, insert.rowCount ?? 1);
  const columnSpacing = insert.columnSpacing ?? 0;
  const rowSpacing = insert.rowSpacing ?? 0;
  // A mirrored INSERT (AutoCAD's MIRROR command) tilts the OCS instead of
  // touching the geometry, so its insertion point and rotation are expressed
  // in that OCS rather than world coordinates — convert before using them.
  const ocs = extrusionMatrix(insert.extrusionDirection);

  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      // Block space -> world: shift off the block's base point, scale, rotate,
      // offset for the grid, move to the insertion point, then out of the OCS.
      const local = multiply(
        ocs,
        multiply(
          translate(insert.position?.x ?? 0, insert.position?.y ?? 0),
          multiply(
            rotate(rotationRad),
            multiply(
              translate(column * columnSpacing, row * rowSpacing),
              multiply(scale(sx, sy), translate(-basePoint.x, -basePoint.y))
            )
          )
        )
      );

      const combined = multiply(transform, local);
      for (const child of block.entities) {
        collectEntity(child, context, combined, host, depth + 1, out);
      }
      if (context.limitReached) return;
    }
  }
}

/**
 * Entity types whose coordinates are written in their own OCS rather than world
 * coordinates. AutoCAD's MIRROR command commonly flips the extrusion to
 * (0,0,-1) instead of rewriting the points, so ignoring it draws the mirrored
 * half of a part on top of the original.
 */
const OCS_TYPES = new Set(['ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TEXT', 'HATCH']);

function entityExtrusion(raw: IEntity, context: ParseContext): Vector3D | undefined {
  const e = raw as IEntity & {
    extrusionDirection?: Vector3D;
    extrusionDirectionX?: number;
    extrusionDirectionY?: number;
    extrusionDirectionZ?: number;
    is3dPolyline?: boolean;
    is3dPolygonMesh?: boolean;
    isPolyfaceMesh?: boolean;
  };
  // 3D polylines and meshes hold world coordinates
  if (e.is3dPolyline || e.is3dPolygonMesh || e.isPolyfaceMesh) return undefined;
  if (e.extrusionDirection) return e.extrusionDirection;
  if (e.extrusionDirectionZ !== undefined) {
    return { x: e.extrusionDirectionX ?? 0, y: e.extrusionDirectionY ?? 0, z: e.extrusionDirectionZ };
  }
  return e.handle !== undefined ? context.extras.extrusion.get(String(e.handle)) : undefined;
}

function mapEntity(
  raw: IEntity,
  layer: string,
  color: string,
  transform: Matrix2D,
  context: ParseContext
): DxfEntity[] {
  const m = OCS_TYPES.has(raw.type)
    ? multiply(transform, extrusionMatrix(entityExtrusion(raw, context)))
    : transform;

  switch (raw.type) {
    case 'LINE': {
      const e = raw as ILineEntity;
      if (!e.vertices || e.vertices.length < 2) return [];
      return [
        {
          type: 'LINE',
          layer,
          color,
          start: applyToPoint(m, e.vertices[0]),
          end: applyToPoint(m, e.vertices[1]),
        },
      ];
    }

    case 'CIRCLE': {
      const e = raw as ICircleEntity;
      if (isSimilarity(m)) {
        return [
          {
            type: 'CIRCLE',
            layer,
            color,
            center: applyToPoint(m, e.center),
            radius: e.radius * similarityScale(m),
          },
        ];
      }
      // Non-uniform scaling turns the circle into an ellipse, which we
      // approximate with a polyline rather than adding an ellipse primitive.
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: sampleArc(e.center, e.radius, 0, Math.PI * 2, m),
          closed: true,
        },
      ];
    }

    case 'ARC': {
      const e = raw as IArcEntity;
      // A mirroring transform reverses sweep direction; sampling sidesteps
      // having to flip the start/end angles correctly.
      if (isSimilarity(m) && determinant(m) > 0) {
        const angle = rotationAngle(m);
        return [
          {
            type: 'ARC',
            layer,
            color,
            center: applyToPoint(m, e.center),
            radius: e.radius * similarityScale(m),
            startAngle: e.startAngle + angle,
            endAngle: e.endAngle + angle,
          },
        ];
      }
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: sampleArc(e.center, e.radius, e.startAngle, e.endAngle, m),
          closed: false,
        },
      ];
    }

    case 'ELLIPSE': {
      const e = raw as IEllipseEntity;
      if (!e.center || !e.majorAxisEndPoint) return [];
      const points = sampleEllipse(e, m);
      if (points.length < 2) return [];
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points,
          closed: isFullSweep(e.startAngle, e.endAngle),
        },
      ];
    }

    case 'SOLID': {
      const e = raw as ISolidEntity;
      const corners = solidOutline(e.points ?? []);
      if (corners.length < 3) return [];
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: corners.map((p) => applyToPoint(m, p)),
          closed: true,
          filled: true,
        },
      ];
    }

    case '3DFACE': {
      const e = raw as I3DfaceEntity;
      const corners = finitePoints(e.vertices ?? []);
      if (corners.length < 3) return [];
      // Projected flat onto XY — a wireframe outline, not true 3D rendering.
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: corners.map((p) => applyToPoint(m, p)),
          closed: true,
        },
      ];
    }

    case 'POINT': {
      const e = raw as IPointEntity;
      if (!e.position) return [];
      return [{ type: 'POINT', layer, color, position: applyToPoint(m, e.position) }];
    }

    case 'HATCH': {
      const e = raw as unknown as {
        loops: Point2D[][];
        solid: boolean;
        patternAngle: number;
        patternScale: number;
      };
      const loops = (e.loops ?? [])
        .map((loop) => finitePoints(loop).map((p) => applyToPoint(m, p)))
        .filter((loop) => loop.length >= 3);
      if (loops.length === 0) return [];
      return [
        {
          type: 'HATCH',
          layer,
          color,
          loops,
          solid: !!e.solid,
          // The transform can rotate, mirror and resize the hatch along with its boundary.
          patternAngle: directionAngle(m, e.patternAngle ?? 0),
          patternSpacing: hatchSpacing(e.patternScale, m),
        },
      ];
    }

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const e = raw as ILwpolylineEntity | IPolylineEntity;
      // Keep the bulge alongside each vertex; it describes the arc to the next one.
      const vertices = (e.vertices ?? []).filter(
        (v): v is typeof v & Point2D => !!v && Number.isFinite(v.x) && Number.isFinite(v.y)
      );
      if (vertices.length < 2) return [];
      const closed = !!e.shape;
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: expandBulges(vertices, closed).map((v) => applyToPoint(m, v)),
          closed,
        },
      ];
    }

    case 'SPLINE': {
      const e = raw as ISplineEntity;
      const controlPoints = finitePoints(e.controlPoints ?? []);
      const sampled = sampleSpline(controlPoints, e.knotValues ?? [], e.degreeOfSplineCurve);
      // Fall back to the control polygon (or the fit points) when the knot
      // vector is unusable — a rough outline beats drawing nothing.
      const fitPoints = finitePoints(e.fitPoints ?? []);
      const points = sampled.length > 0 ? sampled : fitPoints.length > 0 ? fitPoints : controlPoints;
      if (points.length < 2) return [];
      return [
        {
          type: 'POLYLINE',
          layer,
          color,
          points: points.map((p) => applyToPoint(m, p)),
          closed: false,
        },
      ];
    }

    case 'TEXT': {
      const e = raw as ITextEntity;
      if (!e.startPoint || !e.text) return [];
      const text = decodeTextValue(e.text);
      if (!text) return [];
      const anchor = usesAlignmentPoint(e.halign, e.valign) && e.endPoint ? e.endPoint : e.startPoint;
      const hAlign = textHAlign(e.halign);
      const vAlign = textVAlign(e.valign, e.halign);
      const font = resolveTextFont(raw, context);
      return [buildText(layer, color, anchor, text, e.textHeight || 1, e.rotation || 0, m, hAlign, vAlign, font)];
    }

    case 'MTEXT': {
      const e = raw as IMtextEntity;
      if (!e.position || !e.text) return [];
      const { hAlign, vAlign } = mtextAlignment(e.attachmentPoint);
      const font = resolveTextFont(raw, context);
      return [buildText(layer, color, e.position, cleanMtext(e.text), e.height || 1, e.rotation || 0, m, hAlign, vAlign, font)];
    }

    case 'DIMENSION': {
      const e = raw as IDimensionEntity;
      if (!e.middleOfText) return [];
      return [
        {
          type: 'DIMENSION',
          layer,
          color,
          textPosition: applyToPoint(m, e.middleOfText),
          text: formatDimensionText(e),
          height: DIMENSION_TEXT_HEIGHT * transformScale(m),
          linePoint1: e.linearOrAngularPoint1 ? applyToPoint(m, e.linearOrAngularPoint1) : undefined,
          linePoint2: e.linearOrAngularPoint2 ? applyToPoint(m, e.linearOrAngularPoint2) : undefined,
        },
      ];
    }

    default:
      if (!INTENTIONALLY_NOT_DRAWN.has(raw.type)) context.skippedEntityTypes.add(raw.type);
      return [];
  }
}

/**
 * Whether TEXT is placed by its second point (11/21) rather than the first.
 *
 * Any alignment other than plain left/baseline uses the second point, except
 * Aligned (3) and Fit (5): those stretch the text between both points, so the
 * first point is still where the text starts.
 */
function usesAlignmentPoint(halign: number | undefined, valign: number | undefined): boolean {
  if (halign === 3 || halign === 5) return false;
  return (halign ?? 0) > 0 || (valign ?? 0) > 0;
}

/** DXF TEXT entity horizontal alignment (group code 72). */
function textHAlign(halign: number | undefined): 'left' | 'center' | 'right' {
  switch (halign) {
    case 1: return 'center';  // Center
    case 2: return 'right';   // Right
    case 4: return 'center';  // Middle (treated as center)
    default: return 'left';   // 0=Left, 3=Aligned, 5=Fit → left aligned
  }
}

/** DXF TEXT entity vertical alignment (group code 73). Horizontal "Middle" (4) centres both ways. */
function textVAlign(valign: number | undefined, halign?: number): 'baseline' | 'bottom' | 'middle' | 'top' {
  if (halign === 4) return 'middle';
  switch (valign) {
    case 1: return 'bottom';
    case 2: return 'middle';
    case 3: return 'top';
    default: return 'baseline';
  }
}

/** DXF MTEXT attachment point (1–9). */
function mtextAlignment(attachmentPoint: number | undefined): {
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'baseline' | 'bottom' | 'middle' | 'top';
} {
  const ap = attachmentPoint ?? 1;
  // Columns: 1=left, 2=center, 3=right (cycled every 3)
  const col = ((ap - 1) % 3);
  const hAlign: 'left' | 'center' | 'right' = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
  // Rows: 1-3=top, 4-6=middle, 7-9=bottom
  const row = Math.floor((ap - 1) / 3);
  const vAlign: 'baseline' | 'bottom' | 'middle' | 'top' = row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom';
  return { hAlign, vAlign };
}

function buildText(
  layer: string,
  color: string,
  position: Point2D,
  text: string,
  height: number,
  rotationDeg: number,
  m: Matrix2D,
  hAlign?: 'left' | 'center' | 'right',
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top',
  fontFamily?: string
): DxfEntity {
  const scaleFactor = transformScale(m);
  let rotation = directionAngle(m, rotationDeg);
  // A mirror would draw the glyphs upside down or backwards. Turn the text the
  // other way round and anchor it at its far end instead: it stays readable and
  // still covers the stretch of the drawing AutoCAD gives it.
  if (determinant(m) < 0) {
    rotation += 180;
    hAlign = hAlign === 'right' ? 'left' : hAlign === 'center' ? 'center' : 'right';
  }
  const result: TextEntity = {
    type: 'TEXT',
    layer,
    color,
    position: applyToPoint(m, position),
    text,
    height: height * scaleFactor,
    rotation,
  };
  if (hAlign && hAlign !== 'left') result.hAlign = hAlign;
  if (vAlign && vAlign !== 'baseline') result.vAlign = vAlign;
  if (fontFamily) result.fontFamily = fontFamily;
  return result;
}

/**
 * Drops vertices without usable coordinates.
 *
 * dxf-parser can emit placeholder vertices — its 3DFACE reader loops one time
 * too many and appends an empty object — which would otherwise become NaN
 * coordinates and silently break bounds for the whole drawing.
 */
function finitePoints(points: (Point2D | undefined)[]): Point2D[] {
  return points.filter(
    (p): p is Point2D => !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
  );
}

/**
 * Spacing between hatch pattern lines, in drawing units.
 *
 * Real DXF patterns carry their own line offsets in a pattern definition this
 * extension does not read, so the scale factor stands in for them. The floor is
 * there because a pattern denser than the line weight just reads as solid.
 */
function hatchSpacing(patternScale: number | undefined, m: Matrix2D): number {
  return Math.max(0.05, (patternScale || 1) * transformScale(m));
}

/**
 * Where a direction at `degrees` points once `m` is applied, in degrees. Adding
 * the transform's rotation is only right without a mirror, which turns
 * directions the other way.
 */
function directionAngle(m: Matrix2D, degrees: number): number {
  const radians = (degrees * Math.PI) / 180;
  const x = m.a * Math.cos(radians) + m.c * Math.sin(radians);
  const y = m.b * Math.cos(radians) + m.d * Math.sin(radians);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** How much a transform grows or shrinks lengths, for sizing text and patterns. */
function transformScale(m: Matrix2D): number {
  return isSimilarity(m) ? similarityScale(m) : Math.sqrt(Math.abs(determinant(m))) || 1;
}

function isFullSweep(startAngle: number, endAngle: number): boolean {
  return Math.abs((endAngle ?? 0) - (startAngle ?? 0)) >= Math.PI * 2 - 1e-9;
}

/**
 * Samples an ELLIPSE into a polyline.
 *
 * DXF stores the major axis as a vector from the centre; the minor axis is that
 * vector rotated a quarter turn and scaled by axisRatio. Start/end angles are
 * parameter angles on the unit circle, not true geometric angles.
 */
function sampleEllipse(e: IEllipseEntity, m: Matrix2D): Point2D[] {
  const major = e.majorAxisEndPoint;
  const ratio = e.axisRatio ?? 1;
  const start = e.startAngle ?? 0;
  const end = e.endAngle ?? Math.PI * 2;

  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;

  const segments = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SAMPLE_SEGMENTS));
  const points: Point2D[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = start + (sweep * i) / segments;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    points.push(
      applyToPoint(m, {
        x: e.center.x + major.x * cos - major.y * ratio * sin,
        y: e.center.y + major.y * cos + major.x * ratio * sin,
      })
    );
  }
  return points;
}

/**
 * Reorders SOLID/TRACE corners into drawing order.
 *
 * DXF stores the four corners as first, second, *fourth, third* — reading them
 * in storage order draws a bow-tie instead of a quad.
 */
function solidOutline(points: (Point2D | undefined)[]): Point2D[] {
  const corners = finitePoints(points);
  if (corners.length < 4) return corners;
  const [first, second, third, fourth] = corners;
  // A degenerate SOLID repeats the third corner as the fourth; drop the duplicate.
  if (fourth && third && fourth.x === third.x && fourth.y === third.y) {
    return [first, second, third];
  }
  return [first, second, fourth, third];
}

function sampleArc(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  m: Matrix2D
): Point2D[] {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) sweep += Math.PI * 2;

  const segments = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SAMPLE_SEGMENTS));
  const points: Point2D[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + (sweep * i) / segments;
    points.push(
      applyToPoint(m, {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      })
    );
  }
  return points;
}

/**
 * `layer` is the resolved layer — for layer-0 geometry inside a block that is
 * the INSERT's layer, so BYLAYER colour follows it the same way the layer
 * panel does.
 */
function resolveColor(raw: IEntity, layer: string, context: ParseContext, blockColor: string | null): string {
  const index = raw.colorIndex;
  // 0 = BYBLOCK (inherit from the INSERT that placed this entity),
  // 256 = BYLAYER, anything else is the entity's own color.
  if (index === 0) return blockColor ?? layerColor(layer, context) ?? FALLBACK_COLOR;
  if (index !== undefined && index !== 256 && typeof raw.color === 'number') {
    return toHexColor(raw.color);
  }
  return layerColor(layer, context) ?? blockColor ?? FALLBACK_COLOR;
}

function layerColor(layer: string | undefined, context: ParseContext): string | null {
  const color = layer ? context.layers[layer]?.color : undefined;
  return typeof color === 'number' ? toHexColor(color) : null;
}

/**
 * Resolves the linetype for an entity.
 *
 * Priority: entity's own lineType → layer's linetype → nothing (continuous).
 * "BYLAYER" (or empty) defers to the layer. "BYBLOCK" defers to the INSERT,
 * which we simplify to layer fallback. "Continuous" means no dashes.
 */
function resolveLinetype(raw: IEntity, layer: string, context: ParseContext): string | undefined {
  let ltName = raw.lineType;
  const ltScale = raw.lineTypeScale || 1;

  // BYLAYER or unset → use layer's linetype
  if (!ltName || ltName.toUpperCase() === 'BYLAYER' || ltName.toUpperCase() === 'BYBLOCK') {
    ltName = context.layerLineTypes[layer] ?? undefined;
  }

  if (!ltName) return undefined;
  const key = ltName.toUpperCase();
  if (key === 'CONTINUOUS' || key === 'BYLAYER' || key === 'BYBLOCK') return undefined;

  const pattern = context.lineTypes[key];
  if (!pattern || pattern.length === 0) return undefined;

  return patternToDashArray(pattern, ltScale);
}

/**
 * DXF lineweight values (hundredths of mm): maps to a relative stroke width.
 *
 * -3 = default, -2 = BYBLOCK, -1 = BYLAYER.
 * Standard values: 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, ...211
 */
function resolveLineweight(raw: IEntity, layer: string, context: ParseContext): number | undefined {
  let lw = raw.lineweight;

  // -1 = BYLAYER: TODO could scan layer lineweight from raw text
  // -2 = BYBLOCK: inherit from INSERT
  // -3 = default
  if (lw === undefined || lw === -3 || lw === -1 || lw === -2 || lw === 0) return undefined;

  // Convert from hundredths-of-mm to a relative pixel width (non-scaling-stroke).
  // 25 (0.25mm) is AutoCAD's default → maps to 1px. Scale proportionally.
  if (lw < 0) return undefined;
  return Math.max(0.5, lw / 25);
}

/**
 * Resolves the CSS font-family for a text entity: its own style (group 7), or
 * STANDARD when it names none.
 */
function resolveTextFont(raw: IEntity, context: ParseContext): string | undefined {
  // dxf-parser drops group 7, so the style comes from the raw scan by handle.
  const styleName =
    (raw.handle !== undefined ? context.extras.style.get(String(raw.handle)) : undefined) ??
    (raw as any).textStyle ??
    (raw as any).styleName;
  if (styleName) {
    const font = context.textStyles[styleName.toUpperCase()];
    if (font) return font;
  }
  // Fall back to STANDARD style
  return context.textStyles['STANDARD'] ?? undefined;
}

function toHexColor(truecolor: number): string {
  return `#${(truecolor & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * Reduces MTEXT rich text to plain text with line breaks — good enough for a
 * label, not a full rich-text renderer.
 *
 * Codes come in three shapes and must be told apart, or a toggle like `\L`
 * swallows everything up to the next semicolon in the sentence:
 * - toggles with no argument: `\L \l \O \o \K \k`
 * - codes whose argument runs to a semicolon: `\f \H \C \S` …
 * - escapes standing for a character: `\P \N \~ \\ \{ \}` and `\U+XXXX`.
 */
function cleanMtext(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      continue;
    }

    const code = raw[i + 1];
    i++;
    switch (code) {
      case 'P':
      case 'X':
      case 'N':
        out += '\n';
        break;
      case '~':
        out += ' ';
        break;
      case '\\':
      case '{':
      case '}':
        out += code;
        break;
      case 'L': case 'l': case 'O': case 'o': case 'K': case 'k':
        break;
      case 'U':
      case 'M': {
        const escape = raw.slice(i - 1).match(/^\\(U\+[0-9A-Fa-f]{4}|M\+[1-5][0-9A-Fa-f]{4})/);
        if (escape) {
          out += decodeTextValue(escape[0], false);
          i += escape[0].length - 2;
        } else {
          out += code;
        }
        break;
      }
      case 'S': {
        // Stacked text: numerator and denominator split by ^, / or #.
        const end = raw.indexOf(';', i + 1);
        const body = raw.slice(i + 1, end < 0 ? raw.length : end);
        out += body.replace(/\\(.)/g, '$1').split(/[\^/#]/).map((part) => part.trim()).filter(Boolean).join('/');
        i = end < 0 ? raw.length : end;
        break;
      }
      default: {
        // Formatting codes with an argument (\f, \H, \W, \Q, \T, \A, \C, \c, \p …)
        if (/[A-Za-z]/.test(code)) {
          const end = raw.indexOf(';', i + 1);
          i = end < 0 ? raw.length : end;
        } else {
          out += code;
        }
      }
    }
  }
  return decodePercentCodes(out);
}

/** Code pages behind MTEXT/TEXT `\M+n` multibyte escapes. */
const MULTIBYTE_ENCODINGS: Record<string, string> = {
  '1': 'shift_jis',
  '2': 'big5',
  '3': 'euc-kr',
  '4': 'euc-kr', // Johab has no TextDecoder label; EUC-KR covers the common range
  '5': 'gbk',
};

/**
 * Decodes the text value of a TEXT or ATTRIB: `\U+XXXX` and `\M+nXXXX`
 * character escapes, then (unless `percent` is false) the `%%` codes.
 */
function decodeTextValue(raw: string, percent = true): string {
  const decoded = raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (match, page: string, hex: string) => {
      try {
        const bytes = new Uint8Array([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)]);
        return new TextDecoder(MULTIBYTE_ENCODINGS[page], { fatal: true }).decode(bytes);
      } catch {
        return match;
      }
    });
  return percent ? decodePercentCodes(decoded) : decoded;
}

/**
 * Resolves the `%%` escapes DXF uses inside text.
 *
 * These are not decoration: left alone, a room label reads "%%uMASTER" and a
 * tolerance reads "%%p0.5" on screen. Underline and overline are toggles with
 * no plain-text equivalent, so they are dropped rather than shown.
 */
function decodePercentCodes(raw: string): string {
  return raw
    .replace(/%%[uUoO]/g, '')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%(\d{3})/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/%%%/g, '%')
    .trim();
}

function formatDimensionText(e: IDimensionEntity): string {
  const measurement = formatNumber(e.actualMeasurement);
  if (!e.text) return measurement;
  // Dimension text overrides are MTEXT, and `<>` stands for the measurement.
  return cleanMtext(e.text.split('<>').join(measurement));
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '';
  return String(Math.round(value * 100) / 100);
}

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
function textBoxCorners(e: TextEntity): Point2D[] {
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

function computeBounds(entities: DxfEntity[]): Bounds | null {
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
