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
    }
  }

  if (!textValue) return null;

  // Layer 0 ATTRIBs inherit the layer of their parent INSERT, just like
  // block content on layer 0 inherits from the INSERT that places it.
  if (layer === '0' && insertLayer !== '0') layer = insertLayer;

  // When alignment is set, use the alignment point (11/21)
  const hasAlignment = halign > 0 || valign > 0;
  const position = hasAlignment && ax !== undefined && ay !== undefined
    ? { x: ax, y: ay }
    : { x, y };

  return {
    layer,
    position,
    text: decodeControlCodes(textValue),
    height,
    rotation,
    inPaperSpace,
    hAlign: textHAlign(halign),
    vAlign: textVAlign(valign),
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

export function parseDxf(text: string): ParsedDxf {
  const dxf = parseWithRecovery(text);
  injectHatches(text, dxf);

  const context: ParseContext = {
    layers: dxf?.tables?.layer?.layers ?? {},
    blocks: dxf?.blocks ?? {},
    skippedEntityTypes: new Set<string>(),
    lineTypes: extractLineTypes(dxf),
    layerLineTypes: scanLayerLineTypes(text),
    layerHandleMap: scanLayerHandles(text),
    textStyles: scanTextStyles(text),
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
    const entity: DxfEntity = {
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

  return { pages, skippedEntityTypes: Array.from(context.skippedEntityTypes) };
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

    const transform = viewportTransform(viewport);
    const entities: DxfEntity[] = [];
    for (const raw of rawModelEntities) {
      collectEntity(raw, context, transform, null, 0, entities);
    }

    // Remove entities on layers frozen in this viewport
    const visible = frozenLayers.size > 0
      ? entities.filter((e) => !frozenLayers.has(e.layer))
      : entities;
    if (visible.length === 0) continue;

    views.push({
      rect: {
        x: viewport.paper.x - viewport.paper.width / 2,
        y: viewport.paper.y - viewport.paper.height / 2,
        width: viewport.paper.width,
        height: viewport.paper.height,
      },
      entities: visible,
    });
  }

  return views;
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

  return Array.from(counts, ([name, entityCount]) => ({
    name,
    color: layerColor(name, context) ?? FALLBACK_COLOR,
    entityCount,
  })).sort((a, b) => a.name.localeCompare(b.name));
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
function injectHatches(text: string, dxf: ReturnType<DxfParser['parseSync']>): void {
  if (!dxf) return;

  for (const hatch of scanHatches(text)) {
    const pseudoEntity = {
      type: 'HATCH',
      layer: hatch.layer,
      colorIndex: hatch.colorIndex,
      color: hatch.colorIndex !== undefined ? aciToTrueColor(hatch.colorIndex) : undefined,
      inPaperSpace: hatch.inPaperSpace,
      loops: hatch.loops,
      solid: hatch.solid,
      patternAngle: hatch.patternAngle,
      patternScale: hatch.patternScale,
    } as unknown as IEntity;

    if (hatch.blockName) dxf.blocks?.[hatch.blockName]?.entities?.push(pseudoEntity);
    else dxf.entities?.push(pseudoEntity);
  }
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
  const layer = resolveLayer(raw, host);
  const color = resolveColor(raw, context, host?.color ?? null);

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
    if (linetype) entity.linetype = linetype;
    if (lineweight !== undefined) entity.lineweight = lineweight;
    out.push(entity);
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
    }
  }
}

function mapEntity(
  raw: IEntity,
  layer: string,
  color: string,
  m: Matrix2D,
  context: ParseContext
): DxfEntity[] {
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
          // The transform can rotate and resize the hatch along with its boundary.
          patternAngle: (e.patternAngle ?? 0) + (rotationAngle(m) * 180) / Math.PI,
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
      const text = decodeControlCodes(e.text);
      if (!text) return [];
      // When alignment is set (halign > 0 or valign > 0), DXF uses endPoint as the alignment point.
      const hasAlignment = (e.halign && e.halign > 0) || (e.valign && e.valign > 0);
      const anchor = hasAlignment && e.endPoint ? e.endPoint : e.startPoint;
      const hAlign = textHAlign(e.halign);
      const vAlign = textVAlign(e.valign);
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

/** DXF TEXT entity horizontal alignment (group code 72). */
function textHAlign(halign: number | undefined): 'left' | 'center' | 'right' {
  switch (halign) {
    case 1: return 'center';  // Center
    case 2: return 'right';   // Right
    case 4: return 'center';  // Middle (treated as center)
    default: return 'left';   // 0=Left, 3=Aligned, 5=Fit → left aligned
  }
}

/** DXF TEXT entity vertical alignment (group code 73). */
function textVAlign(valign: number | undefined): 'baseline' | 'bottom' | 'middle' | 'top' {
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
  const result: TextEntity = {
    type: 'TEXT',
    layer,
    color,
    position: applyToPoint(m, position),
    text,
    height: height * scaleFactor,
    rotation: rotationDeg + (rotationAngle(m) * 180) / Math.PI,
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

function resolveColor(raw: IEntity, context: ParseContext, blockColor: string | null): string {
  const index = raw.colorIndex;
  // 0 = BYBLOCK (inherit from the INSERT that placed this entity),
  // 256 = BYLAYER, anything else is the entity's own color.
  if (index === 0) return blockColor ?? layerColor(raw.layer, context) ?? FALLBACK_COLOR;
  if (index !== undefined && index !== 256 && typeof raw.color === 'number') {
    return toHexColor(raw.color);
  }
  return layerColor(raw.layer, context) ?? blockColor ?? FALLBACK_COLOR;
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
 * Resolves the CSS font-family for a text entity.
 *
 * dxf-parser does not read group code 7 (text style name) from entities, so we
 * cannot look up the per-entity style. Instead, the STANDARD style's font is
 * used as default — this is correct for the majority of drawings that use a
 * single text style throughout.
 */
function resolveTextFont(raw: IEntity, context: ParseContext): string | undefined {
  // Try the entity's style name if somehow available (future-proofing)
  const styleName = (raw as any).textStyle ?? (raw as any).styleName;
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

/** Strips MTEXT formatting control codes down to plain text — good enough for a label, not a full rich-text renderer. */
function cleanMtext(raw: string): string {
  return decodeControlCodes(
    raw
      .replace(/\\P/gi, '\n')
      .replace(/\{|\}/g, '')
      .replace(/\\[A-Za-z][^;]*;/g, '')
  );
}

/**
 * Resolves the `%%` escapes DXF uses inside text.
 *
 * These are not decoration: left alone, a room label reads "%%uMASTER" and a
 * tolerance reads "%%p0.5" on screen. Underline and overline are toggles with
 * no plain-text equivalent, so they are dropped rather than shown.
 */
function decodeControlCodes(raw: string): string {
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
  return e.text.includes('<>') ? e.text.replace('<>', measurement) : e.text;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '';
  return String(Math.round(value * 100) / 100);
}

/** Rough advance width of a glyph relative to the font size, for sans-serif text. */
const GLYPH_WIDTH_RATIO = 0.6;
const LINE_HEIGHT_RATIO = 1.2;

/**
 * Corners of the box a text entity occupies, in drawing coordinates.
 *
 * Bounds used to consider only the anchor point, so fit-to-view clipped any
 * label extending past it — a large title placed at the edge of a drawing was
 * cut in half. The width is estimated from the character count, which is
 * approximate but far closer than treating text as a zero-size point.
 */
function textBoxCorners(e: TextEntity): Point2D[] {
  const lines = e.text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const width = longest * e.height * GLYPH_WIDTH_RATIO;
  const top = lines.length * e.height * LINE_HEIGHT_RATIO;
  const bottom = -e.height * 0.25; // descenders sit below the baseline

  const radians = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return [
    { x: 0, y: bottom },
    { x: width, y: bottom },
    { x: width, y: top },
    { x: 0, y: top },
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
