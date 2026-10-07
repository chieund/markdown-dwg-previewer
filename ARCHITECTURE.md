# DWG Previewer — System Architecture

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                             DWG PREVIEWER — SYSTEM OVERVIEW                              ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝

┌─ INPUT ──────────────────────────────────────────────────────────────────────────────────┐
│ .dwg file  ───→  VS Code Open / Double-click                                             │
│                  (custom editor, opens *.dwg by default)                                 │
│                                                                                          │
│ File changed on disk  ───→  Live reload (FileSystemWatcher)                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─ CONVERSION — Extension Host (Node.js) ──────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ CACHE CHECK   fs.stat() → mtime                                                    │   │
│ │ path + mtime already in cache?                                                     │   │
│ │    ├─ HIT  ──→ postMessage(DXF_DATA) immediately, file NOT re-read                 │   │
│ │    └─ MISS ──→ fs.readFile() → Buffer, continue                                    │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ DWG → DXF Converter (2 strategies, in order) ─────────────────────────────────────┐   │
│ │ (1) libredwg-web WASM  (GNU LibreDWG, ~11 MB)                                      │   │
│ │     • dwg_write_dxf() via the virtual filesystem                                   │   │
│ │     • Most robust, handles any DWG file R14–2020+                                  │   │
│ │     • Tested: 3.6 MB / 45K entities  [OK]                                          │   │
│ │                      │ fail?                                                       │   │
│ │                      ▼                                                             │   │
│ │ (2) CLI fallback  (when the user configures converterPath, or found on PATH)       │   │
│ │     • dwg2dxf (LibreDWG)   • ODAFileConverter                                      │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│                           ──→  DXF text                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─ PARSING — Extension Host (Node.js) ─────────────────────────────────────────────────────┐
│ ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐    │
│ │       dxf-parser        │  │      Raw scanners       │  │       Resolution        │    │
│ ├─────────────────────────┤  ├─────────────────────────┤  ├─────────────────────────┤    │
│ │ LINE                    │  │ HATCH                   │  │ Color: entity/layer/    │    │
│ │ CIRCLE                  │  │ VIEWPORT                │  │       BYLAYER/BYBLOCK   │    │
│ │ ARC                     │  │ ATTRIB                  │  │ Linetype: LTYPE table   │    │
│ │ POLYLINE                │  │ Layer LType             │  │ Lineweight: code 370    │    │
│ │ LWPOLYLINE              │  │ Layer Handle            │  │ Font: STYLE table →     │    │
│ │ SPLINE                  │  │ Text Style              │  │       CSS font-family   │    │
│ │ ELLIPSE                 │  │                         │  │ Layer 0 inheritance     │    │
│ │ TEXT                    │  │                         │  │ Text alignment          │    │
│ │ MTEXT                   │  │                         │  │                         │    │
│ │ DIMENSION               │  │                         │  │                         │    │
│ │ INSERT                  │  │                         │  │                         │    │
│ │ SOLID                   │  │                         │  │                         │    │
│ │ POINT                   │  │                         │  │                         │    │
│ │ 3DFACE                  │  │                         │  │                         │    │
│ └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘    │
│                                                                                          │
│ ┌─ Error recovery ───────────────────────────────────────────────────────────────────┐   │
│ │ parseWithRecovery()   — re-parses corrupt/truncated DXF                            │   │
│ │ sanitizeBooleanFlags() — patches malformed boolean group codes                     │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Block Expansion ──────────────────────────────────────────────────────────────────┐   │
│ │ INSERT → expanded recursively (max depth 16, circular block nesting blocked)       │   │
│ │ • rotation, scale (uniform + non-uniform), mirror                                  │   │
│ │ • column/row grid array                                                            │   │
│ │ • layer 0       → inherits the INSERT's layer                                      │   │
│ │ • BYBLOCK color → inherits the INSERT's color                                      │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Geometry Processing ──────────────────────────────────────────────────────────────┐   │
│ │ • Bulge   → arc segments (curved polylines)                                        │   │
│ │ • Spline  → de Boor sampling                                                       │   │
│ │ • Ellipse → parametric sampling                                                    │   │
│ │ • Circle under non-uniform scale → approximated with a polyline                    │   │
│ │ • SOLID   → vertex order 1-2-4-3 reordered to 1-2-3-4                              │   │
│ │ • Hatch boundary → line/arc/ellipse/spline edges + polyline loops                  │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Page Assembly ────────────────────────────────────────────────────────────────────┐   │
│ │ Page 1   Model Space   — all entities not in paper space                           │   │
│ │ Page 2   Paper Space   — paper space entities + viewports onto the model           │   │
│ │ Page 3+  Paper Space N — layouts living in *Paper_Space<n> blocks                  │   │
│ │                          that no INSERT references                                 │   │
│ │                                                                                    │   │
│ │ The active layout is stored twice (block record + ENTITIES with code 67),          │   │
│ │ so a layout that was already drawn is skipped — matched by entity handle.          │   │
│ │                                                                                    │   │
│ │ Each viewport rebuilds the model through its own transform (it does not            │   │
│ │ transform already-built geometry) and drops layers frozen for that viewport,       │   │
│ │ resolved from handles via layerHandleMap.                                          │   │
│ │                                                                                    │   │
│ │ Each page contains:                                                                │   │
│ │   • entities[]   — geometry ready to draw                                          │   │
│ │   • bounds       — for fit-to-view                                                 │   │
│ │   • layers[]     — name, color, entityCount (counted per page)                     │   │
│ │   • viewports[]  — model content clipped to its frame on the sheet                 │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│                     CACHE STORE   (path + mtime → parsed)                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │  postMessage(DXF_DATA)
                                              ▼
