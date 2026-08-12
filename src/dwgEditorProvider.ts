import * as vscode from 'vscode';
import * as path from 'path';
import { convertDwgToDxf } from './dwg/converter';
import { parseDxf } from './dxf/parseDxf';

export class DwgEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'dwgPreviewer.dwgView';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const sendContent = async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        const dwgBuffer = Buffer.from(bytes);

        // Convert DWG → DXF text
        const converterPath = vscode.workspace
          .getConfiguration('dwgPreviewer')
          .get<string>('converterPath', '');

        const dxfText = await convertDwgToDxf(dwgBuffer, document.uri.fsPath, converterPath);
        const parsed = parseDxf(dxfText);
        webviewPanel.webview.postMessage({ type: 'DXF_DATA', ...parsed });
      } catch (err) {
        webviewPanel.webview.postMessage({
          type: 'DXF_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    webviewPanel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'READY') {
        void sendContent();
      } else if (message?.type === 'EXPORT') {
        void this.saveExport(document.uri, message.format, message.data);
      } else if (message?.type === 'EXPORT_FAILED') {
        void vscode.window.showErrorMessage(`Export failed: ${message.message}`);
      }
    });

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        path.basename(document.uri.fsPath)
      )
    );
    watcher.onDidChange(() => void sendContent());
    webviewPanel.onDidDispose(() => watcher.dispose());
  }

  private async saveExport(source: vscode.Uri, format: 'svg' | 'png', data: string): Promise<void> {
    const suggestedName = `${path.basename(source.fsPath, path.extname(source.fsPath))}.${format}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(source.with({ path: path.dirname(source.path) }), suggestedName),
      filters: { [format.toUpperCase()]: [format] },
    });
    if (!target) return;

    try {
      const bytes = format === 'svg' ? Buffer.from(data, 'utf-8') : Buffer.from(data, 'base64');
      await vscode.workspace.fs.writeFile(target, bytes);
      void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to write file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline'; img-src data:;" />
  <style>
    :root {
      --dwg-surface: var(--vscode-editorWidget-background, #252526);
      --dwg-border: var(--vscode-editorWidget-border, #5a5a5a);
      --dwg-divider: var(--vscode-panel-border, #3c3c3c);
      --dwg-text: var(--vscode-foreground, #cccccc);
      --dwg-muted: var(--vscode-descriptionForeground, #9d9d9d);
      --dwg-control: var(--vscode-button-secondaryBackground, #3c3c3c);
      --dwg-control-text: var(--vscode-button-secondaryForeground, #cccccc);
      --dwg-control-hover: var(--vscode-button-secondaryHoverBackground, #4a4a4a);
      --dwg-row-hover: var(--vscode-list-hoverBackground, #2d2d30);
      --dwg-focus: var(--vscode-focusBorder, #0098ff);
      --dwg-warning: var(--vscode-editorWarning-foreground, #cca700);
      --dwg-error: var(--vscode-errorForeground, #f48771);
      --dwg-canvas: #1e1e1e;
    }

    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--dwg-canvas); }
    #root { display: flex; flex-direction: column; width: 100%; height: 100%; }

    .dwg-toolbar {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px; flex: 0 0 auto;
      background: var(--dwg-surface); border-bottom: 1px solid var(--dwg-divider);
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px; color: var(--dwg-text);
    }
    .dwg-toolbar > *:not(.dwg-banner) { flex: 0 0 auto; }

    .dwg-page-select {
      background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #cccccc);
      border: 1px solid var(--vscode-dropdown-border, #5a5a5a); border-radius: 2px; padding: 2px 4px;
      font: inherit; max-width: 14em;
    }

    .dwg-layers { position: relative; }
    .dwg-layer-button, .dwg-layer-action, .dwg-export-button {
      background: var(--dwg-control); color: var(--dwg-control-text);
      border: 1px solid var(--dwg-border); border-radius: 2px;
      cursor: pointer; font: inherit; white-space: nowrap;
    }
    .dwg-layer-button { padding: 3px 8px; }
    .dwg-layer-action { flex: 1; padding: 2px 6px; font-size: 11px; }
    .dwg-export-button { padding: 3px 8px; font-size: 11px; }
    .dwg-layer-button:hover, .dwg-layer-action:hover, .dwg-export-button:hover { background: var(--dwg-control-hover); }

    .dwg-layer-button:focus-visible,
    .dwg-layer-action:focus-visible,
    .dwg-export-button:focus-visible,
    .dwg-banner-dismiss:focus-visible,
    .dwg-page-select:focus-visible,
    .dwg-layer-row input:focus-visible {
      outline: 1px solid var(--dwg-focus);
      outline-offset: 1px;
    }

    .dwg-layer-panel {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
      min-width: 220px; max-height: 60vh; overflow-y: auto;
      background: var(--dwg-surface); border: 1px solid var(--dwg-border); border-radius: 3px;
      box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5)); padding: 4px;
    }
    .dwg-layer-actions { display: flex; gap: 4px; padding: 2px 2px 6px; border-bottom: 1px solid var(--dwg-divider); margin-bottom: 4px; }
    .dwg-layer-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; cursor: pointer; border-radius: 2px; }
    .dwg-layer-row:hover { background: var(--dwg-row-hover); }
    .dwg-layer-swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; border: 1px solid #00000060; }
    .dwg-layer-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-layer-count { flex: 0 0 auto; color: var(--dwg-muted); font-size: 11px; }

    .dwg-export { display: flex; gap: 4px; }

    .dwg-banner {
      display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto;
      color: var(--dwg-warning);
    }
    .dwg-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-banner-dismiss {
      flex: 0 0 auto; background: none; border: none; color: inherit;
      cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
    }

    .dwg-canvas { flex: 1 1 auto; overflow: hidden; background: var(--dwg-canvas); }
    .dwg-error { color: var(--dwg-error); padding: 16px; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; margin: 0; }
    .dwg-loading {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      width: 100%; height: 100%; color: var(--dwg-text);
      font-family: var(--vscode-font-family, sans-serif); font-size: 14px;
    }
    .dwg-spinner {
      width: 24px; height: 24px; border: 3px solid var(--dwg-control);
      border-top-color: var(--vscode-progressBar-background, #0098ff); border-radius: 50%;
      animation: dwg-spin 0.8s linear infinite;
    }
    @keyframes dwg-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .dwg-spinner { animation-duration: 3s; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
