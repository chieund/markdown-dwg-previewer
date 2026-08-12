/**
 * Preview harness — dựng lại webview thật ra một file HTML độc lập, để chụp
 * màn hình bằng Chromium headless mà không cần mở VS Code.
 *
 *   npm run preview -- <file.dwg|file.dxf> [thư-mục-xuất]
 *
 * Dùng đúng CSS (`src/webview/styles.ts`) và đúng bundle webview
 * (`out/webview/main.js`) mà bản đóng gói dùng, nên ảnh chụp phản ánh giao diện
 * thật chứ không phải một bản dựng lại gần giống.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { convertDwgToDxf } from '../src/dwg/converter';
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
  throw new Error(`Không tìm thấy Chromium. Đã thử: ${BROWSERS.join(', ')}`);
}

async function toDxfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const format = detectDrawingFormat(buffer);
  if (format === 'dxf-text') return buffer.toString('utf-8');
  if (format === 'dwg') return convertDwgToDxf(buffer, filePath, '');
  throw new Error(`Không đọc được định dạng: ${format}`);
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
    console.error('Thiếu file.\n  npm run preview -- <file.dwg|file.dxf> [thư-mục-xuất]');
    process.exit(2);
  }

  const outDir = outDirArg ?? path.resolve(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const dxf = await toDxfText(source);
  const parsed = parseDxf(dxf);
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
  console.log(`  ảnh: ${path.relative(process.cwd(), target)}`);
}

void main();