┌─ WEBVIEW — Rendering ────────────────────────────────────────────────────────────────────┐
│ ┌─ Toolbar ──────────────────────────────────────────────────────────────────────────┐   │
│ │ [Page ▼]   [Layers N/N]   [SVG] [PNG]   (unsupported-entity banner)                │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ SVG Canvas ───────────────────────────────────────────────────────────────────────┐   │
│ │ Progressive rendering — BATCH_SIZE = 3000 entities/frame:                          │   │
│ │                                                                                    │   │
│ │   ≤ 3000 entities → drawn all at once, synchronously                               │   │
│ │   > 3000 entities → first batch drawn immediately (first paint), the rest          │   │
│ │                     follow via requestAnimationFrame                               │   │
│ │                                                                                    │   │
│ │   Frame 1  entities[0..2999]        → first paint                                  │   │
│ │   Frame 2  entities[3000..5999]     → requestAnimationFrame                        │   │
│ │   Frame N  entities[last batch]     → render complete                              │   │
│ │                                                                                    │   │
│ │ <svg viewBox="...">                                                                │   │
│ │   <g transform="scale(1,-1)">     ← flip the Y axis (DXF Y points up)              │   │
│ │     <line> <circle> <path> <polygon> <polyline> <text>                             │   │
│ │     stroke: color, width, dasharray, vector-effect=non-scaling-stroke              │   │
│ │   </g>                                                                             │   │
│ │ </svg>                                                                             │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Interactions ─────────────────────────────────────────────────────────────────────┐   │
│ │ • Scroll wheel  → zoom toward the cursor                                           │   │
│ │ • Mouse drag    → pan                                                              │   │
│ │ • Double-click  → fit the drawing to the view                                      │   │
│ │ • Layer checkbox→ show/hide layer (keeps the current zoom)                         │   │
│ │ • Page dropdown → switch sheet (resets the view)                                   │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─ OUTPUT ─────────────────────────────────────────────────────────────────────────────────┐
│ • Visual preview right inside a VS Code editor tab                                       │
│                                                                                          │
│ • SVG export → standalone .svg file, background #1e1e1e                                  │
│                captures exactly the current view                                         │
│                EXCLUDES hidden layers (already removed from the DOM at render time)      │
│                                                                                          │
│ • PNG export → rasterized via <canvas>, long edge capped at 2400 px                      │
│                same view / hidden-layer constraints as SVG                               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Webview UI Layout

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ┌─ TOOLBAR ────────────────────────────────────────────────────────────────────┐ │
│ │ ┌─────────┐  ┌──────────────┐  ┌─────┐ ┌─────┐  ┌────────────────────┐       │ │
│ │ │Model ▼  │  │Layers 32/32  │  │ SVG │ │ PNG │  │⚠ Not supported:    │       │ │
│ │ └─────────┘  └──────┬───────┘  └─────┘ └─────┘  │  MESH, LEADER     ×│       │ │
│ │  page select        │           export buttons  └────────────────────┘       │ │
│ │                     ▼  (dropdown panel)                                      │ │
│ │              ┌──────────────────────┐                                        │ │
│ │              │ [Show All] [Hide All]│                                        │ │
│ │              ├──────────────────────┤                                        │ │
│ │              │ ☑ ■ 0           (42) │                                        │ │
│ │              │ ☑ ■ WALL       (156) │                                        │ │
│ │              │ ☑ ■ DOOR        (23) │                                        │ │
│ │              │ ☐ ■ FURNITURE   (89) │ ← hidden                               │ │
│ │              │ ☑ ■ TEXT       (312) │                                        │ │
│ │              │ ☑ ■ DIMENSION   (67) │                                        │ │
│ │              │ ...                  │                                        │ │
│ │              └──────────────────────┘                                        │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│ ┌─ SVG CANVAS ─────────────────────────────────────────────────────────────────┐ │
│ │      ┌─────────────────────────────────────────┐                             │ │
│ │      │          ╔═══╗                          │                             │ │
│ │      │          ║   ║    ┌──────────┐          │                             │ │
│ │      │          ╚═══╝    │  LIVING  │          │                             │ │
│ │      │    ─────────────  │   ROOM   │          │                             │ │
│ │      │   │             │ └──────────┘          │                             │ │
│ │      │   │   ┌─────┐  │        ╱╲              │                             │ │
│ │      │   │   │     │  │       ╱  ╲             │                             │ │
│ │      │   │   │ WC  │  │      ╱    ╲            │                             │ │
│ │      │   │   └─────┘  │     ╱______╲           │                             │ │
│ │      │   │             │                       │                             │ │
│ │      │    ─────────────                        │                             │ │
│ │      └─────────────────────────────────────────┘                             │ │
│ │                                                                              │ │
│ │ Background: #1e1e1e  |  Scroll = Zoom  |  Drag = Pan  |  Dbl-click = Fit     │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Loading & Error states

