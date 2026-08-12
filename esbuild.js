const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', '@mlightcad/libdxfrw-web', '@mlightcad/libredwg-web'],
  sourcemap: true,
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview/main.js',
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
};

async function run() {
  if (watch) {
    const ctxExtension = await esbuild.context(extensionConfig);
    const ctxWebview = await esbuild.context(webviewConfig);
    await Promise.all([ctxExtension.watch(), ctxWebview.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('Build complete.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
