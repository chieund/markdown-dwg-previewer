# DWG Previewer

Preview 2D AutoCAD DWG drawings directly in VS Code — opens the drawing as a rendered SVG instead of raw binary.

## Features

- **Zero configuration** — works out of the box, no external tools needed
- **Automatic preview** — double-click any `.dwg` file and it opens as a visual drawing
- **Pan & zoom** — scroll to zoom, drag to pan, double-click to fit
- **Layer control** — show/hide layers individually or all at once
- **Find** — Ctrl+F searches text, attributes, block names, layers and object types on every page
- **Inspect** — click an object to select it (a whole block at once) and see its properties
- **Quantities** — count blocks and measure linework and area per layer, in the drawing's own units (or one you pick)
- **Compare** — visual diff against Git `HEAD`, another file, or two selected files
- **Multi-page** — switch between Model Space and Paper Space sheets
- **Export** — save the current view as SVG or PNG
- **Live reload** — drawing updates automatically when the file changes on disk
- **Dark canvas** — drawings render on a dark background
- **Ask AI** — Claude Code, Copilot and other MCP agents can read counts, sizes and notes from the open drawing (see below)

## How It Works

```
┌─────────┐     ┌──────────────┐     ┌──────────┐     ┌──────────┐
│ .dwg    │────▶│ WASM         │────▶│ DXF      │────▶│ SVG      │
│ (binary)│     │ converter    │     │ parser   │     │ renderer │
└─────────┘     │ (built-in)   │     └──────────┘     └──────────┘
                └──────────────┘
```

1. **DWG → DXF conversion**: A bundled WebAssembly converter (LibreDWG) transforms the binary DWG into DXF text — entirely in-process, no external installation required
2. **DXF parsing**: The DXF text is parsed into a structured drawing model (entities, layers, blocks, viewports)
3. **SVG rendering**: Entities are rendered as SVG elements in a webview panel with full pan/zoom support

### Supported DWG Versions

AutoCAD R14 through AutoCAD 2020 (AC1014 – AC1032).

## Supported Entities

| Category | Entities |
|----------|----------|
| Geometry | LINE · CIRCLE · ARC · POLYLINE · LWPOLYLINE · SPLINE · ELLIPSE |
| Fills | SOLID · HATCH (solid + pattern approximation) |
| Text | TEXT · MTEXT · ATTRIB |
| Blocks | INSERT (nested, rotated, mirrored, scaled, grid arrays) |
| Annotations | DIMENSION (label + line) |
| Other | POINT · 3DFACE (flattened wireframe) |

## Interactions

| Action | Effect |
|--------|--------|
| Scroll wheel | Zoom toward cursor |
| Mouse drag | Pan |
| Double-click | Fit drawing to view |
| Layer checkbox | Hide/show layer (preserves zoom) |
| Page dropdown | Switch between sheets |
| Ctrl+F, Enter / Shift+Enter | Find; next / previous result |
| Click an object | Select it and open the inspector (Esc to clear) |
| Shift+click | Add / remove an object from the selection (length and area in the status bar) |
| *Quantities* | Count blocks, measure length / area / hatch area per layer, copy or export as CSV |
| 🔍 on a quantities row | Select those objects and zoom to them |
| *DWG: Compare with HEAD / with File… / Selected* | Open the visual diff (Explorer, editor title, Source Control) |
| F7 / Shift+F7 (diff view) | Next / previous change |

## Ask AI about your drawing

Let an AI agent read the drawing you have open, so you can ask "how many doors are on this plan?" or "what size is the largest room?" and get an answer from the drawing itself instead of counting by eye.

**What an agent can do**

- Read the drawing: overview (sheets, layers, block counts), text search, and dimensions — counts, sizes and notes
- Highlight and zoom in the preview, so you can see what it is talking about
- Take a snapshot of the view (or a region) to look at it

Vietnamese text in the old TCVN3 fonts (`.Vn*`) now displays correctly in the preview and for the agent.

**Setup**

| Agent | How |
|-------|-----|
| Claude Code | Run **DWG: Connect AI Agents…** (or accept the prompt the first time you open a drawing; it only appears when Claude Code is installed). This runs `claude mcp add` for you and registers the server as `dwg-previewer`. |
| GitHub Copilot | Automatic on VS Code 1.101 or newer. The tools appear in Copilot Chat agent mode; the first use in a session may take a moment while the server starts. |
| Other agents | Run **DWG: Connect AI Agents…** and copy the URL and the `Authorization` header. Add them to the agent's MCP settings; the config format differs per agent, see its MCP documentation. |

