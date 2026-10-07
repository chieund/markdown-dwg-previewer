/**
 * Preview harness — rebuilds the real webview as a standalone HTML file so it can
 * be screenshotted with headless Chromium, without opening VS Code.
 *
 *   npm run preview -- <file.dwg|file.dxf> [output-folder]
 *
 * Uses the same CSS (`src/webview/styles.ts`) and the same webview bundle
 * (`out/webview/main.js`) as the packaged extension, so screenshots show the real
 * UI rather than a lookalike.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { convertDwgToDxf } from '../src/dwg/converter';
import { decodeDxfBuffer } from '../src/dwg/encoding';
import { detectDrawingFormat } from '../src/dwg/format';
import { parseDxf } from '../src/dxf/parseDxf';
import { WEBVIEW_STYLES } from '../src/webview/styles';

const WIDTH = 1400;
const HEIGHT = 900;

const BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

function findBrowser(): string {
  for (const candidate of BROWSERS) {
    try {
      execFileSync('which', [candidate], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`Chromium not found. Tried: ${BROWSERS.join(', ')}`);
}

async function toDxfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const format = detectDrawingFormat(buffer);
  if (format === 'dxf-text') return decodeDxfBuffer(buffer);
  if (format === 'dwg') return convertDwgToDxf(buffer, filePath, '');
  throw new Error(`Unreadable format: ${format}`);
}

/**
 * Optional scripted interaction, so states that need a click — the layer panel,
 * a filtered list — can be captured too.
 */
function interactionScript(action: string | undefined): string {
  if (action === 'layers') {
    return `document.querySelector('.dwg-layer-button')?.click();`;
  }
  if (action === 'filter') {
    return `
      document.querySelector('.dwg-layer-button')?.click();
      const box = document.querySelector('.dwg-layer-filter');
      if (box) {
        box.value = 'wall';
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }`;
  }
  if (action === 'hidden') {
    return `document.querySelectorAll('.dwg-layer-action')[1]?.click();`;
  }
  if (action === 'isolate') {
    // "only" on the Walls layer — every other layer switched off in place
    return `[...document.querySelectorAll('.dwg-layer-row')]
      .find((row) => row.textContent.includes('Walls'))
      ?.querySelector('.dwg-layer-isolate')?.click();`;
  }
  if (action === 'roundtrip') {
    // Hide everything, then show it again: must end exactly where it started
    return `
      document.querySelectorAll('.dwg-layer-action')[1]?.click();
      document.querySelectorAll('.dwg-layer-action')[0]?.click();`;
  }
  return '';
}

function buildHtml(parsed: ReturnType<typeof parseDxf>, action?: string): string {
  const bundle = fs.readFileSync(path.resolve(__dirname, '..', 'out', 'webview', 'main.js'), 'utf-8');
  const payload = JSON.stringify({ type: 'DXF_DATA', ...parsed })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>${WEBVIEW_STYLES}</style>
</head>
<body>
<div id="root"></div>
<script>
  // The webview talks to the extension host through this bridge; nothing is
  // listening here, so the calls are simply recorded.
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
</script>
<script>${bundle}</script>
<script>
  window.postMessage(${payload}, '*');
  setTimeout(() => { ${interactionScript(action)} }, 300);
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args.find((a) => a.startsWith('--'))?.slice(2);
  const [source, outDirArg] = args.filter((a) => !a.startsWith('--'));
  if (!source) {
    console.error('Missing file.\n  npm run preview -- <file.dwg|file.dxf> [output-folder]');
    process.exit(2);
  }

  const outDir = outDirArg ?? path.resolve(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const dxf = await toDxfText(source);
  const isDxf = detectDrawingFormat(fs.readFileSync(source)) === 'dxf-text';
  const parsed = parseDxf(dxf, { trustLayerOffFlags: isDxf });
  const entities = parsed.pages.reduce((sum, page) => sum + page.entities.length, 0);
  console.log(
    `${path.basename(source)} → ${parsed.pages.length} page, ${entities} entity, ` +
    `${parsed.pages[0]?.layers.length ?? 0} layer`
  );

  // Drawing names carry spaces and brackets; keep both the temp page and the
  // screenshot on plain names so the file:// URL and any web link stay simple.
  const name = path.basename(source).replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  // Chromium may be sandboxed (snap builds cannot reach /tmp), so the page is
  // staged inside the project tree, which is always readable by the browser.
  const stageDir = path.resolve(__dirname, '..', 'out-test', 'preview-tmp');
  fs.mkdirSync(stageDir, { recursive: true });
  const tmpHtml = path.join(stageDir, `${name}.html`);
  fs.writeFileSync(tmpHtml, buildHtml(parsed, action), 'utf-8');

  const target = path.join(outDir, `preview-${name}${action ? '-' + action : ''}.png`);

  execFileSync(
    findBrowser(),
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--window-size=${WIDTH},${HEIGHT}`,
      // Lets requestAnimationFrame batches finish before the shot is taken.
      '--virtual-time-budget=8000',
      `--screenshot=${target}`,
      pathToFileURL(tmpHtml).href,
    ],
    { stdio: 'pipe' }
  );

  fs.rmSync(tmpHtml, { force: true });
  console.log(`  image: ${path.relative(process.cwd(), target)}`);
}

void main();