```
┌──────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
│                                          │     │                                          │
│             ◠◡◠  (spinner)               │     │    ⚠  ERROR                              │
│                                          │     │                                          │
│    Label follows the stage sent by the   │     │    Failed to convert DWG file.           │
│    host via DXF_PROGRESS:                │     │                                          │
│                                          │     │    The bundled converters could not      │
│      1. Reading DWG file…                │     │    process this file.                    │
│      2. Converting DWG → DXF…            │     │                                          │
│      3. Parsing drawing data…            │     │    Install an external converter…        │
│                                          │     │                                          │
│    Cache hit skips all 3 stages.         │     │                                          │
│                                          │     │                                          │
└──────────────────────────────────────────┘     └──────────────────────────────────────────┘
               LOADING STATE                                     ERROR STATE
```

---

## Data Flow

```
   .dwg on disk  (e.g. 3.5 MB)
      │
      │  ① vscode.workspace.fs.stat()  →  mtime
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ② CACHE CHECK   —  key: file path + mtime                        │
   │                                                                  │
   │    HIT   →  jump straight to ⑦, file on disk NOT re-read         │
   │    MISS  →  continue to ③                                        │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ③ vscode.workspace.fs.readFile()  →  Buffer
      │
      │  ④ libredwg.FS.writeFile("/input.dwg", buffer)
      │     libredwg.dwg_write_dxf("/input.dwg", "/output.dxf")
      │     libredwg.FS.readFile("/output.dxf")
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ DXF text   —  string, ~18 MB for a 3.5 MB DWG file               │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ⑤ dxf-parser.parseSync() + raw scanners
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ParsedDxf  { pages[], skippedEntityTypes[] }   —  45K entities   │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ⑥ CACHE STORE   path + mtime  →  parsed
      │
      │  ⑦ webviewPanel.webview.postMessage({ "DXF_DATA", ...parsed })
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ Webview   —  received via structured clone                       │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ⑧ Progressive render: 3000 entities per frame
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ SVG DOM   —  45K <line> <circle> <path> <text> elements          │
   └──────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
markdown-dwg-previewer/
│
├── package.json                 Extension manifest + dependencies
├── tsconfig.json                TypeScript config
├── esbuild.js                   Bundler (extension + webview)
├── README.md                    User documentation
├── PROGRESS.md                  Development progress
├── ARCHITECTURE.md              This file
│
├── .vscode/
│   ├── launch.json              F5 debug config
│   └── tasks.json               Build task
│
├── .vscodeignore                Ships only: out/ + WASM in node_modules
├── .gitignore                   Ignores: node_modules, out, *.vsix
│
├── src/
│   ├── extension.ts             Entry point — registers the custom editor
│   │
│   ├── dwgEditorProvider.ts     Custom editor lifecycle
│   │                            • Generates webview HTML (shell + theme-aware CSS)
│   │                            • Caches parsed result (path + mtime)
│   │                            • FileSystemWatcher (live reload)
│   │                            • Export handler (SVG/PNG save dialog)
│   │                            • Sends DXF_PROGRESS for each stage
│   │
│   ├── dwg/
│   │   └── converter.ts         DWG → DXF
│   │                            • Strategy 1: libredwg-web WASM
│   │                            • Strategy 2: CLI fallback
│   │                            (libdxfrw removed 2026-10-07 — GPL-2.0-only conflicts with GPL-3.0)
│   │
│   ├── dxf/
│   │   ├── parseDxf.ts          Main parser (~1400 lines)
│   │   │                        • Block expansion, page assembly
│   │   │                        • Resolve color/linetype/lineweight/font
│   │   │                        • Recovery for corrupt DXF
│   │   ├── types.ts             Entity/page type definitions
│   │   ├── hatch.ts             Raw scanner for HATCH
│   │   ├── viewport.ts          VIEWPORT scanner + transform matrices
│   │   ├── bulge.ts             Expands polyline bulges into arcs
│   │   ├── spline.ts            B-spline, de Boor algorithm
│   │   └── matrix.ts            2D affine matrix math
│   │
│   └── webview/
│       ├── main.ts              UI orchestration
│       │                        • Toolbar (page select, layers, export)
│       │                        • Progressive batch rendering
│       │                        • Loading / progress / error states
│       │
│       ├── renderer.ts          Entity → SVG element
│       │                        • LINE, CIRCLE, ARC, POLYLINE
│       │                        • HATCH (solid + pattern fill)
│       │                        • TEXT (font, align, rotation)
│       │                        • DIMENSION (lines + label)
│       │                        • POINT (dot)
│       │
│       ├── panZoom.ts           Scroll/drag/fit interaction on the viewBox
│       │
│       └── export.ts            SVG/PNG file export
│                                • toStandaloneSvg() → .svg
│                                • toPngBase64()     → canvas → .png
│
├── node_modules/
│   └── @mlightcad/
│       └── libredwg-web/        GNU LibreDWG WASM (~11 MB)
│           └── wasm/  libredwg-web.js  libredwg-web.wasm
│
└── out/                         Build output (generated)
    ├── extension.js             Bundle for the extension host
    └── webview/main.js          Bundle for the webview
```

