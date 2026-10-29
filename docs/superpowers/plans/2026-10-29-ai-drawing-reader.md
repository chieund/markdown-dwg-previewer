# AI Drawing Reader (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server inside the DWG Previewer extension that lets AI agents in VS Code read drawings (overview, text, dimensions, snapshot) and drive the open preview, with TCVN3 text fixed and a read-once cache.

**Architecture:** Pure, `vscode`-free modules under `src/ai/` (store, disk cache, index, tools, access, HTTP server) are unit-tested in Node; thin `vscode` glue (`src/ai/extensionHost.ts`, `previewBridge.ts`, `connect.ts`) wires them into the extension host. The HTTP server runs in the extension host on 127.0.0.1 with a bearer token; parsing stays in the existing `DrawingWorker`. The preview webview gains an agent message channel for highlight/zoom/layers/page and PNG snapshots.

**Tech Stack:** TypeScript, VS Code API, `@modelcontextprotocol/sdk` 1.32.1 (low-level `Server` + `StreamableHTTPServerTransport`), node `http`/`zlib`/`crypto`, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-29-ai-drawing-reader-design.md`

## Global Constraints

- `engines.vscode` stays `^1.85.0`; the Copilot provider registers only if `vscode.lm.registerMcpServerDefinitionProvider` exists. Everything else works on 1.85+.
- Dependency: `@modelcontextprotocol/sdk` pinned **exactly** `1.32.1` (MIT; 1.32.2 is under two weeks old). No other new runtime dependency.
- Licence stays GPL-3.0-or-later; add the SDK to `THIRD_PARTY_NOTICES.md`.
- Server binds `127.0.0.1` only; default port **45131** (setting `dwgPreviewer.ai.port`); every request needs `Authorization: Bearer <token>`; any request carrying an `Origin` header is rejected with 403.
- Token: 32 random bytes hex, `context.secrets` key `dwgPreviewer.ai.token`.
- Setting `dwgPreviewer.ai.enabled`, boolean, **default `true`**.
- Tool names exactly: `dwg_overview`, `dwg_find_text`, `dwg_dimensions`, `dwg_snapshot`, `dwg_show`.
- Units string when undeclared: `"NOT DECLARED"` (plus the instruction sentence in the tool description). Tools never convert units.
- Disk cache: `context.globalStorageUri/drawing-cache/`, gzip JSON, key = absolute path + `mtimeMs` + `size` + `CACHE_FORMAT`; keep newest **30** files or **500 MB**. AI side only — the preview never reads or writes it. With `ai.enabled` false nothing is written.
- Never write into the user's project folder; never edit `~/.claude.json` directly — only `claude mcp add|remove`.
- File access: free inside any window's workspace folders or open preview tabs; otherwise a modal `Allow the AI agent to read <name> (<path>)?` [Allow] [Deny], remembered per path until restart.
- Tool text output capped at **100,000 characters**; when cut, the JSON says `"truncated": true`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The drawing changes between the agent's read and `dwg_show`** (user saves in AutoCAD) — ids now mean other objects; expect an error "the drawing changed, read it again", never a wrong highlight. → test in Task 8.
2. **A second VS Code window** finds the port taken — expect it to stand by silently and take over within seconds when the first window closes; the agent's one configured URL keeps working. → test in Task 6.
3. **Path tricks**: relative path, `..`, a symlink inside the workspace pointing outside it, a directory named `x.dwg`, `.DWG` upper case — expect access checked on the resolved real path, case-insensitive extension. → test in Task 5.
4. **A huge drawing** (GridElevation, 245k objects) with `dwg_find_text` and no query — expect a bounded answer with totals and `truncated`, not a multi-megabyte reply that floods the agent. → test in Task 4.
5. **A corrupt or stale disk cache file**, or the drawing deleted after it was cached — expect a silent re-read (or a clear "file not found"), never an exception leaking cache internals. → test in Task 3.

---

### Task 1: TCVN3 → Unicode in the parser

**Files:**
- Create: `src/dxf/vietnamese.ts`
- Modify: `src/dwg/encoding.ts` (export the legacy encoding label), `src/dxf/parseDxf.ts` (`scanTextStyles` keeps font files; TEXT/MTEXT/ATTRIB/dimension text decoded per font; `cleanMtext` tracks `\f` switches and `{}` scopes)
- Test: `test/vietnamese.test.ts`

**Interfaces:**
- Produces: `legacyFontOf(fontFile: string | undefined): 'tcvn3' | 'tcvn3-caps' | null` — `tcvn3` for `.Vn*` (not ending `H`), `VN*.TTF`, `vn-abc*.shx`, `vnsimple.shx`, `vnromanc.shx`, `vn*.shx`; `tcvn3-caps` for `.Vn*H`, `VH*.TTF`. Case-insensitive.
- Produces: `decodeTcvn3(text: string, caps: boolean, decodedWith: string): string` — maps each char back to the byte it came from under `decodedWith` (a `TextDecoder` label; build the reverse table by decoding bytes 0x80–0xFF), applies the TCVN3 table from `spike/mcp/server.ts`, uppercases with `toLocaleUpperCase('vi')` when `caps`; leaves U+FFFD and unmapped chars alone.
- Produces: `legacyEncodingOf(dxfHead: string): string` in `encoding.ts` — the single-byte label `decodeDxfBuffer` used for this file (`windows-1258`, `windows-1252`, …), or `'latin1'` when the text was UTF-8 (AC1021+).
- `parseDxf` output unchanged in shape; text of objects in TCVN3 fonts is now Unicode.

- [ ] **Step 1: Write the failing tests** (`test/vietnamese.test.ts`)

```ts
test('TCVN3 notes read as Vietnamese', () => {
  assert.equal(decodeTcvn3('12 cöa 30x30', false, 'latin1'), '12 cửa 30x30');
  assert.equal(decodeTcvn3('MÆt b»ng tÇng 2', false, 'latin1'), 'Mặt bằng tầng 2');
  assert.equal(decodeTcvn3('Ghi chó chung', false, 'latin1'), 'Ghi chú chung');
});
test('caps fonts show capitals', () => assert.equal(decodeTcvn3('mÆt c¾t', true, 'latin1'), 'MẶT CẮT'));
test('a byte the decoder could not map does not stop the rest', () =>
  assert.equal(decodeTcvn3('Cöa ®i ch�nh', false, 'latin1'), 'Cửa đi ch�nh'));
