import * as vscode from 'vscode';
import { DwgEditorProvider } from './dwgEditorProvider';
import { DrawingWorker } from './dwg/workerClient';
import { registerCompareCommands } from './compareCommands';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('DWG Previewer');
  const log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);

  // Built next to extension.js (see esbuild.js), so the converter in the worker
  // finds the bundled WASM along the same relative path.
  const worker = new DrawingWorker(vscode.Uri.joinPath(context.extensionUri, 'out', 'worker.js').fsPath, log);

  context.subscriptions.push(
    outputChannel,
    { dispose: () => void worker.dispose() },
    vscode.window.registerCustomEditorProvider(
      DwgEditorProvider.viewType,
      new DwgEditorProvider(context, worker),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  registerCompareCommands(context, worker);
}

export function deactivate() {}
