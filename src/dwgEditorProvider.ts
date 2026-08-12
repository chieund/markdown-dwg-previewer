import * as vscode from 'vscode';
import * as path from 'path';
import { convertDwgToDxf } from './dwg/converter';
import { describeUnreadableFormat, detectDrawingFormat } from './dwg/format';
import { WEBVIEW_STYLES } from './webview/styles';
import { parseDxf } from './dxf/parseDxf';

/** Cache parsed results keyed by file path + mtime to avoid re-converting unchanged files. */
interface CacheEntry {
  mtime: number;
  parsed: ReturnType<typeof parseDxf>;
}
const parseCache = new Map<string, CacheEntry>();

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
        const filePath = document.uri.fsPath;
        const stat = await vscode.workspace.fs.stat(document.uri);
        const mtime = stat.mtime;

        // Check cache — skip expensive conversion if file hasn't changed
        const cached = parseCache.get(filePath);
        if (cached && cached.mtime === mtime) {
          webviewPanel.webview.postMessage({ type: 'DXF_DATA', ...cached.parsed });
          return;
        }

        webviewPanel.webview.postMessage({ type: 'DXF_PROGRESS', stage: 'reading' });
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        const buffer = Buffer.from(bytes);

        // DXF is this extension's own intermediate format, so a DXF file skips
        // conversion entirely and goes straight to the parser.
        const format = detectDrawingFormat(buffer);
        let dxfText: string;

        if (format === 'dxf-text') {
          dxfText = buffer.toString('utf-8');
        } else if (format === 'dwg') {
          webviewPanel.webview.postMessage({ type: 'DXF_PROGRESS', stage: 'converting' });
          const converterPath = vscode.workspace
            .getConfiguration('dwgPreviewer')
            .get<string>('converterPath', '');

          dxfText = await convertDwgToDxf(buffer, document.uri.fsPath, converterPath);
        } else {
          throw new Error(describeUnreadableFormat(format, path.basename(filePath)));
        }

        webviewPanel.webview.postMessage({ type: 'DXF_PROGRESS', stage: 'parsing' });
        const parsed = parseDxf(dxfText);

        // Store in cache
        parseCache.set(filePath, { mtime, parsed });

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
  <style>${WEBVIEW_STYLES}</style>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