test('text decoded as windows-1258 maps back to its bytes first', () => {
  const bytes = new Uint8Array([0x63, 0xf6, 0x61]); // "cửa" in TCVN3 bytes
  const asRead = new TextDecoder('windows-1258').decode(bytes);
  assert.equal(decodeTcvn3(asRead, false, 'windows-1258'), 'cửa');
});
test('font files are recognised', () => {
  for (const f of ['.VnTime', 'VNTIME_1.TTF', 'vn-abc.shx', 'vnsimple.shx', 'Vnarial_0.ttf']) assert.equal(legacyFontOf(f), 'tcvn3');
  for (const f of ['.VnArialH', 'VHTIME_0.TTF', 'VHARIAL.TTF']) assert.equal(legacyFontOf(f), 'tcvn3-caps');
  for (const f of ['Arial', 'TIMES.TTF', 'txt.shx', 'romans.shx', undefined]) assert.equal(legacyFontOf(f), null);
});
test('only text drawn in a TCVN3 font is converted', () => {
  // STYLE VN → .VnTime, STYLE STD → Arial; TEXT "cöa" in each, plus "30×30" in Arial
  const objects = parseDxf(fixtureWithStyles()).objects;
  assert.deepEqual(objects.map((o) => o.text), ['cửa', 'cöa', '30×30']);
});
test('an MTEXT font switch converts only its own span', () => {
  // MTEXT in an Arial style: "Plan {\f.VnTime|b0;cöa} ×2"
  assert.equal(parseDxf(fixtureMtextSwitch()).objects[0].text, 'Plan cửa ×2');
});
test('attributes and dimension texts in TCVN3 styles are converted too', () => {
  // INSERT with ATTRIB (style VN) value "TÇng 2"; DIMENSION whose *D block holds TEXT (style VN) "phßng 25m"
  const { objects } = parseDxf(fixtureAttribAndDimension());
  assert.equal(objects.find((o) => o.type === 'INSERT')!.attributes![0].value, 'Tầng 2');
  assert.equal(objects.find((o) => o.type === 'DIMENSION')!.text, 'phòng 25m');
});
```

Fixtures are inline DXF built with the helpers already used in `test/parse-fixes.test.ts` (`dxf`, `entities`, a STYLE table with `2 name / 3 font`).

- [ ] **Step 2: Run** `npm test` — expected: the new tests fail (module missing).
- [ ] **Step 3: Implement** `src/dxf/vietnamese.ts`, `legacyEncodingOf`, and the parser changes. `scanTextStyles` additionally returns `fontFiles: Record<STYLE_UPPER, string>`; a helper `textLegacyFont(raw, context)` mirrors `resolveTextFont`'s style lookup. `cleanMtext(raw, baseFont: LegacyFont = null, decodedWith = 'latin1')`: push the current font on `{`, pop on `}`, set it on `\f<name>|…;`; decode characters appended while the current font is TCVN3. `ParseContext` gains `fontFiles` and `legacyEncoding`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — all pass. Run `node out-test/corpus.js` over the public set and the private set (`--baseline=…/dwg/corpus-baseline.private.json`) — both "Matches the baseline exactly". Render a private TCVN3 drawing with `npm run preview -- <drawing> out-test/ui --search=<word>` and check by eye that its labels read as Vietnamese.
- [ ] **Step 5: Commit** — `Read TCVN3 Vietnamese text as Unicode`.

### Task 2: Dimension list with nested dimensions

**Files:**
- Modify: `src/shared/types.ts`, `src/dxf/parseDxf.ts` (`expandDimension` / dimension fallback record every dimension)
- Test: `test/dimension.test.ts`

**Interfaces:**
- Produces: `interface DimensionInfo { obj: number; text: string; position: Point2D; measurement?: number }` and `ParsedDxf.dimensions?: DimensionInfo[]` — every DIMENSION drawn on a page (not viewport collection), top-level or inside an INSERT. `obj` = the top-level object it belongs to (for a nested one, the INSERT). `position` = world position of the dimension text (`middleOfText` through the current transform). `measurement` = group 42 when present (lets the agent spot overridden text).

- [ ] **Step 1: Failing tests**: `'a dimension inside a block is listed against its INSERT'` (block with one DIMENSION, INSERT at (100,0) ×2 → one `DimensionInfo` with `obj` = the INSERT's index, text as drawn, `position.x` = 100 + 2×text x); `'top-level dimensions are listed with their own object'`; `'viewport collection adds no dimensions'` (reuse the viewport fixture style in `test/parse-fixes.test.ts`); `'measurement is kept beside an overridden text'` (text `"L=25m"`, 42 = 25000).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**: push to `context.dimensions` where a DIMENSION is collected and `context.keep === null` (same rule as `recordMeasure`).
- [ ] **Step 4: Run** `npm test`, typecheck, both corpora — pass / match.
- [ ] **Step 5: Commit** — `List every dimension, including those inside blocks`.

### Task 3: Drawing store and disk cache

**Files:**
- Create: `src/ai/diskCache.ts`, `src/ai/drawingStore.ts`
- Modify: `src/dwgEditorProvider.ts` (replace `parseCache` / `inFlight` / `loadDrawing` with the shared store; keep behaviour: memory only, 4 entries)
- Test: `test/drawingStore.test.ts`

**Interfaces:**
- Produces (`drawingStore.ts`, no `vscode` import):

```ts
export const CACHE_FORMAT = 1; // bump whenever parser output changes
export interface DrawingKey { path: string; mtimeMs: number; size: number }
export interface StoredDrawing { key: DrawingKey; parsed: ParsedDxf }
export type LoadStage = 'reading' | 'converting' | 'parsing';
export interface StoreDeps {
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  parse(path: string, progress: (s: LoadStage) => void): Promise<ParsedDxf>;
  disk?: DiskCache;
  capacity: number; // in-memory entries
}
export class DrawingStore {
  constructor(deps: StoreDeps);
  /** persist: also read/write the disk cache (AI side only). */
  get(path: string, opts?: { progress?: (s: LoadStage) => void; persist?: boolean }): Promise<StoredDrawing>;
  forget(path: string): void;
}
export function sameKey(a: DrawingKey, b: DrawingKey): boolean;
```
  Concurrent `get`s of one key share one parse and all receive progress (today's `inFlight` behaviour). The key is taken from a `stat` **before** parsing; after parsing, `stat` again — if it changed, return the result but do not cache it.
- Produces (`diskCache.ts`):

```ts
export class DiskCache {
  constructor(dir: string, limits?: { entries: number; bytes: number }); // defaults 30, 500 * 1024 * 1024
  read(key: DrawingKey): Promise<ParsedDxf | undefined>;   // undefined on miss, other key, other CACHE_FORMAT, or corrupt file (which it deletes)
  write(key: DrawingKey, parsed: ParsedDxf): Promise<void>; // then evicts oldest by mtime beyond limits
  clear(): Promise<number>;                                 // files removed
}
```
  File name: `sha256(path).json.gz`; body `{ format, key, parsed }`. Write to a temp name then rename.
- Consumes: provider passes `parse = (path, progress) => worker.run(await fs.readFile(path), path, converterPath, progress)` with the `reading` stage emitted first.

- [ ] **Step 1: Failing tests** with a fake `parse` counting calls and a temp dir:
  - `'a second question on an unchanged file does not parse again'` (2 gets → 1 parse)
  - `'a changed mtime or size parses again'`
  - `'persisted drawings load from disk in a new store without parsing'` (store A writes, store B with same dir → 0 parses)
  - `'the preview path never touches the disk'` (`persist` false → dir stays empty)
  - `'a cache file from another CACHE_FORMAT or a corrupt file is ignored and removed'` (write garbage → get parses, file replaced)
  - `'a file changed during parsing is not cached'` (stat returns new mtime on second call → next get parses again)
  - `'eviction keeps the newest 30 files'` (limits `{entries: 3, bytes: Infinity}` for the test)
  - `'concurrent gets share one parse and both see progress'`
  - `'a deleted drawing gives a clear error'` (stat rejects ENOENT → rejects with message containing the path)
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement** both modules; refactor `dwgEditorProvider.ts` to construct nothing itself but receive the store (`new DwgEditorProvider(context, store)`), keeping its watcher calling `store.forget(path)` on delete.
- [ ] **Step 4: Run** `npm test`, typecheck. Open a drawing via `npm run preview` (unchanged output).
- [ ] **Step 5: Commit** — `Share drawing loading through a store with an optional disk cache`.

### Task 4: Drawing index and the read tools

**Files:**
- Create: `src/ai/drawingIndex.ts`, `src/ai/tools.ts`
- Test: `test/aiTools.test.ts`

**Interfaces:**
- Produces (`drawingIndex.ts`): `class DrawingIndex { constructor(parsed: ParsedDxf); bounds(id): Bounds | undefined; mainExtents(page): Bounds | null; surroundings(id, count): { inside: Brief[]; nearby: Brief[] } }` and `indexOf(stored: StoredDrawing): DrawingIndex` (memoised in a `WeakMap`). Rules from the spike: bounds from page entities by `obj`; main extents = boxes of objects whose centres lie between the 1st and 99th percentile in x and y; *inside* = objects containing the centre and > 5× its largest side, smallest 3; *nearby* = nearest by distance to box, excluding containers. `fold(s)` = NFD, strip U+0300–U+036F, `đ→d`, lower case.
- Produces (`tools.ts`, no `vscode` import):

```ts
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
export interface PreviewControl {
  show(path: string, key: DrawingKey, req: ShowRequest): Promise<string>;      // summary of what was done
  snapshot(path: string, key: DrawingKey, req: SnapshotRequest): Promise<string>; // base64 PNG
}
export interface ShowRequest { objects?: number[]; page?: number; layers?: { show?: string[]; hide?: string[]; only?: string[] }; fit?: boolean }
export interface SnapshotRequest { page: number; region?: Bounds; around?: number; margin?: number }
export interface ToolHost { store: DrawingStore; checkAccess(path: string): Promise<string>; preview?: PreviewControl }
export const TOOL_DEFINITIONS: { name: string; description: string; inputSchema: object }[];
export function callTool(host: ToolHost, name: string, args: Record<string, unknown>): Promise<ToolContent[]>;
```
  Every tool: `checkAccess(path)` first (returns the real path), then `store.get(real, { persist: true })`. Errors become one text item starting `Error:`. Outputs and descriptions as in the spec (copy the spike's descriptions, adjusted: `dwg_dimensions` reads `ParsedDxf.dimensions`; `dwg_overview` adds `mainExtents` and title-block attributes = attributes of INSERTs on paper pages). Text output capped at 100,000 chars with `"truncated": true` and totals kept.
- Consumes: `DrawingStore` (Task 3), `ParsedDxf.dimensions` (Task 2), TCVN3 text (Task 1).

- [ ] **Step 1: Failing tests** on a fixture drawing (inline DXF: a frame block around everything, MTEXT `12 cửa 30x30`, MTEXT `L=15m` 500 units away, a far-away stray POINT at 10⁶, a DIMENSION 25000, an INSERT holding a DIMENSION 3500):
  - overview: `units === 'NOT DECLARED'` without `$INSUNITS`; `'millimetre'` with 4; `mainExtents` excludes the stray point; `objectTypes`, `blocks` counts.
  - find_text: `query: 'cua'` finds `12 cửa 30x30`; its `inside` lists the frame and `nearby[0].text === 'L=15m'`; `limit` respected and `totalMatches` exact.
  - dimensions: `valueCounts` has `"25000": 1` and `"3500": 1` (nested one included), each with `center`.
  - **Review Focus 4**: 20,000 MTEXT objects, `dwg_find_text` without query → output ≤ 100,000 chars, `"truncated": true`, `totalMatches: 20000`.
  - access denial propagates: `checkAccess` rejects → result text starts `Error:` and mentions the user declined.
  - `dwg_show` / `dwg_snapshot` without `preview` → `Error:` "open VS Code" style message (server running outside the extension).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, typecheck.
- [ ] **Step 5: Commit** — `Add the drawing index and MCP read tools`.

### Task 5: File access

**Files:**
- Create: `src/ai/access.ts`, `src/ai/windows.ts`
- Test: `test/aiAccess.test.ts`

**Interfaces:**
- Produces (`access.ts`, no `vscode`):

```ts
export class AccessDenied extends Error {}
export interface AccessDeps {
  workspaceFolders(): Promise<string[]>;  // all windows (from WindowRegistry)
  openPreviews(): string[];               // real paths of open preview tabs
  ask(path: string): Promise<boolean>;    // modal; false = Deny
  realpath(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
}
export function createAccessCheck(deps: AccessDeps): (path: string) => Promise<string>; // real path or throws AccessDenied
```
  Rules: path must be absolute; resolved with `realpath`; must be a file; extension `.dwg`/`.dxf` case-insensitive; allowed if inside a folder (compare real paths, separator-terminated, case-insensitive on Windows) or an open preview; else `ask` once per real path per session (remember both answers).
- Produces (`windows.ts`, node fs only): `class WindowRegistry { constructor(dir: string, id: string); publish(folders: string[]): Promise<void>; folders(): Promise<string[]>; dispose(): Promise<void> }` — one JSON per window `{ folders, updated }`; `folders()` returns the union from files updated in the last 60 s; publish every 20 s from the host (Task 9).

- [ ] **Step 1: Failing tests** (temp dirs, real symlinks):
  - inside a folder → allowed without asking; open preview outside folders → allowed without asking
  - outside → asks once; second call same path → no second ask; Deny → `AccessDenied` both times
  - **Review Focus 3**: relative path → `AccessDenied`; `ws/../outside/a.dwg` → asks; symlink `ws/link.dwg → outside/a.dwg` → asks (real path outside); directory `ws/x.dwg/` → `AccessDenied`; `ws/A.DWG` → allowed; `ws/a.txt` → `AccessDenied`
  - registry: two windows publish → union; a file older than 60 s ignored
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — pass.
- [ ] **Step 5: Commit** — `Check which drawings an agent may read`.

### Task 6: HTTP MCP server with standby

**Files:**
- Create: `src/ai/server.ts`
- Modify: `package.json` (dependency `"@modelcontextprotocol/sdk": "1.32.1"`), `esbuild.js` (bundle it into `out/extension.js`; check bundle growth stays under 1 MB), `THIRD_PARTY_NOTICES.md`
- Test: `test/aiServer.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ServerOptions { port: number; token: string; host: ToolHost; log(msg: string): void; retryMs?: number /* default 5000 */ }
export interface RunningServer { readonly serving: boolean; readonly url: string; onServingChange(cb: (serving: boolean) => void): void; close(): Promise<void> }
export function startMcpServer(opts: ServerOptions): Promise<RunningServer>;
```
  `url` = `http://127.0.0.1:<port>/mcp`. Uses SDK `Server` with `tools: {}` capability, `ListTools` → `TOOL_DEFINITIONS`, `CallTool` → `callTool`; `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`), one transport per request. Before the SDK sees a request: 401 without the exact bearer token (constant-time compare), 403 if an `Origin` header is present, 404 for any path but `/mcp`. On `EADDRINUSE` the instance stands by and retries `listen` every `retryMs`; `serving` flips when it binds.

- [ ] **Step 1: Failing tests** (ports from 0 → pick a free port first; `retryMs: 100`):
  - initialize + `tools/list` over HTTP returns the five tool names
  - `tools/call dwg_overview` on a fixture file returns JSON text
  - no token → 401; wrong token → 401; `Origin: http://evil.example` → 403; `/other` → 404
  - **Review Focus 2**: start A then B on the same port → A serving, B not; `A.close()` → B serving within 1 s; a client using the same URL succeeds against B
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** tests + `npm run build` (bundle size noted in the commit message).
- [ ] **Step 5: Commit** — `Serve the drawing tools over local MCP HTTP`.

### Task 7: Webview agent channel (show + snapshot)

**Files:**
- Create: `src/webview/agent.ts`
- Modify: `src/webview/main.ts` (store `key` from `DXF_DATA`; handle `AGENT_SHOW` / `AGENT_SNAPSHOT`; reply `AGENT_RESULT`), `src/webview/export.ts` (reuse its rasterising for a region at 1600×1200), `src/dwgEditorProvider.ts` (send `key` with `DXF_DATA`)
- Test: `test/agentWebview.test.ts`

**Interfaces:**
- Messages (add to `src/shared/types.ts`):
  - host → webview `{ type: 'AGENT_SHOW'; requestId: string; key: DrawingKey } & ShowRequest`
  - host → webview `{ type: 'AGENT_SNAPSHOT'; requestId: string; key: DrawingKey } & SnapshotRequest` (region already resolved by the host)
  - webview → host `AgentResult = { type: 'AGENT_RESULT'; requestId: string; ok: boolean; message: string; png?: string }` (exported type)
- Produces (pure, testable): `nextHiddenLayers(all: string[], hidden: Set<string>, req: ShowRequest['layers']): Set<string>` (`only` wins; unknown names reported back) and `regionViewBox(b: Bounds): ViewBox` (y-flipped like `fitBounds`, no padding).
- `AGENT_SHOW`: if `key` ≠ the drawing's current key → `ok: false, message: 'The drawing changed since it was read; read it again.'`; else page switch, layers, `select(objects, { zoom: true, inspect: objects.length === 1 })` or fit; message e.g. `Highlighted 18 objects on Model Space and zoomed to them.`
- `AGENT_SNAPSHOT`: same key check; render the page into an offscreen SVG with `regionViewBox`, rasterise, `png` = base64.

- [ ] **Step 1: Failing tests** for `nextHiddenLayers` (show/hide/only, unknown names) and `regionViewBox`; plus **Review Focus 1** as a pure test of the key check helper `keyMatches(current: DrawingKey | undefined, asked: DrawingKey): boolean`.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.**
- [ ] **Step 4: Run** tests; extend `scripts/preview.ts` with `--agent-show=<json>` and `--agent-snapshot=<json>` (post the message, screenshot / save the PNG) and check both by eye on the AEC sample: doors highlighted; a region PNG of the lobby. Snapshot time for a large private drawing (tens of thousands of objects) < 2 s (log it).
- [ ] **Step 5: Commit** — `Let the agent highlight, zoom and snapshot in the preview`.

### Task 8: Preview bridge in the extension host

**Files:**
- Create: `src/ai/previewBridge.ts`
- Modify: `src/dwgEditorProvider.ts` (register each panel with the bridge, forward `AGENT_RESULT`)
- Test: `test/previewBridge.test.ts` (the correlation logic, with a fake panel)

**Interfaces:**
- Produces: `class PreviewBridge implements PreviewControl { register(path: string, panel: PanelLike, currentKey: () => DrawingKey | undefined): { dispose(): void }; receive(message: AgentResult): void; openPaths(): string[] }` where `PanelLike = { postMessage(m: unknown): Thenable<boolean>; reveal(): void; active: boolean }`. `show`/`snapshot`: pick the active panel for the path, else the most recently registered; none → open with `vscode.commands.executeCommand('vscode.openWith', uri, 'dwgPreviewer.dwgView', { preserveFocus: true })` (injected `open(path)`), wait for registration + its first `DXF_DATA` (max 30 s); post; await `AGENT_RESULT` with the same `requestId` (timeout 20 s → error). For snapshot, resolve `around` to a region on the host with `DrawingIndex` before posting.
- Consumes: `DrawingIndex` (Task 4), messages (Task 7).

- [ ] **Step 1: Failing tests**: result routed by `requestId`; timeout rejects; **Review Focus 1** end-to-end with a fake panel whose `currentKey` differs → `show` rejects with the "drawing changed" message; no panel → `open` called, then resolves after a panel registers.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — pass.
- [ ] **Step 5: Commit** — `Route agent requests to the drawing's preview`.

### Task 9: Extension wiring, settings, Copilot provider

**Files:**
- Create: `src/ai/extensionHost.ts`
- Modify: `src/extension.ts`, `package.json`
- Test: manual (Step 4)

**Interfaces:**
- Produces: `startAiFeature(context, store, bridge, log): vscode.Disposable` — reads `dwgPreviewer.ai.enabled` / `.port`, gets or creates the token, starts `WindowRegistry` (publish workspace folders now, every 20 s, and on folder change), builds `ToolHost` (`checkAccess` from Task 5 with `ask` = `vscode.window.showWarningMessage(…, { modal: true }, 'Allow')`), starts the server, registers the Copilot provider when the API exists (`new vscode.McpHttpServerDefinition('DWG Previewer', vscode.Uri.parse(url), { Authorization: \`Bearer ${token}\` })`), restarts on setting change, stops when disabled.
- `package.json`: `activationEvents: ["onStartupFinished"]`; settings `dwgPreviewer.ai.enabled` (boolean, true, "Let AI agents in VS Code (Claude Code, Copilot, Kiro) read drawings through a local MCP server."), `dwgPreviewer.ai.port` (number, 45131, `scope: machine`); commands `dwgPreviewer.connectAgents` "Connect AI Agents…", `dwgPreviewer.clearDrawingCache` "Clear Drawing Cache" (category DWG); `contributes.mcpServerDefinitionProviders: [{ "id": "dwgPreviewer.mcp", "label": "DWG Previewer" }]`.
- The store's disk cache is created only when enabled: `new DiskCache(joinPath(globalStorageUri, 'drawing-cache').fsPath)`.
- `clearDrawingCache` calls `DiskCache.clear()` and shows "Removed N cached drawings."; when the feature is off it shows "There is no drawing cache (AI features are off)."

- [ ] **Step 1:** Implement; `npm run typecheck`, `npm test`, `npm run build`.
- [ ] **Step 2:** Package (`npm run package`) and install into VS Code. Check: Output channel logs `AI server serving on http://127.0.0.1:45131/mcp`; a second window logs standby; closing the first → second logs serving.
- [ ] **Step 3:** Copilot Chat (agent mode) lists the five tools; asks "how many doors in <AEC sample>?" → answer 57 and the preview highlights them after `dwg_show`.
- [ ] **Step 4:** Setting `ai.enabled` false → server stops, nothing in `drawing-cache/`.
- [ ] **Step 5: Commit** — `Start the AI server with the extension; Copilot provider`.

### Task 10: Connect Claude Code (and Kiro)

**Files:**
- Create: `src/ai/connect.ts`
- Modify: `src/ai/extensionHost.ts`
- Test: `test/aiConnect.test.ts` (command building and CLI discovery with fakes)

**Interfaces:**
- Produces: `claudeAddArgs(url: string, token: string): string[]` → `['mcp', 'add', '--scope', 'user', '--transport', 'http', 'dwg-previewer', url, '--header', 'Authorization: Bearer <token>']`; `claudeRemoveArgs(): ['mcp','remove','--scope','user','dwg-previewer']` (renamed from `dwg` in the final review); `findClaudeCli(deps: { which(name): Promise<string | undefined>; claudeExtensionPath(): string | undefined; exists(p): Promise<boolean> }): Promise<string | undefined>` — PATH first, then the binary bundled in the `anthropic.claude-code` extension (verify the location in the installed extension and encode it here; cover both `.../resources/native-binary/claude` and `claude.exe` if that is what is found).
- Flow (`extensionHost.ts`): first time any drawing opens and `globalState['dwgPreviewer.ai.prompted']` is unset → info message "Let Claude Code read your drawings?" [Connect] [Not now] [Don't ask again]. `connectAgents` command → quick pick: Connect Claude Code / Disconnect Claude Code / Show setup for other agents (opens an untitled JSON with the URL and header for Kiro or anything else). Connect runs `remove` (ignore failure) then `add`; on success "Connected. New Claude Code conversations can read drawings." If no CLI → show the exact command and a link to `https://code.claude.com/docs/en/mcp`. Remote window where `vscode.env.remoteName` is set and the Claude Code extension is not installed in the same host → explain instead of registering.
- When the port changes (setting or standby on another port is not possible — standby keeps the same port), re-run Connect automatically only if the user had connected before (`globalState['dwgPreviewer.ai.connected']`).

- [ ] **Step 1: Failing tests**: `claudeAddArgs` exact array; `findClaudeCli` prefers PATH, falls back to the extension path, returns undefined when neither exists.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** tests; then manually: Connect from the command → `claude mcp list` shows `dwg-previewer` (http); a new Claude Code conversation in the VS Code extension answers a question from the private question set correctly; Disconnect → gone from `claude mcp list`. Kiro: check whether it sees the provider; record the result in PROGRESS.md.
- [ ] **Step 5: Commit** — `Connect Claude Code to the drawing tools in one click`.

### Task 11: Agent evaluation harness

**Files:**
- Create: `scripts/aiEval.ts` (bundled like `test/corpus.ts`), question sets: a private one outside the repo (never committed) and `test/ai-eval.public.json` (AEC sample, paths relative to `$DWG_SAMPLES`)
- Modify: `esbuild.js` (`--ai-eval` target)

**Interfaces:**
- Question file: `[{ "drawing": "<abs path>", "question": "…", "expect": ["120.5"], "forbid": ["122.5"], "source": "MTEXT 12 + DIMENSION ×4 120500" }]`.
- `node out-test/aiEval.js <questions.json>`: starts `startMcpServer` in-process on a free port with `checkAccess` = allow-all and no `preview`, writes a temp `--mcp-config` (http + header), runs `claude -p --strict-mcp-config --allowedTools mcp__dwg-previewer__dwg_overview,mcp__dwg-previewer__dwg_find_text,mcp__dwg-previewer__dwg_dimensions` per drawing with all its questions, saves the answers to `out-test/ai-eval-<date>.md`, and marks each question PASS (all `expect` present, no `forbid`) or CHECK.

- [ ] **Step 1:** Write the private question set from the spike (totals, spans, counts, sizes and notes on the private drawings, with the drawing's undeclared units; kept outside the repo). Write the public set on the AEC sample (doors 57, windows, the lobby label, a room label's position).
- [ ] **Step 2:** Implement and run. **Expected:** every expected number PASS; any CHECK reviewed by hand and either fixed (tool output / description) or explained in the report. A wrong number blocks the release (spec).
- [ ] **Step 3: Commit** the script and the public set only (never the private set) — `Add the AI agent evaluation harness`.

### Task 12: Docs, cleanup, release prep

**Files:**
- Modify: `README.md`, `MARKETPLACE.md` (feature section "Ask AI about your drawing", privacy paragraph from the spec, setup per agent, limitation: works while VS Code is open), `PROGRESS.md` (what was built, eval results, Kiro finding, bundle size), `.gitignore` (drop `out-spike/`)
- Delete: `spike/` (untracked), `out-spike/`

- [ ] **Step 1:** Write the docs; check MARKETPLACE copy names no client.
- [ ] **Step 2:** `npm run typecheck && npm test && npm run test:corpus -- <public set>` and the private corpus; `npm run package`; install; repeat Task 9 Step 3 and Task 10 Step 4 on the packaged build.
- [ ] **Step 3: Commit** — `Docs for the AI drawing reader`.