---

## Worker thread

Conversion (WASM) and parsing no longer run on the extension host thread: `dwgEditorProvider` reads
the bytes and sends them to `DrawingWorker` (`src/dwg/workerClient.ts`); the worker (`src/dwg/worker.ts`,
bundled to `out/worker.js` next to `out/extension.js` so `converter.ts` finds the WASM at the same path)
runs `processDrawing` (`src/dwg/pipeline.ts`) and returns the `ParsedDxf`. A single long-lived worker
is used (WASM is loaded only once) with a 3 GB heap limit — a drawing that blows up memory only kills
the worker, and the next job spins up a new one. Converter logs travel via `log` messages to the OutputChannel.

## Communication Protocol

`◄` = webview sends to host · `►` = host sends to webview

```
Extension Host                    Webview
──────────────                    ───────

  ◄─────────────────────────────────────── READY ──────
         (webview finished loading, requests data)
         → host: onDidReceiveMessage → sendContent()

  ────── DXF_PROGRESS { stage } ──────────────────────►
         (reading / converting / parsing)
         → webview: show spinner + update stage label

  ────── DXF_DATA { pages, skippedEntityTypes } ──────►
         (sent on cache hit too)
         → webview: renderScene() → progressive SVG

  ────── DXF_ERROR { message } ───────────────────────►
         (conversion or parsing failed)
         → webview: show full-screen error

  ◄───────────────────── EXPORT { format, data } ──────
         (user clicked the SVG / PNG button)
         → host: saveExport() → showSaveDialog() → fs.writeFile()

  ◄─────────────────── EXPORT_FAILED { message } ──────
         (canvas rasterization failed)
         → host: window.showErrorMessage()

```
