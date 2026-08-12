# DWG Previewer — Kiến trúc hệ thống

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                             DWG PREVIEWER — SYSTEM OVERVIEW                              ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝

┌─ INPUT ──────────────────────────────────────────────────────────────────────────────────┐
│ .dwg file  ───→  VS Code Open / Double-click                                             │
│                  (custom editor, mở mặc định cho *.dwg)                                  │
│                                                                                          │
│ File đổi trên đĩa  ───→  Live reload (FileSystemWatcher)                                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─ CONVERSION — Extension Host (Node.js) ──────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ CACHE CHECK   fs.stat() → mtime                                                    │   │
│ │ path + mtime đã có trong cache?                                                    │   │
│ │    ├─ HIT  ──→ postMessage(DXF_DATA) ngay, KHÔNG đọc lại file                      │   │
│ │    └─ MISS ──→ fs.readFile() → Buffer, đi tiếp                                     │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ DWG → DXF Converter (3 chiến lược, theo thứ tự) ──────────────────────────────────┐   │
│ │ (1) libredwg-web WASM  (GNU LibreDWG, ~11 MB)                                      │   │
│ │     • dwg_write_dxf() qua virtual filesystem                                       │   │
│ │     • Mạnh nhất, xử lý mọi file DWG R14–2020+                                      │   │
│ │     • Đã test: 3.6 MB / 45K entities  [OK]                                         │   │
│ │                      │ fail?                                                       │   │
│ │                      ▼                                                             │   │
│ │ (2) libdxfrw-web WASM  (libdxfrw, ~1.5 MB)                                         │   │
│ │     • DRW_DwgR.read() + DRW_FileHandler.fileExport()                               │   │
│ │     • Nhẹ hơn, hợp file nhỏ/vừa                                                    │   │
│ │                      │ fail?                                                       │   │
│ │                      ▼                                                             │   │
│ │ (3) CLI fallback  (khi user cấu hình converterPath, hoặc có trên PATH)             │   │
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
│ │ ARC                     │  │ ATTRIB                  │  │ Linetype: bảng LTYPE    │    │
│ │ POLYLINE                │  │ Layer LType             │  │ Lineweight: code 370    │    │
│ │ LWPOLYLINE              │  │ Layer Handle            │  │ Font: bảng STYLE →      │    │
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
│ │ parseWithRecovery()   — parse lại được khi DXF lỗi/cụt                             │   │
│ │ sanitizeBooleanFlags() — vá group code boolean sai định dạng                       │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Block Expansion ──────────────────────────────────────────────────────────────────┐   │
│ │ INSERT → bung đệ quy (giới hạn depth 16, chặn block lồng vòng)                     │   │
│ │ • rotation, scale (đều + không đều), mirror                                        │   │
│ │ • column/row grid array                                                            │   │
│ │ • layer 0     → kế thừa layer của INSERT                                           │   │
│ │ • BYBLOCK màu → kế thừa màu của INSERT                                             │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Geometry Processing ──────────────────────────────────────────────────────────────┐   │
│ │ • Bulge   → chuỗi cung tròn (polyline cong)                                        │   │
│ │ • Spline  → lấy mẫu de Boor                                                        │   │
│ │ • Ellipse → lấy mẫu tham số                                                        │   │
│ │ • Circle dưới scale không đều → xấp xỉ bằng polyline                               │   │
│ │ • SOLID   → đảo thứ tự đỉnh 1-2-4-3 thành 1-2-3-4                                  │   │
│ │ • Hatch boundary → cạnh line/arc/ellipse/spline + polyline loop                    │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Page Assembly ────────────────────────────────────────────────────────────────────┐   │
│ │ Page 1   Model Space   — toàn bộ entity không thuộc paper space                    │   │
│ │ Page 2   Paper Space   — entity paper space + viewport nhìn vào model              │   │
│ │ Page 3+  Paper Space N — các layout nằm trong block *Paper_Space<n>                │   │
│ │                          mà không INSERT nào tham chiếu tới                        │   │
│ │                                                                                    │   │
│ │ Layout đang active bị lưu 2 lần (block record + ENTITIES có code 67),              │   │
│ │ nên layout nào đã vẽ rồi sẽ bị loại — đối chiếu theo entity handle.                │   │
│ │                                                                                    │   │
│ │ Mỗi viewport dựng lại model qua transform riêng (không transform                   │   │
│ │ hình đã dựng) và loại layer bị freeze riêng cho viewport đó,                       │   │
│ │ resolve từ handle qua layerHandleMap.                                              │   │
│ │                                                                                    │   │
│ │ Mỗi page gồm:                                                                      │   │
│ │   • entities[]   — hình học đã sẵn sàng vẽ                                         │   │
│ │   • bounds       — để fit-to-view                                                  │   │
│ │   • layers[]     — name, color, entityCount (đếm theo từng page)                   │   │
│ │   • viewports[]  — nội dung model bị clip vào khung trên sheet                     │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│                     CACHE STORE   (path + mtime → parsed)                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │  postMessage(DXF_DATA)
                                              ▼
