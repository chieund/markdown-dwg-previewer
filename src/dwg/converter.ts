/**
 * DWG → DXF Conversion Module
 *
 * Primary: Uses @mlightcad/libredwg-web (WebAssembly, GNU LibreDWG) to convert
 * DWG → DXF entirely in-process. No external tool installation required.
 * Supports AutoCAD R14 through 2020+.
 *
 * Last resort: External CLI tool (dwg2dxf or ODA File Converter) if configured.
 */

import * as path from 'path';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { decodeDxfBuffer } from './encoding';

const execFileAsync = promisify(execFile);

// Lazy-loaded WASM modules. The *promise* is cached, so two drawings opened at
// once share one instance instead of each instantiating (and leaking) its own.
let libredwgModule: Promise<any> | null = null;

/** Optional logger — set by the extension to pipe diagnostics to an OutputChannel. */
let log: (msg: string) => void = () => {};

/** Allows the extension host to inject a logger (e.g. OutputChannel.appendLine). */
export function setConverterLogger(fn: (msg: string) => void): void {
  log = fn;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads the libredwg WASM module (GNU LibreDWG — most capable parser).
 * Uses dynamic import() since the WASM JS file is ESM.
 */
function getLibredwgModule(): Promise<any> {
  libredwgModule ??= (async () => {
    try {
      const wasmPath = path.resolve(__dirname, '..', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm', 'libredwg-web.js');
      // pathToFileURL ensures Windows paths (C:\...) become valid file:// URLs for ESM import()
      const wasmUrl = pathToFileURL(wasmPath).href;
      const { default: createModule } = await import(wasmUrl);
      const module = await createModule();
      log('libredwg-web WASM loaded successfully');
      return module;
    } catch (err) {
      log(`libredwg-web WASM load failed: ${describeError(err)}`);
      libredwgModule = null; // let the next drawing try again
      return null;
    }
  })();
  return libredwgModule;
}

/**
 * Primary converter: GNU LibreDWG via WASM.
 * Uses dwg_write_dxf() — the same function as the CLI `dwg2dxf` tool,
 * but compiled to WebAssembly. Handles complex/large DWG files.
 */
async function convertWithLibredwg(dwgBuffer: Buffer): Promise<string | null> {
  const libredwg = await getLibredwgModule();
  if (!libredwg || !libredwg.dwg_write_dxf) return null;

  try {
    // Write DWG to virtual filesystem
    libredwg.FS.writeFile('/input.dwg', new Uint8Array(dwgBuffer));

    // Convert DWG → DXF using LibreDWG's built-in converter
    const result = libredwg.dwg_write_dxf('/input.dwg', '/output.dxf');

    if (result !== 0) {
      // Non-zero can still succeed (warnings), check if output exists
      try {
        libredwg.FS.stat('/output.dxf');
      } catch {
        log(`libredwg dwg_write_dxf returned ${result} and no output file was produced`);
        return null;
      }
      log(`libredwg dwg_write_dxf returned ${result} (warnings), output file exists`);
    }

    // Read DXF from virtual filesystem. Older DXF versions are written in the
    // drawing's code page (e.g. Shift-JIS), so decode the bytes ourselves.
    const dxfContent = decodeDxfBuffer(libredwg.FS.readFile('/output.dxf'));

    if (!dxfContent || !dxfContent.trim()) {
      log('libredwg produced empty DXF output');
      return null;
    }

    log(`libredwg conversion OK: ${(dxfContent.length / 1024).toFixed(0)}KB DXF`);
    return dxfContent;
  } catch (err) {
    log(`libredwg conversion error: ${describeError(err)}`);
    return null;
  } finally {
    try { libredwg.FS.unlink('/input.dwg'); } catch { /* ignore */ }
    try { libredwg.FS.unlink('/output.dxf'); } catch { /* ignore */ }
  }
}

/**
 * Converts a DWG buffer to DXF text.
 *
 * Strategy:
 * 1. libredwg-web WASM (bundled, zero-install — GNU LibreDWG)
 * 2. External CLI tool on PATH (dwg2dxf or ODA File Converter), as a fallback
 */
export async function convertDwgToDxf(
  dwgBuffer: Buffer,
  dwgPath: string,
  converterPath: string
): Promise<string> {
  log(`Converting ${path.basename(dwgPath)} (${(dwgBuffer.length / 1024).toFixed(0)}KB)`);

  // If user explicitly configured a CLI tool, use it directly
  if (converterPath) {
    log(`Strategy: configured CLI converter (${converterPath})`);
    return convertWithCli(dwgBuffer, dwgPath, converterPath);
  }

  // Try libredwg-web first (most capable, handles large/complex files)
  log('Strategy 1/2: libredwg-web WASM');
  const libredwgResult = await convertWithLibredwg(dwgBuffer);
  if (libredwgResult) return libredwgResult;

  // Last resort: CLI tool on PATH
  log('Strategy 2/2: searching PATH for an external CLI converter');
  const tool = await findConverter();
  if (tool) {
    log(`Found CLI converter: ${tool}`);
    return convertWithCli(dwgBuffer, dwgPath, tool);
  }

  log('No external converter found — both strategies exhausted');
  throw new Error(
    'Failed to convert DWG file.\n\n' +
      'The bundled converter could not process this file.\n\n' +
      'You can install an external converter as fallback:\n' +
      '  • LibreDWG (provides dwg2dxf): sudo apt install libredwg-utils\n' +
      '  • ODA File Converter: https://www.opendesign.com/guestfiles/oda_file_converter\n\n' +
      'Or set "dwgPreviewer.converterPath" in VS Code settings.'
  );
}

/**
 * Converts using an external CLI tool.
 */
async function convertWithCli(dwgBuffer: Buffer, dwgPath: string, tool: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwg-preview-'));
  const baseName = path.basename(dwgPath, '.dwg');
  const tmpDwg = path.join(tmpDir, `${baseName}.dwg`);
  const tmpDxf = path.join(tmpDir, `${baseName}.dxf`);

  try {
    await fs.writeFile(tmpDwg, dwgBuffer);
    const toolName = path.basename(tool).toLowerCase();
    if (toolName.includes('odafileconverter')) {
      await execFileAsync(tool, [tmpDir, tmpDir, 'ACAD2018', 'DXF', '0', '1'], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
    } else {
      try {
        await execFileAsync(tool, [tmpDwg, '-o', tmpDxf], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
      } catch (err) {
        // dwg2dxf may warn but still produce output — only a missing/empty
        // DXF below proves it actually failed.
        log(`CLI ${toolName} exited non-zero (may still have written output): ${describeError(err)}`);
      }
    }
    const dxfContent = decodeDxfBuffer(await fs.readFile(tmpDxf));
    if (!dxfContent.trim()) throw new Error('Converter produced an empty DXF file.');
    log(`CLI conversion OK: ${(dxfContent.length / 1024).toFixed(0)}KB DXF`);
    return dxfContent;
  } catch (err) {
    log(`CLI conversion failed (${tool}): ${describeError(err)}`);
    throw err;
  } finally {
    await cleanupDir(tmpDir);
  }
}

async function findConverter(): Promise<string | null> {
  const candidates = ['dwg2dxf', 'ODAFileConverter', '/usr/local/bin/dwg2dxf', '/usr/bin/dwg2dxf'];
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\ODA\\ODAFileConverter\\ODAFileConverter.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/dwg2dxf');
  }
  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  if (!path.isAbsolute(filePath) && !filePath.includes(path.sep)) {
    try {
      await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [filePath], { timeout: 5_000 });
      return true;
    } catch { return false; }
  }
  try { await fs.access(filePath, fs.constants.X_OK); return true; } catch { return false; }
}

async function cleanupDir(dirPath: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(dirPath)) await fs.unlink(path.join(dirPath, entry)).catch(() => {});
    await fs.rmdir(dirPath).catch(() => {});
  } catch { /* best effort */ }
}
