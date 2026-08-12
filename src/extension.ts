import * as vscode from 'vscode';
import { DwgEditorProvider } from './dwgEditorProvider';
import { setConverterLogger } from './dwg/converter';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('DWG Previewer');
  setConverterLogger((msg) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`));

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerCustomEditorProvider(
      DwgEditorProvider.viewType,
      new DwgEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
