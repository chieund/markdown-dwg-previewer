const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', '@mlightcad/libredwg-web'],
  sourcemap: true,
};

// Worker thread that converts and parses drawings. It sits beside
// out/extension.js so converter.ts resolves the WASM along the same path.
const workerConfig = {
  ...extensionConfig,
  entryPoints: ['src/dwg/worker.ts'],
  outfile: 'out/worker.js',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview/main.js',
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
};

// Corpus test harness. Output lands one level below the project root — the same
// depth as out/extension.js — so converter.ts resolves the WASM through exactly
// the path it will use in the packaged extension.
const corpusConfig = {
  entryPoints: ['test/corpus.ts'],
  bundle: true,
  outfile: 'out-test/corpus.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', '@mlightcad/libredwg-web'],
  sourcemap: true,
};

// Preview harness — renders the real webview to a PNG via headless Chromium.
const previewConfig = {
  entryPoints: ['scripts/preview.ts'],
  bundle: true,
  outfile: 'out-test/preview.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', '@mlightcad/libredwg-web'],
  sourcemap: true,
};

async function run() {
  if (process.argv.includes('--corpus')) {
    await esbuild.build(corpusConfig);
    return;
  }
  if (process.argv.includes('--preview')) {
    await esbuild.build(previewConfig);
    return;
  }
  if (watch) {
    const ctxExtension = await esbuild.context(extensionConfig);
    const ctxWebview = await esbuild.context(webviewConfig);
    const ctxWorker = await esbuild.context(workerConfig);
    await Promise.all([ctxExtension.watch(), ctxWebview.watch(), ctxWorker.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(workerConfig),
    ]);
    console.log('Build complete.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
