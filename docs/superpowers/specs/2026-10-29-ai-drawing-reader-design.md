# AI drawing reader (MCP) — design

Date: 2026-10-29 · Status: draft for owner review · Spike: branch `spike/mcp`, `spike/mcp/server.ts`

## Intent

Let the AI agent a user already runs inside VS Code — chiefly the **Claude Code VS Code extension**,
also GitHub Copilot and Kiro — read a DWG / DXF drawing the way an engineer reads it in CAD: know
what sheet and view it is looking at, read the notes and labels (including old Vietnamese TCVN3
text), take sizes from the dimensions the drafter placed, tie a label to the thing it names, and
look at the picture to understand layout.

Questions the owner gave as typical: *how many doors; where are the toilets; what size is it; what
size are the beams and columns; how long and wide is it.* On a client's bridge drawings the spike
answered questions about *overall length, span arrangement, foundations, declared units, design
options and how they differ* — all correct where checked — and unprompted found inconsistencies
between the drawing's own notes and dimensions.

**Success, in the owner's words:** the numbers the AI gives must match what an engineer reads off
the drawing. A wrong beam size is worse than "not found".

## Goals

1. An MCP server shipped **inside the extension** (no separate install, no Node.js to install).
2. Tools that let an agent read: overview, text search with surroundings, dimensions, snapshot
   (detailed below).
3. **Tools that let the agent show the user** on the open preview (owner, 2026-10-29: yes, in this
   version): "where are the piles?" answers in words *and* the preview highlights and zooms to them;
   the agent can also switch page and show / hide layers.
4. Every number traceable: tools return the object id, layer, page and position it came from, so
   the agent can cite it and the user can check it.
5. Units handled honestly: the declared unit when there is one; otherwise "not declared" and the
   agent must state any inference and its reasoning.
6. **TCVN3 text decoded to Unicode in the parser** — fixes the preview for Vietnamese users today
   (they currently see `cöa` for `cửa`) and is required for the AI to understand the text.
