import * as vscode from 'vscode';
import { DwgEditorProvider } from './dwgEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      DwgEditorProvider.viewType,
      new DwgEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
