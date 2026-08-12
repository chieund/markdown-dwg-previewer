# DWG Previewer — Tiến độ phát triển

**Cập nhật lần cuối:** 2026-08-12 15:55

**Trạng thái:** đã đóng gói `dwg-previewer-1.0.3.vsix` (3.09 MB) — sẵn sàng upload Marketplace, còn 3 việc cần xác nhận ở mục [Chuẩn bị publish](#-chuẩn-bị-publish)

**Đang mở:** `.dwg` và `.dxf` · **72 unit test** · **corpus 17/17** · typecheck sạch

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
- [x] `extension.ts` — activation, đăng ký custom editor cho `*.dwg` và `*.dxf`
- [x] `dwgEditorProvider.ts` — lifecycle, webview HTML, file watcher, export handler
- [x] **Cache hệ thống** — kết quả parse cache theo `path + mtime`, mở lại cùng file = instant
- [x] **Progress messages** — gửi stage (reading → converting → parsing) cho webview
- [x] **OutputChannel "DWG Previewer"** — `setConverterLogger()` bơm logger vào converter, mọi bước convert đều có vết để hỗ trợ user khi file lỗi

### 3. Nhận diện định dạng (`src/dwg/format.ts`)
- [x] `detectDrawingFormat()` — phân biệt DWG / DXF text / DXF nhị phân **bằng header của file, không tin phần mở rộng**
- [x] File `.dxf` **bỏ qua hoàn toàn bước convert**, đưa thẳng vào parser — DXF vốn là định dạng trung gian của extension
- [x] DXF nhị phân và file lạ được báo lỗi rõ ràng kèm cách khắc phục, thay vì mở ra canvas trắng
- [x] Đã kiểm chứng: 17 file DXF sinh từ corpus DWG cho **entity count khớp tuyệt đối**, convert từ 14–562ms xuống 0–13ms

### 4. DWG → DXF Converter (`src/dwg/converter.ts`)
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

### 5. Shared types (`src/shared/types.ts`)
- [x] **Single source of truth** cho wire format truyền qua `postMessage`
- [x] Cả extension host lẫn webview import từ đây → sửa lệch một bên là compile lỗi ngay, không còn rủi ro sai âm thầm lúc runtime
- [x] `src/dxf/types.ts` giữ lại làm lớp re-export để các file trong `dxf/` không phải sửa import

### 6. DXF Parser (`src/dxf/`)
- [x] `parseDxf.ts` — main parser (dxf-parser + custom scanners, 1400+ lines)
- [x] `hatch.ts` — HATCH entity scanner (solid + pattern fill)
- [x] `viewport.ts` — viewport scanner + paper→model transform
- [x] `bulge.ts` — polyline arc segment expansion
- [x] `spline.ts` — B-spline de Boor sampling
- [x] `matrix.ts` — 2D affine transforms (translate/rotate/scale/mirror) + `extrusionMatrix()` cho OCS
- [x] `types.ts` — re-export từ `shared/types.ts` (giữ đường import cũ cho các file trong `dxf/`)

### 7. Webview Renderer (`src/webview/`)
- [x] `main.ts` — toolbar, layers panel, page selector, message handling
- [x] `renderer.ts` — entity → SVG element rendering
- [x] `panZoom.ts` — scroll zoom, drag pan, double-click fit
- [x] `export.ts` — SVG/PNG export
- [x] **Progressive rendering** — file lớn render theo batch 3000 entities/frame (requestAnimationFrame)
- [x] **Generation token** — mỗi lần `renderCanvas` chạy sẽ tăng counter; chuỗi rAF cũ thấy lệch là thoát ngay, không còn nhiều lượt render chồng nhau khi toggle layer liên tục
- [x] **Dọn listener** — `disposeLayerOutsideClick` gỡ listener `document` của layer panel trước khi dựng panel mới, không rò khi chuyển page
- [x] **Progress indicator** — hiển thị stage: Reading → Converting → Parsing
- [x] **Empty state** — canvas trống luôn tự giải thích: bản vẽ không có hình 2D, hay đã ẩn hết layer (kèm nút hoàn tác)
- [x] **Thanh trạng thái** — toạ độ con trỏ theo đơn vị bản vẽ, mức zoom, số object, và dòng gợi ý thao tác
- [x] **Nút zoom −/+/Fit** trên toolbar — trước đó chỉ có lăn chuột và double-click, người dùng trackpad bị kẹt
- [x] **Lọc + isolate layer** — ô tìm kiếm và nút `only`; bản vẽ 117 layer không còn phải cuộn tay
- [x] Kéo bằng chuột giữa, con trỏ đổi thành `grabbing` khi kéo
- [x] CSS tách ra `src/webview/styles.ts` để preview harness dùng lại được
- [x] Dark theme CSS khớp VS Code variables

### 8. Supported Entities
| Category | Entities |
|----------|----------|
| Geometry | LINE · CIRCLE · ARC · POLYLINE · LWPOLYLINE · SPLINE · ELLIPSE |
| Fills | SOLID · HATCH (solid + pattern) |
| Text | TEXT · MTEXT · ATTRIB |
| Blocks | INSERT (nested, rotated, mirrored, scaled, grid arrays) |
| Annotations | DIMENSION (label + line) |
| Other | POINT · 3DFACE (wireframe) |

### 9. Unit test (`test/`)
- [x] **72 test, chạy bằng `node:test`** — Node 20 có sẵn, không thêm dependency nào
- [x] `matrix.test.ts` — compose/thứ tự nhân, similarity vs scale không đều, mirror qua dấu determinant
- [x] `bulge.test.ts` — bulge 1 = nửa đường tròn, bulge âm đảo chiều, polyline đóng không lặp điểm đầu
- [x] `spline.test.ts` — de Boor khớp Bézier tại điểm giữa, input hỏng trả về rỗng, curve nằm trong convex hull
- [x] `viewport.test.ts` — transform paper↔model, twist, loại pseudo-viewport của chính tờ giấy
- [x] `hatch.test.ts` — quét HATCH từ group code thô, boundary cong, loại loop dưới 3 điểm
- [x] `renderer.test.ts` — cờ large-arc và sweep âm trong `arcToPathData`
- [x] `format.test.ts` — nhận diện DWG/DXF/DXF nhị phân, BOM, comment 999, file đổi đuôi sai
- [x] `panZoom.test.ts` — chiều zoom, giữ điểm neo khi zoom, ánh xạ toạ độ con trỏ
- [x] `insert-ocs.test.ts` — ma trận OCS + hai test parse thật cho INSERT bị mirror (test parseDxf đầu tiên của dự án)
- [x] **Đã mutation test** — cố tình phá 5 chỗ (đảo thứ tự `multiply`, đảo chiều bulge, bỏ cờ large-arc, lệch chỉ số knot, sai dấu twist), cả 5 đều bị test bắt

### 10. Preview harness (`scripts/preview.ts`)
- [x] Dựng webview thật ra HTML rồi chụp bằng Chromium headless — **dùng đúng CSS và đúng bundle** của bản đóng gói, không phải bản dựng lại gần giống
- [x] Có cờ `--layers` / `--filter` / `--hidden` để chụp cả những state cần thao tác
- [x] **Đã bắt được bug thật**: `.dwg-layer-row` có `display: flex` đè lên `[hidden]` của trình duyệt → ô lọc layer gõ vào mà danh sách không đổi. Typecheck và unit test không thể phát hiện lỗi này
- [x] Ảnh xuất ra `assets/` — dùng luôn được làm ảnh minh hoạ cho Marketplace

### 11. Corpus test (`test/corpus.ts`)
- [x] Chạy pipeline thật (DWG → DXF → parse) trên cả một thư mục `.dwg`, báo cáo từng file: size, DXF size, thời gian convert/parse, số page/entity/layer
- [x] **Baseline regression** — `test/corpus-baseline.json` lưu kết quả mốc; lần chạy sau tụt entity hoặc chuyển sang lỗi là báo REGRESSION và exit code 1
- [x] Bundle ra `out-test/corpus.js` — cùng độ sâu thư mục với `out/extension.js`, nên converter tìm WASM đúng theo đường dẫn dùng khi đóng gói thật
- [x] **Đã kiểm chứng harness** — tắt `injectHatches()` thì 4 file tụt entity, báo REGRESSION, exit 1; bật lại thì khớp baseline, exit 0
- [x] Kết quả trên 17 sample drawing của AutoCAD: **17/17 convert + parse thành công**

### 12. User Features
- [x] Zero-config — cài extension, mở file `.dwg` / `.dxf` = xem luôn
- [x] Pan & zoom — cuộn chuột, kéo (trái hoặc giữa), double-click để fit
- [x] Nút zoom `−` / `+` / `Fit` trên toolbar — không bắt buộc phải có bánh lăn
- [x] Thanh trạng thái — toạ độ con trỏ, mức zoom, số object, gợi ý thao tác
- [x] Layer control — show/hide, **lọc theo tên**, nút **isolate** từng layer
- [x] Multi-page — Model Space + Paper Space sheets
- [x] Empty state — canvas trống luôn tự giải thích, kèm nút hoàn tác
- [x] Export SVG/PNG — save current view
- [x] Live reload — file watcher auto-refresh
- [x] Dark theme — matches VS Code

---

## 📊 Performance

Số đo thật từ `npm run test:corpus` trên 17 bản vẽ mẫu của AutoCAD.

| Bước | Đường DWG | Đường DXF |
|------|-----------|-----------|
| Đọc + convert | 14 – 562 ms | 0 – 13 ms (không cần convert) |
| Parse | 5 – 6.812 ms | 5 – 1.499 ms |
| Render first paint | ~200 ms | ~200 ms |
| Render đầy đủ (progressive) | ~1,5 s với file lớn | như DWG |
| Mở lại file không đổi | ~0 ms (cache theo path + mtime) | ~0 ms |

File nặng nhất trong corpus — `colorwh.dwg`, 1,7 MB → DXF 9,2 MB → 36.431 entity:
convert 562 ms, parse 6,8 s. Cùng nội dung đó nạp thẳng từ `.dxf` chỉ mất 1,5 s parse,
vì bỏ được cả bước convert lẫn áp lực bộ nhớ mà WASM tạo ra.

**6,8 s cho 36K entity là điểm bất thường** — file 45K entity của khách chỉ mất 640 ms.
Nhiều khả năng do file này dày đặc HATCH. Đã đưa vào backlog.

---

## 📋 Test Results (2026-08-12)

### Bản vẽ thật của khách

| File | Size | DXF Output | Entities | Layers | INSERT bị mirror | Status |
|------|------|-----------|----------|--------|------------------|--------|
| `Real-world drawing A` | 420KB | 2.8MB | 1,931 | 32 | 4 / 304 | ✅ |
| `Real-world drawing B` | 455KB | 2.2MB | 1,135 | 42 | **29 / 152** | ✅ |
| `Real-world drawing C` | 3,623KB | 18.5MB | 45,552 | 117 | 0 / 1016 | ✅ |

Tất cả đều convert + parse + render thành công mà user **không cần cài tool nào**.

Cột cuối là số block bị lệch trước khi có fix OCS ở v1.0.3 — xem mục
[Đồng bộ fix từ dự án DXF](#-đồng-bộ-fix-từ-dự-án-markdown-dxf-previewer).

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

**Đã xử lý một nửa ở v1.0.3:** empty state giờ hiện thông báo giải thích canvas trống, nên
người dùng không còn nhìn vào màn hình đen câm lặng. Nhưng vì `skippedEntityTypes` vẫn rỗng,
thông báo chỉ nói chung chung là "bản vẽ dựng từ 3D solid/mesh/surface" mà **không nêu được
đúng loại entity** có trong file. Banner trên toolbar cũng vẫn không hiện gì.

Để dứt điểm, parser cần đếm entity type từ chính DXF text rồi đối chiếu với những gì đã map
— khi đó cả banner lẫn empty state mới nói đúng tên. Vẫn nằm trong backlog, priority High.

---

## 🔗 Đồng bộ fix từ dự án `markdown-dxf-previewer`

Hai dự án dùng chung phần lớn `src/dxf/`, nên fix bên kia phải được port sang.

**Đã port — INSERT bị mirror vẽ sai vị trí và sai góc** (nguồn: commit `f879b0d`, 11/08)

Lệnh MIRROR của AutoCAD thường không đụng tới hình học của block mà lật hướng đùn của
INSERT thành `(0,0,-1)`. Điểm chèn (code 10/20) và góc xoay (code 50) khi đó ghi theo hệ
toạ độ OCS đã lật, không phải toạ độ thế giới — đọc thẳng là đặt sai chỗ mọi block bị mirror.

Cách sửa: `extrusionMatrix()` trong `src/dxf/matrix.ts` (thuật toán arbitrary axis của DXF),
nhân vào ngoài cùng chuỗi transform trong `expandInsert`.

Vì sao lọt qua mọi vòng kiểm tra trước đó: **17 file mẫu của AutoCAD không có INSERT nào bị
mirror**, nên corpus test không thể chạm tới. Chỉ bản vẽ kiến trúc thật mới dùng MIRROR nhiều.

Kiểm chứng: tắt fix → test đỏ; ảnh chụp trước/sau trên `Real-world drawing B` cho
thấy nét vẽ nằm ngoài khung bản vẽ giảm từ 64 px và 61 px xuống **0**.

**Chưa rà:** các commit khác của dự án DXF (`3eb0b06`, `bd179a3`) đụng vào `parseDxf.ts`,
`viewport.ts`, `renderer.ts`, `export.ts` — chưa đối chiếu xem còn khác biệt nào đáng port.

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

| # | Việc | Vì sao | Priority |
|---|------|--------|----------|
| 1 | Báo đúng entity bị dxf-parser bỏ rơi | Bản vẽ 3D mở ra trống mà banner không nêu được tên entity — xem [Phát hiện từ corpus](#-phát-hiện-từ-corpus-bản-vẽ-3d-mở-ra-trắng-mà-không-báo-gì) | **High** |
| 2 | Rà nốt fix từ dự án DXF | Commit `3eb0b06`, `bd179a3` đụng `parseDxf`/`viewport`/`renderer`/`export`, chưa đối chiếu | **High** |
| 3 | Thêm bản vẽ kiến trúc thật vào corpus | 17 file mẫu AutoCAD không có INSERT mirror nên không bắt được lỗi vừa rồi | **High** |
| 4 | Viewport culling | Chỉ render entity trong vùng nhìn → giảm lag zoom/pan file lớn | High |
| 5 | Canvas 2D renderer | Thay SVG bằng Canvas cho file >20K entity | High |
| 6 | Web Worker parsing | `parseDxf` chạy worker thread → không block extension host | Medium |
| 7 | LRU cache eviction | `parseCache` không có trần, mở nhiều file lớn là phình RAM | Medium |
| 8 | Tối ưu parse file nhiều hatch | `colorwh.dwg` mất 6,8 s cho 36K entity, trong khi file 45K entity chỉ mất 640 ms | Medium |
| 9 | Mở rộng unit test | Phủ thêm `parseDxf` (block expansion, resolve màu/linetype) và `parseEdgeLoop` của hatch | Medium |
| 10 | Nền sáng cho canvas | Canvas hardcode `#1e1e1e`; muốn theo theme sáng phải đảo màu ACI 7 theo nền | Medium |
| 11 | Export toàn bộ bản vẽ | Hiện chỉ xuất đúng khung nhìn, PNG giới hạn cạnh 2400 px, không có lựa chọn khác | Medium |
| 12 | Trạng thái lỗi thân thiện | `showError` xoá cả toolbar và hiện stack trace JavaScript, không có nút thử lại | Medium |
| 13 | DWG version badge | Hiện version (AC1021 = 2007…) trên toolbar | Low |
| 14 | Thumbnail preview | Thumbnail trong Explorer sidebar — `DwgDatabase` của libredwg có sẵn `thumbnailImage` | Low |
| 15 | Search entities | Tìm entity theo layer / type / nội dung text | Low |
| 16 | Measurement tool | Đo khoảng cách 2 điểm trên bản vẽ | Low |

### Hướng lớn đáng cân nhắc

**Bỏ vòng DXF text trung gian.** `@mlightcad/libredwg-web` đã expose `dwg_read_data()` +
`convert()` trả thẳng `DwgDatabase` có cấu trúc (36 entity type đã định nghĩa, gồm cả HATCH /
VIEWPORT / ATTRIB / LEADER / MULTILEADER / TABLE). Hiện tại pipeline đang đi
`DWG → chuỗi DXF 18 MB → quét 7 lượt`. Dùng `convert()` sẽ bỏ được chuỗi trung gian, xoá
khoảng 700 dòng raw scanner tự viết, và mở đường cho các entity chưa hỗ trợ.

Cần spike đối chiếu số lượng entity trước khi làm — corpus baseline chính là lưới an toàn.

---

## 🚀 Chuẩn bị publish

Đã đóng gói: **`dwg-previewer-1.0.3.vsix`** — 194 files, 3.09 MB.

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
├── esbuild.js                ← 4 target: extension · webview · corpus · preview
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
│   ├── preview-64.png
│   └── preview-*.png         ← ảnh UI thật, dùng được cho Marketplace
├── scripts/                  ← không ship
│   └── preview.ts            ← chụp UI thật bằng Chromium headless
├── test/                     ← 72 unit test, không ship
│   ├── matrix.test.ts
│   ├── bulge.test.ts
│   ├── spline.test.ts
│   ├── viewport.test.ts
│   ├── hatch.test.ts
│   ├── renderer.test.ts
│   ├── format.test.ts        ← nhận diện DWG / DXF / DXF nhị phân
│   ├── panZoom.test.ts       ← toán zoom, giữ điểm neo
│   ├── insert-ocs.test.ts    ← INSERT bị mirror (test parseDxf đầu tiên)
│   ├── corpus.ts             ← harness chạy cả thư mục .dwg/.dxf
│   └── corpus-baseline.json  ← mốc regression (nên commit)
└── src/
    ├── extension.ts
    ├── dwgEditorProvider.ts
    ├── shared/
    │   └── types.ts          ← wire format dùng chung host ↔ webview
    ├── dwg/
    │   ├── format.ts         ← nhận diện định dạng theo header
    │   └── converter.ts      ← DWG → DXF, 3 chiến lược
    ├── dxf/
    │   ├── parseDxf.ts
    │   ├── types.ts          ← re-export từ shared/types.ts
    │   ├── hatch.ts
    │   ├── viewport.ts
    │   ├── bulge.ts
    │   ├── spline.ts
    │   └── matrix.ts         ← affine 2D + extrusionMatrix (OCS)
    └── webview/
        ├── main.ts
        ├── styles.ts         ← CSS tách riêng, preview harness dùng lại
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
npm test             # 72 unit test (node:test, không cần dependency ngoài)

# Corpus test — chạy pipeline thật trên cả thư mục .dwg
npm run test:corpus -- /đường/dẫn/tới/thư-mục          # đối chiếu baseline
npm run test:corpus -- /đường/dẫn/tới/thư-mục --save   # ghi baseline mới

npm run package      # Đóng gói .vsix (dùng MARKETPLACE.md làm trang public)

# Chụp UI thật bằng Chromium headless → assets/
npm run preview -- <file.dwg|file.dxf>
npm run preview -- <file> --layers    # mở sẵn panel layer
npm run preview -- <file> --filter    # panel layer đang lọc
npm run preview -- <file> --hidden    # trạng thái ẩn hết layer

python3 assets/make-icon.py   # Sinh lại icon.png + ảnh xem trước
```

Xem log convert: **View → Output → chọn "DWG Previewer"** trong dropdown.

---

## 📝 Changelog

### 2026-08-12 — 15:55 · v1.0.3 · Cải thiện UI/UX + sửa INSERT bị mirror

**Sửa lỗi — INSERT bị mirror vẽ sai vị trí và sai góc**

Lệnh MIRROR của AutoCAD thường không đụng tới hình học của block mà lật hướng đùn
của INSERT thành `(0,0,-1)`; điểm chèn và góc xoay khi đó ghi theo hệ OCS đã lật
chứ không phải toạ độ thế giới. Đọc thẳng là đặt sai chỗ mọi block bị mirror.

- Port `extrusionMatrix()` (thuật toán arbitrary axis của DXF) từ dự án
  `markdown-dxf-previewer` — commit `f879b0d`, lỗi đã được sửa bên đó ngày 11/08
- Ảnh hưởng thật: `Real-world drawing B` có **29/152 INSERT** bị mirror,
  `Real-world drawing A` có 4/304
- 17 file mẫu AutoCAD **không có** INSERT mirror nào — nên corpus test không thể
  phát hiện lỗi này, đó là lý do nó lọt qua mọi vòng kiểm tra trước đó
- Kiểm chứng bằng ảnh trước/sau: nét vẽ nằm ngoài khung bản vẽ giảm từ 64 px và
  61 px xuống 0

**Cải thiện UI/UX**
- **Empty state** — canvas trống giờ luôn nói rõ lý do; sửa lỗi P0 mà corpus test đã phát hiện (bản vẽ 3D mở ra đen trơn không một lời giải thích)
- **Thanh trạng thái** — toạ độ, mức zoom, số object, gợi ý thao tác (giải quyết việc double-click = fit trước đây không ai biết)
- **Nút zoom −/+/Fit** trên toolbar
- **Lọc layer + nút isolate** cho bản vẽ nhiều layer
- Kéo bằng chuột giữa; con trỏ đổi thành `grabbing` khi kéo
- Thêm `scripts/preview.ts` — chụp UI thật bằng Chromium headless
- Sửa bug `[hidden]` bị `display: flex` đè, do preview harness phát hiện
- Thêm 7 test cho phần toán zoom (tổng 66)

### 2026-08-12 — 13:30 · v1.0.2 · Hỗ trợ file DXF
- Mở được trực tiếp file `.dxf`, **bỏ qua hoàn toàn bước convert** — DXF vốn là định dạng trung gian của extension
- `src/dwg/format.ts` — nhận diện định dạng bằng header, không tin phần mở rộng
- DXF nhị phân / file lạ báo lỗi rõ ràng kèm cách khắc phục thay vì mở ra trắng
- displayName → "AutoCAD DWG & DXF Previewer", thêm keyword `dxf` / `dxf viewer`
- Thêm 11 unit test cho phần nhận diện (tổng 59)
- Corpus harness nhận cả `.dxf`; kiểm chứng 17 file DXF cho entity count khớp tuyệt đối với đường DWG
- Thêm dòng miễn trừ nhãn hiệu Autodesk trên trang Marketplace
- Đóng gói `dwg-previewer-1.0.2.vsix`

### 2026-08-12 — 11:32 · v1.0.1 · Code review & đóng gói
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
