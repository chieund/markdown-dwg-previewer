import { randomUUID } from 'node:crypto';
import { SHOW_DRAWN_WAIT_MS, type AgentResult, type Bounds, type DrawingKey, type ShowRequest, type SnapshotRequest } from '../shared/types';
import { indexOf } from './drawingIndex';
import { sameKey, type StoredDrawing } from './drawingStore';
import type { PreviewControl } from './tools';

/** The part of a webview panel the bridge needs. */
export interface PanelLike {
  postMessage(message: unknown): Thenable<boolean>;
  reveal(): void;
  active: boolean;
  visible: boolean;
}

export interface BridgeDeps {
  /** Opens the drawing in the DWG Previewer; the panel then registers itself. */
  open(path: string): Promise<void>;
  /** The parsed drawing, to resolve `around` into a region. */
  load(path: string): Promise<StoredDrawing>;
  /** Box of one object; defaults to the drawing index. */
  boundsOf?(stored: StoredDrawing, id: number): Bounds | undefined;
  openTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** A show may first wait for the preview to finish drawing. Default resultTimeoutMs + SHOW_DRAWN_WAIT_MS. */
  showTimeoutMs?: number;
}

export const CHANGED_MESSAGE = 'The drawing changed since it was read; read it again.';

interface Entry {
  path: string;
  panel: PanelLike;
  currentKey: () => DrawingKey | undefined;
  loaded: boolean;
  /** The last load failed; requests get this message until a load succeeds. */
  error?: string;
  pending: Set<string>;
}

interface Pending {
  entry: Entry;
  settle: (r: AgentResult | Error) => void;
}

/** Sends the AI's show/snapshot requests to the drawing's preview and brings the webview's answer back. */
export class PreviewBridge implements PreviewControl {
  private readonly entries: Entry[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<() => void>();
  private readonly openTimeoutMs: number;
  private readonly resultTimeoutMs: number;
  private readonly showTimeoutMs: number;

  constructor(private readonly deps: BridgeDeps) {
    this.openTimeoutMs = deps.openTimeoutMs ?? 30_000;
    this.resultTimeoutMs = deps.resultTimeoutMs ?? 20_000;
    this.showTimeoutMs = deps.showTimeoutMs ?? this.resultTimeoutMs + SHOW_DRAWN_WAIT_MS;
  }

  /** `path` must be the real path, as the tools pass it. Call `loaded()` after the panel was sent its DXF_DATA. */
  register(path: string, panel: PanelLike, currentKey: () => DrawingKey | undefined): { dispose(): void; loaded(): void; failed(message: string): void } {
    const entry: Entry = { path, panel, currentKey, loaded: false, pending: new Set() };
    this.entries.push(entry);
    this.wake();
    return {
      loaded: () => {
        entry.loaded = true;
        entry.error = undefined;
        this.wake();
      },
      failed: (message) => {
        entry.loaded = false;
        entry.error = message;
        this.wake();
      },
      dispose: () => {
        const i = this.entries.indexOf(entry);
        if (i >= 0) this.entries.splice(i, 1);
        for (const id of [...entry.pending]) this.pending.get(id)?.settle(new Error('The preview was closed before it answered.'));
        this.wake();
      },
    };
  }

  receive(message: AgentResult): void {
    this.pending.get(message?.requestId)?.settle(message);
  }

  openPaths(): string[] {
    return [...new Set(this.entries.map((e) => e.path))];
  }

  async show(path: string, key: DrawingKey, req: ShowRequest): Promise<string> {
    const result = await this.send(path, key, (requestId) => ({ type: 'AGENT_SHOW', requestId, key, ...req }), true, this.showTimeoutMs);
    return result.message;
  }

  async snapshot(path: string, key: DrawingKey, req: SnapshotRequest): Promise<string> {
    const resolved = await this.resolveRegion(path, key, req);
    const result = await this.send(path, key, (requestId) => ({ type: 'AGENT_SNAPSHOT', requestId, key, ...resolved }), false, this.resultTimeoutMs);
    if (!result.png) throw new Error('The preview returned no image.');
    return result.png;
  }

  private async resolveRegion(path: string, key: DrawingKey, req: SnapshotRequest): Promise<SnapshotRequest> {
    const r = req.region;
    if (r && (r.minX > r.maxX || r.minY > r.maxY)) throw new Error('region needs minX <= maxX and minY <= maxY');
    if (req.around === undefined) return req;
    const stored = await this.deps.load(path);
    if (!sameKey(stored.key, key)) throw new Error(CHANGED_MESSAGE);
    const box = (this.deps.boundsOf ?? ((s, id) => indexOf(s).bounds(id)))(stored, req.around);
    if (!box) throw new Error(`Object ${req.around} has no geometry`);
    const size = Math.max(box.maxX - box.minX, box.maxY - box.minY);
    const margin = req.margin ?? (size > 0 ? size * 1.5 : 1);
    const { around: _around, margin: _margin, ...rest } = req;
    return {
      ...rest,
      region: { minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin },
    };
  }

  private pick(path: string): Entry | undefined {
    const ready = this.entries.filter((e) => e.path === path && e.loaded);
    return ready.find((e) => e.panel.active) ?? ready.find((e) => e.panel.visible) ?? ready[ready.length - 1];
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private failure(path: string): string | undefined {
    return this.entries.find((e) => e.path === path && !e.loaded && e.error)?.error;
  }

  private async panelFor(path: string): Promise<Entry> {
    const found = this.pick(path);
    if (found) return found;
    const failed = this.failure(path);
    if (failed) throw new Error(failed);
    if (!this.entries.some((e) => e.path === path)) await this.deps.open(path);
    return new Promise<Entry>((resolve, reject) => {
      let seen = false;
      const check = () => {
        const e = this.pick(path);
        if (e) return done(() => resolve(e));
        const err = this.failure(path);
        if (err) return done(() => reject(new Error(err)));
        const present = this.entries.some((x) => x.path === path);
        if (present) seen = true;
        else if (seen) done(() => reject(new Error('The preview was closed before it finished loading.')));
      };
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new Error('The drawing preview did not open in time.'))), this.openTimeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  private async send(path: string, key: DrawingKey, build: (requestId: string) => unknown, reveal: boolean, timeoutMs: number): Promise<AgentResult> {
    const entry = await this.panelFor(path);
    const current = entry.currentKey();
    if (!current || !sameKey(current, key)) throw new Error(CHANGED_MESSAGE);
    const requestId = randomUUID();
    const result = new Promise<AgentResult>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new Error('The preview did not answer in time.')),
        timeoutMs
      );
      const settle = (r: AgentResult | Error) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        entry.pending.delete(requestId);
        if (r instanceof Error) reject(r);
        else if (!r.ok) reject(new Error(r.message));
        else resolve(r);
      };
      this.pending.set(requestId, { entry, settle });
      entry.pending.add(requestId);
    });
    result.catch(() => {});
    try {
      if (reveal) entry.panel.reveal();
      const posted = await entry.panel.postMessage(build(requestId));
      if (!posted) this.pending.get(requestId)?.settle(new Error('The preview could not receive the request.'));
    } catch (err) {
      this.pending.get(requestId)?.settle(err instanceof Error ? err : new Error(String(err)));
    }
    return result;
  }
}