**Which files an agent can read.** Drawings in your workspace folders and drawings open in a preview are free. Any other `.dwg` / `.dxf` needs your click on a modal **Allow** prompt first.

**Settings**

| Setting | Description | Default |
|---------|-------------|---------|
| `dwgPreviewer.ai.enabled` | Run the local server that lets AI agents read drawings. It starts the first time you open a drawing, connect an agent or Copilot asks for it. Off: the server stops and nothing new is cached; **DWG: Clear Drawing Cache** removes drawings cached earlier. | `true` |
| `dwgPreviewer.ai.port` | Local port of the server (127.0.0.1 only). If another program uses it, you are told once and AI features stay off until you pick another port. | `45131` |

**Limits.** It works only while VS Code is open — the server lives inside the extension.

**Privacy.** The extension itself sends nothing anywhere. When your agent calls a tool, the drawing text, numbers and snapshots it asks for go to the AI model you chose for that agent, and only then. Agents normally ask before calling a tool. The server listens on 127.0.0.1 and requires a token. Note: Connect passes that token to `claude mcp add` on its command line, so other local processes could see it while that command runs.

## Configuration (Optional)

The extension works without any configuration. For files that the bundled converter
cannot handle (very new DWG versions, corrupted files), you can install an external
converter as fallback:

| Setting | Description | Default |
|---------|-------------|---------|
| `dwgPreviewer.converterPath` | Path to an external converter executable (dwg2dxf or ODAFileConverter). Leave empty to use the bundled converter. | `""` |

### External Converters (Optional Fallback)

**LibreDWG (open source):**
```bash
# Ubuntu/Debian
sudo apt install libredwg-utils

# Fedora/RHEL
sudo dnf install libredwg-utils

# macOS
brew install libredwg
```

**ODA File Converter (free for non-commercial use):**
Download from [Open Design Alliance](https://www.opendesign.com/guestfiles/oda_file_converter).

### Configuration Examples

```json
{
  "dwgPreviewer.converterPath": "/usr/local/bin/dwg2dxf"
}
```

```json
{
  "dwgPreviewer.converterPath": "C:\\Program Files\\ODA\\ODAFileConverter\\ODAFileConverter.exe"
}
```

## Architecture

```
Extension Host (Node.js)          │  Webview (Browser)
──────────────────────────────    │  ──────────────────────
extension.ts (activation)         │  main.ts (toolbar, layers, pages)
dwgEditorProvider.ts (lifecycle)  │  renderer.ts (entity → SVG)
dwg/workerClient.ts ──► worker    │  panZoom.ts (scroll/drag/fit)
── worker thread (out/worker.js) ─│
dwg/converter.ts (DWG→DXF)       │
  ├─ WASM (libredwg-web)         │  export.ts (SVG/PNG output)
  └─ CLI fallback (dwg2dxf)      │
dxf/parseDxf.ts (main parser)    │  Communication:
dxf/hatch.ts (HATCH scanner)     │  Host → Webview: postMessage(DXF_DATA)
dxf/viewport.ts (VP scanner)     │  Webview → Host: postMessage(EXPORT)
dxf/bulge.ts (arc segments)      │
dxf/spline.ts (de Boor)          │
dxf/matrix.ts (2D affine)        │
dxf/types.ts                      │
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Type check
npm run typecheck

# Package as .vsix
npm run package
```

### Debugging

1. Open this project in VS Code
2. Press F5 to launch the Extension Development Host
3. Open any `.dwg` file in the new window

## Troubleshooting

**"Failed to convert DWG file"**
- The file may be a newer DWG version (post-2020) not supported by the bundled converter
- Install an external converter as fallback (see Configuration above)
- Or set `dwgPreviewer.converterPath` to the full path of your converter executable

**Drawing looks incomplete**
- Some entity types may not be supported yet (check the toolbar banner)
- Try opening in AutoCAD and re-saving as a compatible DWG version (R14–2020)

**Large files are slow to open**
- The WASM converter processes the entire file in memory
- Very large drawings (>50MB) may take a few seconds

## License

GPL-3.0-or-later — see [`LICENSE`](LICENSE).

The extension loads and calls the bundled LibreDWG converter (`@mlightcad/libredwg-web`,
GPL-3.0) in-process, so the extension as a whole is distributed under the GPL.
Third-party components and their licenses are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