7. **Read once, answer many** (owner's requirement): a drawing is converted and parsed once; later
   questions read a cache; the cache is refreshed only when the file changes.
8. One-click setup for Claude Code; automatic for Copilot. **On by default** (owner, 2026-10-29),
   so every user discovers it.

## Non-goals (this version)

- Editing drawings in any form. Writing DWG is out entirely (libredwg's writer is experimental and
  can lose AutoCAD data). DXF editing may come later as its own design.
- A standalone package for agents outside VS Code (npm, Claude Desktop `.mcpb`). The core is
  written so this can be added; it is not built now.
- Drawing LEADER / MULTILEADER / TABLE in the preview (separate backlog item). The reader may still
  expose their text if the parser can read it cheaply — builder's call.
- VNI encoding (none in the sample drawings; add when a drawing shows it).

## Anti-goals (failure even if it "works")

- An AI answer containing a number the tools did not return, presented as fact. Tool descriptions
  must steer agents to cite sources and say "not found"; tools must never return guessed values.
- Changing the user's Claude Code / Kiro configuration without asking, or in a way that cannot be
  undone from the extension.
- Writing cache or config files into the user's project folder or Git repository.
- Sending drawing content anywhere except the agent the user is talking to.
- Breaking the viewer for the ~1,350 existing users (Marketplace + Open VSX), including those on
  VS Code older than the MCP APIs (`engines.vscode` stays `^1.85.0`; the feature registers only when
  the API exists).
- A local server any process or web page on the machine can query (see Security).

## Constraints and facts established

- VS Code API `vscode.lm.registerMcpServerDefinitionProvider` is stable since **1.101**
  (checked in `@types/vscode` 1.100 vs 1.101). `vscode.lm.registerTool` since 1.95.
- Claude Code docs: the VS Code extension and the CLI share one MCP configuration; installing the
  extension does **not** put `claude` on PATH (it bundles a private copy); whether Claude Code picks
  up servers registered through VS Code's MCP provider API is **not documented**.
  `claude mcp add` supports `--transport http`, `--scope user`, `--header`.
- Language: TypeScript, reusing `src/dxf`, `src/dwg`, `src/diff`, `src/webview` code.
- License: GPL-3.0-or-later like the rest.
- Measured (spike, this machine):

  | Drawing | Convert + parse | Reload from gzip JSON cache | Cache size (gz) |
  |---|---|---|---|
  | 420 KB DWG | 0.7 s | 0.02 s | 0.3 MB |
  | A large DWG (~50k objects) | 4.8 s | 0.22 s | 3.2 MB |
  | GridElevation, 245k objects | 4.0 s | 0.47 s | 1.7 MB |

  In-memory hit in one server process: ~0.03 s. Spike snapshot via headless Chromium: ~6 s.

## Decided design

### Where it runs (my call)

The MCP server runs **in the extension host** and listens on **HTTP on 127.0.0.1** (MCP streamable
HTTP transport), rather than as a separate stdio process:

- it shares the extension's drawing cache, so a drawing open in the preview costs the agent nothing;
- no Node.js runtime question at all — it lives in VS Code's own process;
- it can reach the open preview's webview, which the "show" tool needs.

Consequence: the server exists only while VS Code is running. That matches the target (agents
inside VS Code); an agent run outside VS Code gets a connection error, which the docs must state.

Parsing stays in the existing `DrawingWorker` (worker thread), so a large drawing never blocks the
extension host.

**Several VS Code windows (my call).** Every window has its own extension host. Whichever window
binds the fixed port serves all agents; the others stand by and try to bind again when the port
frees (e.g. every few seconds, or when a request to the serving window fails), so closing the
serving window hands over without the user reconnecting. All windows share one token
(`SecretStorage` is per user, not per window), so one `claude mcp add` entry works whichever window
serves. File access is checked against the workspace folders of all windows (see Security).

**Remote / WSL / dev containers (my call).** The server runs wherever the extension host runs.
Supported when the agent runs on the same machine as the extension host (the usual case: the
Claude Code extension in a remote window also runs remotely). Otherwise not supported, and the
Connect command says so instead of registering an unreachable URL.

**Lazy start (final review).** The feature is on by default for every user, but the server, the
token (OS keyring) and the window registry start with VS Code only for users who connected or used
AI before (a `globalState` flag). Everyone else starts them on the first drawing they open, on
Connect, or when Copilot resolves the server; the first Copilot use in a session may wait for that.

**VS Code versions (my call).** The HTTP server and the Claude Code Connect flow need no new API and
work on every supported VS Code (1.85+), and in forks such as Kiro whatever API level they report.
Only the Copilot provider (`registerMcpServerDefinitionProvider`) is registered when that API exists.

### Security

- Bound to `127.0.0.1` only.
- Every request must carry `Authorization: Bearer <token>`; the token is random, created once,
  stored in the extension's `SecretStorage`, and written into the agent configuration at connect.
- Reject requests with a browser `Origin` header (DNS-rebinding / web-page access).
- **File access (owner, 2026-10-29).** Tools take an absolute path, which must be a file ending in
  `.dwg` / `.dxf`. Allowed without asking: drawings inside an open workspace folder of any VS Code
  window, and drawings the user has open in a DWG preview tab. Anything else: VS Code asks the user
  first — a modal "Allow the AI agent to read *plan.dwg* (`/full/path`)?" [Allow] [Deny] — and the
  answer is remembered for that file until VS Code restarts. Denied → the tool returns an error
  saying the user declined. A prompt left unanswered for 60 s (e.g. in a window the user is not
  looking at) denies that one call without remembering it, and the next prompt may show (final review). Why: the token keeps *other programs* out, but not the agent itself; an
  agent misled by a prompt injection could otherwise read any client's drawing on the machine.
  Since only one window serves, the windows share their workspace folder lists (e.g. a small file in
  `globalStorageUri` each window keeps current); the prompt appears in the serving window, which is
  brought to the front.

### Connecting agents

| Agent | How |
|---|---|
| GitHub Copilot (VS Code ≥ 1.101) | `registerMcpServerDefinitionProvider` returns an HTTP definition with the token header. Automatic; VS Code asks the user to trust it as for any MCP server. |
| Claude Code (VS Code extension or CLI) | First time a drawing is opened (and via command **DWG: Connect AI agents…**): a notification "Let Claude Code read your drawings?" [Connect] [Not now] [Don't ask again] — only when Claude Code is present (a `claude` on PATH or the `anthropic.claude-code` extension installed; final review). Connect runs `claude mcp add --scope user --transport http dwg-previewer <url> --header "Authorization: Bearer <token>"` using `claude` from PATH, or else the CLI bundled in the Claude Code extension (`vscode.extensions.getExtension('anthropic.claude-code')`) — builder verifies the bundled binary's location and that `mcp add` works through it. If neither exists, show the exact command / JSON to paste and a link to the docs. **Never edit `~/.claude.json` directly.** |
| Kiro | Best effort. Builder verifies whether Kiro honours the VS Code MCP provider API; if not, the Connect command offers Kiro's config snippet to paste. |

- **Disconnect**: the same command offers Disconnect, which runs `claude mcp remove --scope user dwg-previewer`.
  The name is specific (final review): Connect removes and re-adds only `dwg-previewer`, never a
  user's own server with a generic name such as `dwg`.
- **Port**: a fixed default (setting `dwgPreviewer.ai.port`, default chosen by builder in the
  dynamic range). If it is taken, pick a free one and tell the user their agent needs reconnecting
  (re-run add). The registered URL must stay valid across VS Code restarts when the port is free.
  *Final review:* a busy port is checked before standing by — the occupant must prove it holds the
  token (`POST /mcp-identity` answers HMAC-SHA256(token, nonce); the token is never sent). If it is
  not ours, the user is told once "Port N is used by another program, so AI features are off. Change
  dwgPreviewer.ai.port.", Connect and the Copilot provider offer no server, and the server keeps
  retrying in case the port frees. Other listen errors are shown with their real reason.
- Setting `dwgPreviewer.ai.enabled`, **default true** (owner's decision), turns the server off
  entirely. The first-open notification still asks before touching Claude Code's configuration —
  on by default means the server runs and Copilot can see it, not that other tools are configured
  silently.

### Tools

All tools take `path` (absolute `.dwg` / `.dxf`). Output is compact JSON text; ids are indices into
the drawing's object table and stay valid while the file is unchanged.

1. **`dwg_overview`** — start here. File name; units (`"NOT DECLARED"` with instructions otherwise);
   pages with object counts, extents and **main extents** (middle 98% of objects — stray far-away
   objects otherwise shrink the sheet to a speck, seen on a private drawing); layers with counts;
   object types; block counts by effective name; entity types not read; longest notes (design notes
   carry spans, loads, pile data). Title-block attributes if present.
2. **`dwg_find_text`** — case- and accent-insensitive search (`cua` finds `cửa`, `dam` finds `Dầm`)
   over TEXT, MTEXT, dimension text, block names, attribute values. Per match: id, type, layer,
   page, centre, size, plus **inside** (up to 3 smallest objects containing it: frame, title block,
   detail block) and **nearby** (nearest objects that are not containers, with distance). The spike
   showed both are needed: without separating containers, every label's "nearest" was the sheet
   frame; with it, a size note came back next to its length note and the detail's scale.
3. **`dwg_dimensions`** — dimensions with their displayed value, count per value (`25000 × 20`),
   orientation, position; filters by page, layer, circle. **Must include dimensions inside blocks**
   (the spike missed a whole elevation's dimensions because they were inside an INSERT).
4. **`dwg_snapshot`** — PNG of a page (default: main extents), a region in drawing coordinates, or
   the area around an object id. For layout only; tool description tells the agent to take numbers
   from the other tools. **Rendering approach is the builder's**: the spike used headless Chromium
   (6 s, needs a browser — not acceptable for users); candidates are rendering from the existing
   webview renderer inside a webview the extension controls, or a WASM rasterizer of an SVG string.
   Target: under 2 s for a large drawing (tens of thousands of objects).

5. **`dwg_show`** — drive the preview. Arguments: `path`, and any of `objects` (ids from the other
   tools: highlight them with the existing selection highlight and zoom to them), `page` (switch to
   it), `layers` (`{ show?: string[], hide?: string[], only?: string[] }`), `fit` (zoom to the page's
   main extents). If the drawing is not open, open it in the DWG preview first
   (`vscode.openWith`); if it is open in several tabs, use the active or most recent one.
   - Reuses what the webview already has: `select(objs, { zoom: true })`, page switching, layer
     visibility. New webview message (e.g. `AGENT_SHOW`).
   - **Ids must mean the same thing on both sides.** The tool sends the cache key it read (path,
     mtime, size, `CACHE_FORMAT`) with the ids; the preview refuses and the tool returns an error
     ("the drawing changed, read it again") if its own parse is of a different version.
   - View-only: never writes the file; layer changes are the preview's on/off state, as if the user
     clicked them. The user can undo with the layer panel or Fit.
   - Returns what was done ("highlighted 18 objects on page Model Space, zoomed") so the agent can
     tell the user where to look.

Builder may split or add tools (e.g. `dwg_blocks` with insert positions and attributes, for "where
are the toilets") if the agent tests show a need; the four above are the floor.

### Cache: read once, answer many (owner's requirement)

```
question about plan.dwg
 ├─ in memory and file unchanged?        → answer (~0.03 s)
 ├─ on-disk cache and file unchanged?    → load it (~0.2–0.5 s), keep in memory
 └─ otherwise                            → convert + parse in the worker (~1–5 s),
                                           write the disk cache, keep in memory
```

- **Unchanged** = same absolute path, `mtime` and size as recorded with the cache entry, **and**
  the same `CACHE_FORMAT` version — a constant bumped whenever parser output changes (e.g. the TCVN3
  fix), so old caches are never served after an upgrade.
- Location: the extension's `globalStorageUri`, folder `drawing-cache/`, one gzip JSON per drawing,
  named by a hash of the absolute path. Never next to the drawing.
- Contents: whatever the tools need (parsed pages, objects, per-object bounds, units, skipped types,
  TCVN3 flag). Builder decides whether snapshot needs the full entity geometry cached or re-derives.
- Bounded: keep the most recently used **30** drawings or **500 MB**, whichever comes first; evict
  oldest.
- The preview and the MCP tools share the same in-memory cache (today's `LruCache` in
  `dwgEditorProvider`), so opening a drawing in the preview warms it for the agent and vice versa.
- **The disk cache belongs to the AI side only (my call).** The preview keeps today's behaviour
  (memory only, 4 drawings) and never reads or writes the disk cache, so the viewer's critical path
  and the disk use of users who never use AI are unchanged. With `dwgPreviewer.ai.enabled` off,
  nothing new is written to disk; the Clear command always deletes the cache folder (final review),
  so drawings cached while AI was on can still be removed.
- A corrupt or unreadable cache file is deleted and the drawing re-read; it is never an error to the
  agent.
- Command **DWG: Clear drawing cache**.

### TCVN3 → Unicode (in the parser, for preview and tools)

- Mapping table as in the spike (verified on real drawings; e.g. `cöa`→`cửa`, `MÆt b»ng`→`Mặt
  bằng`, `Ghi chó`→`Ghi chú`).
- Decide **per text**, not per drawing: convert only text drawn in a TCVN3 font — style font
  `.Vn*`, `VN*.TTF`, `VH*.TTF`, `vn-abc.shx`, `vnsimple.shx`, `vnromanc.shx`, … or an MTEXT inline
  font switch `\f.Vn…`. (The spike used a per-drawing heuristic; it would corrupt Unicode text such
  as `30×30` in a drawing that mixes fonts.)
- **"H" fonts** (`.VnTimeH`, `.VnArialH`, `VH*.TTF`) show the same codes as capitals: convert, then
  uppercase. Without that, a caps label comes out half lower case ("MẶT CắT").
- U+FFFD from the DWG decoder must not block conversion of the rest of the text.
- Unit tests from realistic strings; the corpus gains the private drawings' TCVN3 notes as a check
  (private baseline, outside the repo).

### Units rule (all tools)

Declared `$INSUNITS` → named unit. Missing or 0 → `"NOT DECLARED"`; tool descriptions instruct the
agent to say so and, if it infers (e.g. dimension 25000 next to note "L=25m" ⇒ mm), to give the
reasoning. Tools never convert silently.

### Privacy and copy

README / Marketplace: what is sent (drawing text, numbers, snapshots) goes to the AI model the user
chose, only when their agent calls a tool; nothing is sent by the extension itself. Agents ask before
calling tools.

## Testing

- Unit: TCVN3 decoding (realistic strings, H fonts, mixed Unicode / TCVN3, U+FFFD),
  text search folding, containers vs nearby, dimension filters, main extents with outliers, cache
  validity (mtime, size, `CACHE_FORMAT`, corrupt file), eviction.
- Integration: MCP protocol over HTTP (initialize, tools/list, tools/call, auth rejected, Origin
  rejected).
- **Agent evaluation** (the real acceptance test), repeating the spike: a fresh Claude Code session
  restricted to the `dwg_*` tools answers fixed question sets on a client's bridge drawings (private) plus the
  public AEC sample (doors, toilets, room sizes). Target: no wrong number; "not found" is acceptable.
  *My call:* the builder writes the question sets with expected answers, each expected answer traced
  to the object ids it comes from (as done in the spike: e.g. the count labels a total was read
  from); the private sets live outside the repo next to their private corpus baseline. The builder runs the evaluation (it needs only the local
  drawings and a Claude Code login). A wrong number blocks release until fixed or explained; the
  owner reviews the report before release.
- Manual in real VS Code: Copilot sees the tools; Claude Code extension Connect / Disconnect; a
  second question on the same drawing is instant; editing and saving the drawing refreshes answers.

## Left to the builder

Port default, workspace restriction of paths, snapshot rendering method, cache contents for
snapshots, exact tool output shapes, extra tools justified by agent tests, how far LEADER text is
exposed, MCP SDK vs hand-written protocol (the spike's hand-written stdio loop is ~40 lines; HTTP
streamable transport is more involved — an SDK dependency is acceptable if licence-compatible).

## Owner decisions (2026-10-29)

1. Agents drive the open preview in this version (`dwg_show`).
2. The feature is on by default for every user after the update.
3. Agents read drawings in open workspace folders (and open preview tabs) freely; any other drawing
   needs the user's yes in a VS Code prompt.