┌─ WEBVIEW — Rendering ────────────────────────────────────────────────────────────────────┐
│ ┌─ Toolbar ──────────────────────────────────────────────────────────────────────────┐   │
│ │ [Page ▼]   [Layers N/N]   [SVG] [PNG]   (banner entity chưa hỗ trợ)                │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ SVG Canvas ───────────────────────────────────────────────────────────────────────┐   │
│ │ Progressive rendering — BATCH_SIZE = 3000 entity/frame:                            │   │
│ │                                                                                    │   │
│ │   ≤ 3000 entity  → vẽ hết một lần, đồng bộ                                         │   │
│ │   > 3000 entity  → lô đầu vẽ ngay (first paint), phần còn lại                      │   │
│ │                    nối tiếp qua requestAnimationFrame                              │   │
│ │                                                                                    │   │
│ │   Frame 1  entities[0..2999]        → first paint                                  │   │
│ │   Frame 2  entities[3000..5999]     → requestAnimationFrame                        │   │
│ │   Frame N  entities[lô cuối]        → render xong                                  │   │
│ │                                                                                    │   │
│ │ <svg viewBox="...">                                                                │   │
│ │   <g transform="scale(1,-1)">     ← lật trục Y (DXF Y hướng lên)                   │   │
│ │     <line> <circle> <path> <polygon> <polyline> <text>                             │   │
│ │     stroke: color, width, dasharray, vector-effect=non-scaling-stroke              │   │
│ │   </g>                                                                             │   │
│ │ </svg>                                                                             │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌─ Interactions ─────────────────────────────────────────────────────────────────────┐   │
│ │ • Scroll wheel  → zoom về phía con trỏ                                             │   │
│ │ • Mouse drag    → pan                                                              │   │
│ │ • Double-click  → fit bản vẽ vào khung nhìn                                        │   │
│ │ • Layer checkbox→ ẩn/hiện layer (giữ nguyên mức zoom)                              │   │
│ │ • Page dropdown → chuyển sheet (reset khung nhìn)                                  │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─ OUTPUT ─────────────────────────────────────────────────────────────────────────────────┐
│ • Preview trực quan ngay trong tab editor của VS Code                                    │
│                                                                                          │
│ • SVG export → file .svg standalone, nền #1e1e1e                                         │
│                chụp đúng khung nhìn hiện tại                                             │
│                KHÔNG chứa layer đang ẩn (đã bị loại khỏi DOM lúc vẽ)                     │
│                                                                                          │
│ • PNG export → rasterize qua <canvas>, cạnh dài giới hạn 2400 px                         │
│                cùng ràng buộc khung nhìn / layer ẩn như SVG                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Giao diện Webview (UI Layout)

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
│ │              │ ☐ ■ FURNITURE   (89) │ ← đang ẩn                              │ │
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
│ │      │          ╚═══╝    │  PHÒNG   │          │                             │ │
│ │      │    ─────────────  │  KHÁCH   │          │                             │ │
│ │      │   │             │ └──────────┘          │                             │ │
│ │      │   │   ┌─────┐  │        ╱╲              │                             │ │
│ │      │   │   │     │  │       ╱  ╲             │                             │ │
│ │      │   │   │ WC  │  │      ╱    ╲            │                             │ │
│ │      │   │   └─────┘  │     ╱______╲           │                             │ │
│ │      │   │             │                       │                             │ │
│ │      │    ─────────────                        │                             │ │
│ │      └─────────────────────────────────────────┘                             │ │
│ │                                                                              │ │
│ │ Nền: #1e1e1e   |   Scroll = Zoom   |   Drag = Pan   |   Dbl-click = Fit      │ │
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
│    Nhãn đổi theo stage do host gửi       │     │    Failed to convert DWG file.           │
│    qua DXF_PROGRESS:                     │     │                                          │
│                                          │     │    The bundled converters could not      │
│      1. Reading DWG file…                │     │    process this file.                    │
│      2. Converting DWG → DXF…            │     │                                          │
│      3. Parsing drawing data…            │     │    Install an external converter…        │
│                                          │     │                                          │
│    Cache hit thì bỏ qua cả 3 stage.      │     │                                          │
│                                          │     │                                          │
└──────────────────────────────────────────┘     └──────────────────────────────────────────┘
               LOADING STATE                                     ERROR STATE
