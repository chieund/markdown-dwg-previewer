import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { DwgEditorProvider } from './dwgEditorProvider';
import { DrawingWorker } from './dwg/workerClient';
import { DrawingStore } from './ai/drawingStore';
import { PreviewBridge } from './ai/previewBridge';
import { startAiFeature, type AiFeature } from './ai/extensionHost';
import { registerCompareCommands } from './compareCommands';

let aiFeature: AiFeature | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('DWG Previewer');
  const log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);

  // Built next to extension.js (see esbuild.js), so the converter in the worker
  // finds the bundled WASM along the same relative path.
  const worker = new DrawingWorker(vscode.Uri.joinPath(context.extensionUri, 'out', 'worker.js').fsPath, log);

  // A few recent drawings in memory, so reopening a tab is instant. The disk cache is attached by the AI feature while it is on.
  const store = new DrawingStore({
    stat: async (p) => {
      const s = await fs.stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    parse: async (p, progress) => {
      progress('reading');
      const bytes = await fs.readFile(p);
      const converterPath = vscode.workspace.getConfiguration('dwgPreviewer').get<string>('converterPath', '');
      // Conversion and parsing run on a worker thread, off the extension host's.
      return worker.run(bytes, p, converterPath, progress);
    },
    capacity: 4,
  });

  // Drawings that are not plain files (the `git:` old side of a diff, `vscode-vfs:`, …): the key is the
  // full uri, the bytes come from VS Code, and nothing is written to disk or offered to an agent.
  const memoryStore = new DrawingStore({
    stat: async (key) => {
      const s = await vscode.workspace.fs.stat(vscode.Uri.parse(key));
      return { mtimeMs: s.mtime, size: s.size };
    },
    parse: async (key, progress) => {
      const uri = vscode.Uri.parse(key);
      progress('reading');
      const bytes = await vscode.workspace.fs.readFile(uri);
      const converterPath = vscode.workspace.getConfiguration('dwgPreviewer').get<string>('converterPath', '');
      return worker.run(bytes, uri.fsPath, converterPath, progress);
    },
    capacity: 4,
  });

  const bridge = new PreviewBridge({
    open: async (p) => {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(p), DwgEditorProvider.viewType, { preserveFocus: true });
    },
    load: (p) => store.get(p),
  });

  context.subscriptions.push(
    outputChannel,
    { dispose: () => void worker.dispose() },
    vscode.window.registerCustomEditorProvider(
      DwgEditorProvider.viewType,
      new DwgEditorProvider(context, store, memoryStore, bridge),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  registerCompareCommands(context, worker);
  try {
    aiFeature = startAiFeature(context, store, bridge, log);
    context.subscriptions.push(aiFeature);
  } catch (e) {
    log(`AI server could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function deactivate(): Promise<void> | undefined {
  return aiFeature?.stopped();
}
