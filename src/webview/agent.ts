import type { Bounds, DrawingKey, ShowRequest, SnapshotRequest } from '../shared/types';
import type { ViewBox } from './panZoom';

/** Pure helpers for the agent channel; nothing here touches the DOM. */

export const CHANGED_MESSAGE = 'The drawing changed since it was read; read it again.';

/** True only for a loaded drawing that is the very version the agent read. */
export function keyMatches(current: DrawingKey | undefined, asked: DrawingKey): boolean {
  return (
    !!current &&
    current.path === asked.path &&
    current.mtimeMs === asked.mtimeMs &&
    current.size === asked.size
  );
}

/** Layer names the request mentions that the page does not have, in request order. */
export function unknownLayers(all: string[], req: ShowRequest['layers']): string[] {
  if (!req) return [];
  const known = new Set(all);
  const unknown: string[] = [];
  for (const name of [...(req.only ?? []), ...(req.show ?? []), ...(req.hide ?? [])]) {
    if (!known.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * The hidden-layer set after a request. `only` wins over `show` and `hide`;
 * unknown names are ignored (see `unknownLayers`), and an `only` naming no
 * known layer is ignored too, since it would blank the page. The input is not changed.
 */
export function nextHiddenLayers(all: string[], hidden: Set<string>, req: ShowRequest['layers']): Set<string> {
  const next = new Set(hidden);
  if (!req) return next;
  const known = new Set(all);

  const only = (req.only ?? []).filter((name) => known.has(name));
  if (only.length > 0) {
    const keep = new Set(only);
    return new Set(all.filter((name) => !keep.has(name)));
  }
  if (req.only?.length) return next;

  for (const name of req.show ?? []) if (known.has(name)) next.delete(name);
  for (const name of req.hide ?? []) if (known.has(name)) next.add(name);
  return next;
}

/** The view showing exactly `b`, y negated like `fitBounds` because the scene is drawn through a flip. */
export function regionViewBox(b: Bounds): ViewBox {
  return { x: b.minX, y: -b.maxY, w: b.maxX - b.minX || 1, h: b.maxY - b.minY || 1 };
}

// ---- Messages from the host: validation and planning, kept pure so they can be tested without a DOM ----

export type AgentRequest =
  | { kind: 'show'; requestId: string; key: DrawingKey; show: ShowRequest }
  | { kind: 'snapshot'; requestId: string; key: DrawingKey; snapshot: SnapshotRequest };

export type ParsedAgentMessage =
  | { request: AgentRequest }
  | { invalid: { requestId: string; message: string } }
  | null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function parseKey(v: unknown): DrawingKey | null {
  if (!isRecord(v) || typeof v.path !== 'string' || !isNum(v.mtimeMs) || !isNum(v.size)) return null;
  return { path: v.path, mtimeMs: v.mtimeMs, size: v.size };
}

function parseRegion(v: unknown): Bounds | null {
  if (!isRecord(v) || !isNum(v.minX) || !isNum(v.minY) || !isNum(v.maxX) || !isNum(v.maxY)) return null;
  return { minX: v.minX, minY: v.minY, maxX: v.maxX, maxY: v.maxY };
}

/**
 * Checks the shape of an AGENT_SHOW / AGENT_SNAPSHOT message. Returns null for
 * anything that is not one, or has no usable requestId (nobody to answer);
 * otherwise a typed request, or the reason it is malformed.
 */
export function parseAgentMessage(data: unknown): ParsedAgentMessage {
  if (!isRecord(data) || (data.type !== 'AGENT_SHOW' && data.type !== 'AGENT_SNAPSHOT')) return null;
  const requestId = data.requestId;
  if (typeof requestId !== 'string' || requestId === '') return null;
  const invalid = (message: string): ParsedAgentMessage => ({ invalid: { requestId, message } });

  const key = parseKey(data.key);
  if (!key) return invalid('The request has no valid drawing key (path, mtimeMs, size).');

  if (data.type === 'AGENT_SHOW') {
    const show: ShowRequest = {};
    if (data.objects !== undefined) {
      if (!Array.isArray(data.objects) || !data.objects.every(isNum)) return invalid('"objects" must be an array of numbers.');
      show.objects = data.objects;
    }
    if (data.page !== undefined) {
      if (!isNum(data.page)) return invalid('"page" must be a number.');
      show.page = data.page;
    }
    if (data.layers !== undefined) {
      if (!isRecord(data.layers)) return invalid('"layers" must be an object with show, hide or only.');
      const layers: NonNullable<ShowRequest['layers']> = {};
      for (const field of ['show', 'hide', 'only'] as const) {
        const value = data.layers[field];
        if (value === undefined) continue;
        if (!isStrings(value)) return invalid(`"layers.${field}" must be an array of layer names.`);
        layers[field] = value;
      }
      show.layers = layers;
    }
    if (data.fit !== undefined) {
      if (typeof data.fit !== 'boolean') return invalid('"fit" must be true or false.');
      show.fit = data.fit;
    }
    return { request: { kind: 'show', requestId, key, show } };
  }

  if (!isNum(data.page)) return invalid('"page" must be a number.');
  const snapshot: SnapshotRequest = { page: data.page };
  if (data.region !== undefined && data.region !== null) {
    const region = parseRegion(data.region);
    if (!region) return invalid('"region" must have numeric minX, minY, maxX and maxY.');
    snapshot.region = region;
  }
  if (data.around !== undefined && data.around !== null && !isNum(data.around)) return invalid('"around" must be a number.');
  if (data.margin !== undefined && data.margin !== null && !isNum(data.margin)) return invalid('"margin" must be a number.');
  return { request: { kind: 'snapshot', requestId, key, snapshot } };
}

/** What the webview is doing right now. */
export interface AgentState {
  loaded: boolean;
  /** Elements are still being drawn in animation-frame batches. */
  rendering: boolean;
  drawingKey: DrawingKey | undefined;
}

/** The facts about the loaded drawing that planning needs. */
export interface AgentScene {
  pageNames: string[];
  pageIndex: number;
  layersOfPage: string[][];
  hidden: Set<string>;
  /** Page index of each object, by object id. */
  objectPages: ArrayLike<number>;
}

export type Refusal = { ok: false; message: string };

export type ShowPlan =
  | Refusal
  | {
      ok: true;
      /** Page to switch to, when the request named one. */
      page?: number;
      /** The hidden-layer set to apply, when layers were requested. */
      hiddenLayers?: Set<string>;
      /** Objects to select and zoom to. */
      highlight?: number[];
      /** Clear the selection and fit the page. */
      fit: boolean;
      message: string;
    };

export const NOT_LOADED_MESSAGE = 'The drawing is not loaded yet; try again in a moment.';
export const STILL_DRAWING_MESSAGE = 'The preview is still drawing; try again in a moment.';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function gate(state: AgentState, key: DrawingKey, needsDrawn: boolean): Refusal | null {
  if (!state.loaded) return { ok: false, message: NOT_LOADED_MESSAGE };
  if (!keyMatches(state.drawingKey, key)) return { ok: false, message: CHANGED_MESSAGE };
  if (needsDrawn && state.rendering) return { ok: false, message: STILL_DRAWING_MESSAGE };
  return null;
}

/** Decides what an AGENT_SHOW does, and what to tell the agent; touches nothing. */
export function planShow(state: AgentState, scene: AgentScene, key: DrawingKey, req: ShowRequest): ShowPlan {
  const refusal = gate(state, key, true);
  if (refusal) return refusal;

  let page = scene.pageIndex;
  if (req.page !== undefined) {
    if (!Number.isInteger(req.page) || req.page < 0 || req.page >= scene.pageNames.length) {
      return {
        ok: false,
        message: `There is no page ${req.page}; the drawing has ${plural(scene.pageNames.length, 'page')} (0-${scene.pageNames.length - 1}).`,
      };
    }
    page = req.page;
  }
  const pageName = scene.pageNames[page];
  const notes: string[] = [];
  const plan: Extract<ShowPlan, { ok: true }> = { ok: true, fit: false, message: '' };
  if (req.page !== undefined) plan.page = req.page;

  if (req.layers) {
    const names = scene.layersOfPage[page] ?? [];
    const unknown = unknownLayers(names, req.layers);
    plan.hiddenLayers = nextHiddenLayers(names, scene.hidden, req.layers);
    if (unknown.length) notes.push(`Unknown layers ignored: ${unknown.join(', ')}.`);
    if (req.layers.only?.length && req.layers.only.every((name) => unknown.includes(name))) {
      notes.push('No layer in "only" exists, so the layers were left as they were.');
    }
    notes.push('Layers updated.');
  }

  if (req.objects !== undefined) {
    const inRange = (id: number) => Number.isInteger(id) && id >= 0 && id < scene.objectPages.length;
    const valid = [...new Set(req.objects.filter(inRange))];
    const invalid = req.objects.filter((id) => !inRange(id)).length;
    const onPage = valid.filter((id) => scene.objectPages[id] === page);
    const elsewhere = valid.length - onPage.length;
    if (invalid) notes.push(`Ignored ${plural(invalid, 'invalid object id')}.`);
    if (elsewhere) notes.push(`${plural(elsewhere, 'object')} not on this page ${elsewhere === 1 ? 'was' : 'were'} not highlighted.`);
    if (onPage.length === 0) {
      if (req.layers === undefined && req.page === undefined) {
        return { ok: false, message: ['No object to highlight.', ...notes].join(' ') };
      }
      notes.unshift('No object highlighted.');
    } else {
      plan.highlight = onPage;
      notes.unshift(`Highlighted ${plural(onPage.length, 'object')} on ${pageName} and zoomed to them.`);
    }
  } else if (req.fit || req.page !== undefined) {
    plan.fit = true;
    notes.unshift(`Showing ${pageName}, fitted to the page.`);
  } else if (!req.layers) {
    notes.push('Nothing to change.');
  }
  plan.message = notes.join(' ');
  return plan;
}

export type SnapshotPlan = Refusal | { ok: true; page: number; pageName: string; bounds: Bounds; wholePage: boolean; message: string };

/**
 * Decides what an AGENT_SNAPSHOT draws. It reads the parsed drawing, not the
 * canvas, so it is allowed while the canvas is still being drawn.
 */
export function planSnapshot(
  state: AgentState,
  scene: AgentScene & { pageBounds: (Bounds | null)[] },
  key: DrawingKey,
  req: SnapshotRequest
): SnapshotPlan {
  const refusal = gate(state, key, false);
  if (refusal) return refusal;
  if (!Number.isInteger(req.page) || req.page < 0 || req.page >= scene.pageNames.length) {
    return { ok: false, message: `There is no page ${req.page}; the drawing has ${plural(scene.pageNames.length, 'page')}.` };
  }
  const pageName = scene.pageNames[req.page];
  const bounds = req.region ?? scene.pageBounds[req.page];
  if (!bounds) return { ok: false, message: `${pageName} has nothing to draw.` };
  const wholePage = !req.region;
  return { ok: true, page: req.page, pageName, bounds, wholePage, message: `Snapshot of ${wholePage ? 'the whole page' : 'the requested region'} on ${pageName}.` };
}

/**
 * Holds an agent's show while the preview draws a large drawing in batches: resolves true once
 * nothing is drawing, or false after `timeoutMs` (the caller then refuses with "still drawing").
 * `onDrawn` registers a callback for when drawing finishes and returns its unsubscribe.
 */
export function waitUntilDrawn(isDrawing: () => boolean, onDrawn: (cb: () => void) => () => void, timeoutMs: number): Promise<boolean> {
  if (!isDrawing()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const check = () => {
      if (isDrawing()) return; // another drawing started its own batches: keep waiting
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    };
    unsubscribe = onDrawn(check);
  });
}