```

---

## Data Flow

```
   .dwg trên đĩa  (ví dụ 3.5 MB)
      │
      │  ① vscode.workspace.fs.stat()  →  mtime
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ② CACHE CHECK   —  key: đường dẫn file + mtime                   │
   │                                                                  │
   │    HIT   →  nhảy thẳng xuống ⑦, KHÔNG đọc lại file trên đĩa      │
   │    MISS  →  đi tiếp ③                                            │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ③ vscode.workspace.fs.readFile()  →  Buffer
      │
      │  ④ libredwg.FS.writeFile("/input.dwg", buffer)
      │     libredwg.dwg_write_dxf("/input.dwg", "/output.dxf")
      │     libredwg.FS.readFile("/output.dxf")
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ DXF text   —  chuỗi, ~18 MB với file DWG 3.5 MB                  │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ⑤ dxf-parser.parseSync() + các raw scanner
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
   │ Webview   —  nhận qua structured clone                           │
   └──────────────────────────────────────────────────────────────────┘
      │
      │  ⑧ Progressive render: 3000 entity mỗi frame
      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ SVG DOM   —  45K phần tử <line> <circle> <path> <text>           │
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
├── PROGRESS.md                  Tiến độ phát triển
├── ARCHITECTURE.md              File này
│
├── .vscode/
│   ├── launch.json              F5 debug config
│   └── tasks.json               Build task
│
├── .vscodeignore                Chỉ ship: out/ + WASM trong node_modules
├── .gitignore                   Bỏ qua: node_modules, out, *.vsix
│
├── src/
│   ├── extension.ts             Entry point — đăng ký custom editor
│   │
│   ├── dwgEditorProvider.ts     Vòng đời custom editor
│   │                            • Sinh HTML webview (shell + CSS theo theme)
│   │                            • Cache parsed result (path + mtime)
│   │                            • FileSystemWatcher (live reload)
│   │                            • Export handler (save dialog SVG/PNG)
│   │                            • Gửi DXF_PROGRESS theo từng stage
│   │
│   ├── dwg/
│   │   └── converter.ts         DWG → DXF
│   │                            • Chiến lược 1: libredwg-web WASM
│   │                            • Chiến lược 2: libdxfrw-web WASM
│   │                            • Chiến lược 3: CLI fallback
│   │
│   ├── dxf/
│   │   ├── parseDxf.ts          Parser chính (~1400 dòng)
│   │   │                        • Block expansion, page assembly
│   │   │                        • Resolve color/linetype/lineweight/font
│   │   │                        • Recovery cho DXF lỗi
│   │   ├── types.ts             Định nghĩa kiểu entity/page
│   │   ├── hatch.ts             Raw scanner cho HATCH
│   │   ├── viewport.ts          Scanner VIEWPORT + ma trận transform
│   │   ├── bulge.ts             Bung bulge polyline thành cung tròn
│   │   ├── spline.ts            B-spline, thuật toán de Boor
│   │   └── matrix.ts            Toán ma trận affine 2D
│   │
│   └── webview/
│       ├── main.ts              Điều phối UI
│       │                        • Toolbar (page select, layers, export)
│       │                        • Progressive batch rendering
│       │                        • Trạng thái loading / progress / error
│       │
│       ├── renderer.ts          Entity → phần tử SVG
│       │                        • LINE, CIRCLE, ARC, POLYLINE
│       │                        • HATCH (solid + pattern fill)
│       │                        • TEXT (font, align, rotation)
│       │                        • DIMENSION (đường + nhãn)
│       │                        • POINT (chấm tròn)
│       │
│       ├── panZoom.ts           Tương tác scroll/drag/fit trên viewBox
│       │
│       └── export.ts            Xuất file SVG/PNG
│                                • toStandaloneSvg() → .svg
│                                • toPngBase64()     → canvas → .png
│
├── node_modules/
│   └── @mlightcad/
│       ├── libredwg-web/        GNU LibreDWG WASM (~11 MB)
│       │   └── wasm/  libredwg-web.js  libredwg-web.wasm
│       │
│       └── libdxfrw-web/        libdxfrw WASM (~1.5 MB)
│           └── dist/  libdxfrw.js  libdxfrw.wasm
│
└── out/                         Build output (generated)
    ├── extension.js             Bundle cho extension host
    └── webview/main.js          Bundle cho webview
```

---

## Communication Protocol

`◄` = webview gửi lên host · `►` = host gửi xuống webview

```
Extension Host                    Webview
──────────────                    ───────

  ◄─────────────────────────────────────── READY ──────
         (webview đã load xong, xin dữ liệu)
         → host: onDidReceiveMessage → sendContent()

  ────── DXF_PROGRESS { stage } ──────────────────────►
         (reading / converting / parsing)
         → webview: hiện spinner + đổi nhãn stage

  ────── DXF_DATA { pages, skippedEntityTypes } ──────►
         (gửi cả khi cache hit)
         → webview: renderScene() → progressive SVG

  ────── DXF_ERROR { message } ───────────────────────►
         (convert hoặc parse thất bại)
         → webview: hiện toàn màn hình lỗi

  ◄───────────────────── EXPORT { format, data } ──────
         (user bấm nút SVG / PNG)
         → host: saveExport() → showSaveDialog() → fs.writeFile()

  ◄─────────────────── EXPORT_FAILED { message } ──────
         (canvas rasterize thất bại)
         → host: window.showErrorMessage()

```
