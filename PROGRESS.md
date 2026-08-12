# DWG Previewer — Tiến độ phát triển

**Cập nhật lần cuối:** 2026-08-12 11:32

**Trạng thái:** đã đóng gói `dwg-previewer-1.0.1.vsix` (3.09 MB) — sẵn sàng upload Marketplace, còn 3 việc cần xác nhận ở mục [Chuẩn bị publish](#-chuẩn-bị-publish)

---

## ✅ Đã hoàn thành

### 1. Kiến trúc cơ bản (Core Architecture)
- [x] Project structure theo mô hình `markdown-dxf-previewer`
- [x] `package.json` — manifest, dependencies, scripts
- [x] `tsconfig.json`, `esbuild.js` — build system (dual entry: extension + webview)
- [x] `.vscode/` — launch.json (F5 debug), tasks.json
- [x] `.vscodeignore` — chỉ ship code cần thiết + WASM binaries; chặn `.claude/`, `assets/`, và tài liệu nội bộ
- [x] `README.md` — documentation cho user
- [x] `ARCHITECTURE.md` — ASCII diagrams giao diện + kiến trúc hệ thống
- [x] `PROGRESS.md` — file tiến độ (file này)
- [x] `icon.png` — logo 256×256, sinh bằng `assets/make-icon.py` (sửa toạ độ/màu ở đầu script rồi chạy lại)

### 2. Extension Host (Node.js)
- [x] `extension.ts` — activation, đăng ký custom editor cho `*.dwg`
- [x] `dwgEditorProvider.ts` — lifecycle, webview HTML, file watcher, export handler
- [x] **Cache hệ thống** — kết quả parse cache theo `path + mtime`, mở lại cùng file = instant
- [x] **Progress messages** — gửi stage (reading → converting → parsing) cho webview
- [x] **OutputChannel "DWG Previewer"** — `setConverterLogger()` bơm logger vào converter, mọi bước convert đều có vết để hỗ trợ user khi file lỗi

### 3. DWG → DXF Converter (`src/dwg/converter.ts`)
- [x] **Primary: `@mlightcad/libredwg-web` v0.7.9 (GNU LibreDWG WASM, 10MB)**
  - Dùng `dwg_write_dxf()` qua Emscripten virtual filesystem
  - Hỗ trợ DWG R14 → 2020+
  - File 3.6MB / 45K entities ✅
  - Load qua `dynamic import()` (ESM module trong CJS context), đường dẫn đi qua `pathToFileURL()` để chạy được cả trên Windows
- [x] **Secondary: `@mlightcad/libdxfrw-web` v0.0.9 (libdxfrw WASM, 1.5MB)**
  - Dùng `DRW_DwgR.read()` + `fileExport()`
  - Nhẹ hơn, hoạt động cho file nhỏ/vừa
- [x] **Last resort: CLI fallback**
  - Tìm `dwg2dxf` / `ODAFileConverter` trên PATH
  - Hoặc user cấu hình `dwgPreviewer.converterPath`
- [x] **Zero-install** — user không cần cài tool nào, cả 2 WASM bundled trong extension
- [x] **Log chi tiết mọi nhánh** — ghi `Strategy 1/3 → 2/3 → 3/3`, lý do từng chiến lược fail, size DXF khi thành công; nhánh CLI cũng log exit code và output rỗng

### 4. Shared types (`src/shared/types.ts`)
- [x] **Single source of truth** cho wire format truyền qua `postMessage`
- [x] Cả extension host lẫn webview import từ đây → sửa lệch một bên là compile lỗi ngay, không còn rủi ro sai âm thầm lúc runtime
- [x] `src/dxf/types.ts` giữ lại làm lớp re-export để các file trong `dxf/` không phải sửa import

### 5. DXF Parser (`src/dxf/`)
- [x] `parseDxf.ts` — main parser (dxf-parser + custom scanners, 1400+ lines)
- [x] `hatch.ts` — HATCH entity scanner (solid + pattern fill)
- [x] `viewport.ts` — viewport scanner + paper→model transform
- [x] `bulge.ts` — polyline arc segment expansion
- [x] `spline.ts` — B-spline de Boor sampling
- [x] `matrix.ts` — 2D affine transforms (translate/rotate/scale/mirror)
- [x] `types.ts` — re-export từ `shared/types.ts` (giữ đường import cũ cho các file trong `dxf/`)

### 6. Webview Renderer (`src/webview/`)
- [x] `main.ts` — toolbar, layers panel, page selector, message handling
- [x] `renderer.ts` — entity → SVG element rendering
- [x] `panZoom.ts` — scroll zoom, drag pan, double-click fit
- [x] `export.ts` — SVG/PNG export
- [x] **Progressive rendering** — file lớn render theo batch 3000 entities/frame (requestAnimationFrame)
- [x] **Generation token** — mỗi lần `renderCanvas` chạy sẽ tăng counter; chuỗi rAF cũ thấy lệch là thoát ngay, không còn nhiều lượt render chồng nhau khi toggle layer liên tục
- [x] **Dọn listener** — `disposeLayerOutsideClick` gỡ listener `document` của layer panel trước khi dựng panel mới, không rò khi chuyển page
- [x] **Progress indicator** — hiển thị stage: Reading → Converting → Parsing
- [x] Dark theme CSS khớp VS Code variables

### 7. Supported Entities
| Category | Entities |
|----------|----------|
| Geometry | LINE · CIRCLE · ARC · POLYLINE · LWPOLYLINE · SPLINE · ELLIPSE |
| Fills | SOLID · HATCH (solid + pattern) |
| Text | TEXT · MTEXT · ATTRIB |
| Blocks | INSERT (nested, rotated, mirrored, scaled, grid arrays) |
| Annotations | DIMENSION (label + line) |
| Other | POINT · 3DFACE (wireframe) |

### 8. Unit test (`test/`)
- [x] **48 test, chạy bằng `node:test`** — Node 20 có sẵn, không thêm dependency nào
- [x] `matrix.test.ts` — compose/thứ tự nhân, similarity vs scale không đều, mirror qua dấu determinant
- [x] `bulge.test.ts` — bulge 1 = nửa đường tròn, bulge âm đảo chiều, polyline đóng không lặp điểm đầu
- [x] `spline.test.ts` — de Boor khớp Bézier tại điểm giữa, input hỏng trả về rỗng, curve nằm trong convex hull
- [x] `viewport.test.ts` — transform paper↔model, twist, loại pseudo-viewport của chính tờ giấy
- [x] `hatch.test.ts` — quét HATCH từ group code thô, boundary cong, loại loop dưới 3 điểm
- [x] `renderer.test.ts` — cờ large-arc và sweep âm trong `arcToPathData`
- [x] **Đã mutation test** — cố tình phá 5 chỗ (đảo thứ tự `multiply`, đảo chiều bulge, bỏ cờ large-arc, lệch chỉ số knot, sai dấu twist), cả 5 đều bị test bắt

### 9. Corpus test (`test/corpus.ts`)
- [x] Chạy pipeline thật (DWG → DXF → parse) trên cả một thư mục `.dwg`, báo cáo từng file: size, DXF size, thời gian convert/parse, số page/entity/layer
- [x] **Baseline regression** — `test/corpus-baseline.json` lưu kết quả mốc; lần chạy sau tụt entity hoặc chuyển sang lỗi là báo REGRESSION và exit code 1
- [x] Bundle ra `out-test/corpus.js` — cùng độ sâu thư mục với `out/extension.js`, nên converter tìm WASM đúng theo đường dẫn dùng khi đóng gói thật
- [x] **Đã kiểm chứng harness** — tắt `injectHatches()` thì 4 file tụt entity, báo REGRESSION, exit 1; bật lại thì khớp baseline, exit 0
- [x] Kết quả trên 17 sample drawing của AutoCAD: **17/17 convert + parse thành công**

### 10. User Features
- [x] Zero-config — cài extension, mở file `.dwg` = xem luôn
- [x] Pan & zoom — scroll/drag/double-click
- [x] Layer control — show/hide/show all/hide all
- [x] Multi-page — Model Space + Paper Space sheets
- [x] Export SVG/PNG — save current view
- [x] Live reload — file watcher auto-refresh
- [x] Dark theme — matches VS Code

---

## 📊 Performance (file 3.5MB / 45K entities)

| Bước | Lần đầu | Lần 2+ (cache hit) |
|------|---------|---------------------|
| Load WASM | ~90ms | 0ms (module cached) |
| DWG → DXF convert | ~1000ms | 0ms (result cached) |
| Parse DXF | ~640ms | 0ms (result cached) |
| Send to webview | ~100ms | ~100ms |
| Render first paint | ~200ms | ~200ms |
| Render full (progressive) | ~1.5s | ~1.5s |
| **Total time-to-interactive** | **~2s** | **~300ms** |

---

## 📋 Test Results (2026-08-12)

| File | Size | DXF Output | Entities | Layers | Blocks | Status |
|------|------|-----------|----------|--------|--------|--------|
| `Real-world drawing A` | 420KB | 2.8MB | 1,931 | 32 | 338 | ✅ |
| `Real-world drawing B` | 455KB | 2.2MB | 1,135 | 42 | 22 | ✅ |
| `Real-world drawing C` | 3,623KB | 18.5MB | 45,552 | 117 | 745 | ✅ |

Tất cả file test đều convert + parse + render thành công mà user **không cần cài tool nào**.

### Corpus 17 sample drawing của AutoCAD (`npm run test:corpus`)

**17/17 convert + parse thành công.** Bộ này phủ annotation scaling, multileader, table,
lineweight, truetype, fill pattern và cả bản vẽ visualization 3D.

Nặng nhất: `colorwh.dwg` — 1.7MB → DXF 9.2MB → 36.431 entity, convert 562ms, parse 6.8s.

### 🐛 Phát hiện từ corpus: bản vẽ 3D mở ra trắng mà không báo gì

4 file `visualization_*` gần như không vẽ được gì (`aerial` và `sun_and_sky_demo` ra **0
entity**, `conference_room` 8, `condominium` 6). Kiểm tra section ENTITIES của chúng:

| File | Nội dung thật |
|------|---------------|
| `visualization_-_aerial` | 5 × 3DSOLID, 1 × PLANESURFACE |
| `visualization_-_sun_and_sky_demo` | 15 × 3DSOLID, 2 × VIEWPORT |
| `visualization_-_conference_room` | 30 × 3DSOLID, 6 × LIGHT, 6 × INSERT, 4 × LWPOLYLINE… |

Đây là bản vẽ 3D nên extension 2D không vẽ được — chấp nhận được. **Vấn đề nằm chỗ khác:
`skippedEntityTypes` rỗng**, nên banner cảnh báo trên toolbar không hiện gì. User mở file ra
thấy canvas trắng trơn, không có bất kỳ giải thích nào.

Nguyên nhân: `parseDxf.ts:1024` chỉ ghi nhận entity bị bỏ qua **bên trong `mapEntity`**, mà
`mapEntity` chỉ nhìn thấy những gì dxf-parser đã đọc được. dxf-parser âm thầm bỏ luôn
3DSOLID / PLANESURFACE / LIGHT ngay từ đầu, nên chúng không bao giờ tới được chỗ đếm.

Điều này khiến lời hứa trong `MARKETPLACE.md` — *"the toolbar shows a banner naming any
entity type it couldn't draw"* — không đúng với đúng nhóm file cần nó nhất.

---

## 🔍 Code review & fix (2026-08-12)

Rà soát toàn bộ codebase, 11 vấn đề được phát hiện và xử lý xong.

| # | Priority | Vấn đề | Cách fix |
|---|----------|--------|----------|
| 1 | P1 | Chuỗi rAF chạy chồng khi toggle layer liên tục — batch cũ vẫn append vào DOM đã detach, đốt CPU vô ích | `renderGeneration` token, batch cũ check thấy lệch thì `return` ngay |
| 2 | P1 | `document.addEventListener('click')` rò mỗi lần đổi page, không bao giờ gỡ | `disposeLayerOutsideClick` — gỡ listener cũ trước khi build panel mới |
| 3 | P2 | Type định nghĩa 2 lần (host + webview), lệch nhau vẫn compile sạch, chỉ lỗi lúc runtime | `src/shared/types.ts` làm single source, cả 2 bên import từ đây |
| 4 | P2 | Lỗi convert bị `catch {}` nuốt sạch, user gặp lỗi mà không có manh mối nào | `setConverterLogger()` → OutputChannel "DWG Previewer" |
| 5 | P2 | `import()` với đường dẫn tuyệt đối fail trên Windows → converter chính im lặng không chạy | `pathToFileURL(wasmPath).href` |
| 6 | P2 | Nhánh CLI vẫn chưa có log — đúng tình huống cần log nhất | Log `Strategy 1/3 → 3/3`, exit code, DXF rỗng, size khi thành công |
| 7 | P3 | Comment ghi ">5000 entities" trong khi `BATCH_SIZE = 3000` | Sửa comment về đúng 3000 |
| 8 | P3 | `icon.png` khai trong manifest nhưng không tồn tại → `npm run package` fail | Tạo logo thật 256×256 + script sinh lại |
| 9 | P3 | README ghi sai converter chính (libdxfrw) và thiếu license libredwg | Sửa: libredwg primary GPL-3.0, libdxfrw fallback GPL-2.0 |
| 10 | P3 | `.claude/settings.local.json` bị đóng gói vào .vsix — config cục bộ lọt ra bản phát hành | `.vscodeignore` thêm `.claude/**` |
| 11 | P3 | `ARCHITECTURE.md` + `PROGRESS.md` (42KB tài liệu nội bộ tiếng Việt) cũng bị ship | `.vscodeignore` thêm 2 file + `assets/**` |

Kiểm chứng: `npm run typecheck` sạch, `npm run build` OK, `vsce package` chạy thật và đối chiếu cây file trong .vsix — 3 file nội bộ đã biến mất, WASM nằm đúng `extension/node_modules/@mlightcad/libredwg-web/wasm/`, khớp đường dẫn `__dirname/../node_modules/…` mà `converter.ts` dựng lúc runtime.

Ngoài ra `ARCHITECTURE.md` được sửa lại: đảo đúng chiều 6 thông điệp trong Communication Protocol, sửa thứ tự `stat → cache check → readFile` trong Data Flow, bổ sung multi-sheet Paper Space + error recovery, và ghi rõ export không chứa layer đang ẩn.

---

## 🔜 Backlog (có thể cải thiện thêm)

| # | Feature | Mục đích | Priority |
|---|---------|----------|----------|
| 1 | Viewport culling | Chỉ render entities trong viewport → giảm lag zoom/pan file lớn | High |
| 2 | Canvas 2D renderer | Thay SVG bằng Canvas cho file >20K entities | High |
| 3 | Web Worker parsing | parseDxf chạy worker thread → không block host | Medium |
| 4 | LRU cache eviction | Giới hạn memory khi mở nhiều file lớn | Medium |
| 5 | DWG version badge | Hiện version (AC1021=2007, etc) trên toolbar | Low |
| 6 | Thumbnail preview | Thumbnail trong Explorer sidebar | Low |
| 7 | Search entities | Tìm entity theo layer/type/text | Low |
| 8 | Measurement tool | Đo khoảng cách 2 điểm trên bản vẽ | Low |
| 9 | Báo entity bị dxf-parser bỏ rơi | Bản vẽ 3D mở ra trắng mà banner không nói gì — xem mục Phát hiện bên dưới | **High** |
| 10 | Mở rộng unit test | Phủ thêm `parseDxf` (block expansion, resolve màu/linetype) và `parseEdgeLoop` của hatch | Medium |
| 11 | Tối ưu parse file nhiều hatch | `colorwh.dwg` mất 6.8s parse cho 36K entity, trong khi file 45K entity chỉ mất 640ms | Medium |

---

## 🚀 Chuẩn bị publish

Đã đóng gói: **`dwg-previewer-1.0.1.vsix`** — 194 files, 3.09 MB.

Trang public lấy từ `MARKETPLACE.md` (qua `--readme-path`), `README.md` giữ làm tài liệu nội bộ.

Còn 3 việc cần xác nhận trước khi upload:

| Việc | Trạng thái |
|------|-----------|
| `publisher` trong `package.json` đang là `"bumkom"` | ⚠️ phải trùng đúng Publisher ID trên tài khoản Marketplace, sai là bị từ chối |
| `license` vẫn khai `MIT`, chưa có file `LICENSE` | ⚠️ package kèm WASM GPL-3.0 / GPL-2.0 — cần chốt hướng xử lý |
| Chưa có ảnh chụp màn hình trên trang Marketplace | ⚠️ với extension xem hình ảnh, đây là thứ ảnh hưởng tỉ lệ cài đặt mạnh nhất |

---

## 📁 Cấu trúc dự án

```
markdown-dwg-previewer/
├── package.json
├── tsconfig.json
├── tsconfig.test.json        ← build test ra out-test/
├── esbuild.js
├── icon.png                  ← logo 256×256 (ship kèm extension)
├── MARKETPLACE.md            ← trang public trên Marketplace (ship)
├── README.md                 ← tài liệu nội bộ cho team, không ship
├── PROGRESS.md               ← không ship
├── ARCHITECTURE.md           ← không ship
├── .vscodeignore
├── .gitignore
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── assets/                   ← không ship
│   ├── make-icon.py          ← script sinh icon.png
│   ├── preview-32.png        ← xem trước cỡ sidebar
│   └── preview-64.png
├── test/                     ← 48 unit test, không ship
│   ├── matrix.test.ts
│   ├── bulge.test.ts
│   ├── spline.test.ts
│   ├── viewport.test.ts
│   ├── hatch.test.ts
│   ├── renderer.test.ts
│   ├── corpus.ts             ← harness chạy cả thư mục .dwg
│   └── corpus-baseline.json  ← mốc regression (nên commit)
└── src/
    ├── extension.ts
    ├── dwgEditorProvider.ts
    ├── shared/
    │   └── types.ts          ← wire format dùng chung host ↔ webview
    ├── dwg/
    │   └── converter.ts
    ├── dxf/
    │   ├── parseDxf.ts
    │   ├── types.ts          ← re-export từ shared/types.ts
    │   ├── hatch.ts
    │   ├── viewport.ts
    │   ├── bulge.ts
    │   ├── spline.ts
    │   └── matrix.ts
    └── webview/
        ├── main.ts
        ├── renderer.ts
        ├── panZoom.ts
        └── export.ts
```

---

## 🛠 Commands

```bash
npm install          # Cài dependencies
npm run build        # Build extension + webview
npm run watch        # Watch mode
npm run typecheck    # TypeScript check
npm test             # 48 unit test (node:test, không cần dependency ngoài)

# Corpus test — chạy pipeline thật trên cả thư mục .dwg
npm run test:corpus -- /đường/dẫn/tới/thư-mục          # đối chiếu baseline
npm run test:corpus -- /đường/dẫn/tới/thư-mục --save   # ghi baseline mới
npm run package      # Đóng gói .vsix (dùng MARKETPLACE.md làm trang public)

python3 assets/make-icon.py   # Sinh lại icon.png + ảnh xem trước
```

Xem log convert: **View → Output → chọn "DWG Previewer"** trong dropdown.

---

## 📝 Changelog

### 2026-08-12 — 11:32 · Code review & đóng gói
- Fix 11 vấn đề từ đợt rà soát code (xem bảng [Code review & fix](#-code-review--fix-2026-08-12))
- Thêm `src/shared/types.ts` — gộp type wire format về một nguồn duy nhất
- Thêm OutputChannel "DWG Previewer" — log toàn bộ quá trình convert
- Thêm logo `icon.png` 256×256 + `assets/make-icon.py` để sinh lại
- `.vscodeignore` chặn `.claude/`, `assets/`, `ARCHITECTURE.md`, `PROGRESS.md`
- Sửa `ARCHITECTURE.md` cho khớp code, căn lại toàn bộ khối ASCII
- Đóng gói `dwg-previewer-1.0.0.vsix` (3.09 MB)

### 2026-08-12 — Initial release
- **Initial release** — full implementation
- DWG converter: libredwg-web WASM (primary) + libdxfrw-web WASM (fallback)
- DXF parser: full entity support (LINE, CIRCLE, ARC, POLYLINE, SPLINE, ELLIPSE, HATCH, TEXT, MTEXT, INSERT, DIMENSION, POINT, 3DFACE, SOLID, ATTRIB)
- Webview: SVG renderer + pan/zoom + layers + export
- Performance: cache system + progressive rendering
- Tested với 3 file DWG thực tế (420KB → 3.6MB) — tất cả thành công
