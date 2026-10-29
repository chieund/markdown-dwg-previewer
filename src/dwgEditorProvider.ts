import * as vscode from 'vscode';
import * as path from 'path';
import { webviewHtml } from './webviewHtml';
import { debounce } from './dwg/cache';
import * as fs from 'fs';
import type { DrawingStore } from './ai/drawingStore';
import type { PreviewBridge } from './ai/previewBridge';
import type { DrawingKey } from './shared/types';
import { previewSource } from './previewSource';

/** CAD software writes a file in several steps; wait for it to settle before re-reading. */
const RELOAD_DEBOUNCE_MS = 300;

export class DwgEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'dwgPreviewer.dwgView';

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Drawings on disk (`file:`), shared with the AI side. */
    private readonly store: DrawingStore,
    /** Any other scheme: read through `vscode.workspace.fs`, memory only, never disk-cached. */
    private readonly memoryStore: DrawingStore,
    private readonly bridge?: PreviewBridge
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = webviewHtml(webviewPanel.webview, this.context.extensionUri);

    const source = previewSource(document.uri, realPath);
    /** `file:` — one canonical path for the store, the bridge and the agent's keys, so a symlink matches. */
    const key = source.kind === 'file' ? source.path : source.key;
    const store = source.kind === 'file' ? this.store : this.memoryStore;
    /** Only a drawing on disk is offered to an agent; a `git:` revision or a virtual file is not. */
    const bridge = source.kind === 'file' ? this.bridge : undefined;
    /** Bumped per load; a slower, older load must not overwrite a newer one. */
    let generation = 0;
    let disposed = false;
    /** The version of the drawing this panel was last sent; what the agent's ids refer to. */
    let lastKey: DrawingKey | undefined;
    const registration = bridge?.register(
      key,
      {
        postMessage: (m) => webviewPanel.webview.postMessage(m),
        reveal: () => webviewPanel.reveal(undefined, true),
        get active() {
          return webviewPanel.active;
        },
        get visible() {
          return webviewPanel.visible;
        },
      },
      () => lastKey);

    const post = (run: number, message: unknown) => {
      if (!disposed && run === generation) void webviewPanel.webview.postMessage(message);
    };

    const sendContent = async () => {
      const run = ++generation;
      try {
        const { key: drawingKey, parsed } = await store.get(key, {
          progress: (stage) => post(run, { type: 'DXF_PROGRESS', stage }),
        });
        post(run, { type: 'DXF_DATA', key: drawingKey, ...parsed });
        if (!disposed && run === generation) {
          lastKey = drawingKey;
          registration?.loaded();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!disposed && run === generation) registration?.failed(message);
        post(run, { type: 'DXF_ERROR', message });
      }
    };

    const reload = debounce(() => void sendContent(), RELOAD_DEBOUNCE_MS);

    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(
      webviewPanel.webview.onDidReceiveMessage((message) => {
        if (message?.type === 'READY') {
          void sendContent();
        } else if (message?.type === 'AGENT_RESULT') {
          bridge?.receive(message);
        } else if (message?.type === 'EXPORT') {
          if ((message.format === 'svg' || message.format === 'png' || message.format === 'csv') && typeof message.data === 'string') {
            void this.saveExport(document.uri, message.format, message.data);
          }
        } else if (message?.type === 'COPY') {
          // A webview can be denied clipboard access; the host is not.
          if (typeof message.text === 'string') void vscode.env.clipboard.writeText(message.text);
        } else if (message?.type === 'EXPORT_FAILED') {
          void vscode.window.showErrorMessage(`Export failed: ${String(message.message)}`);
        }
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        path.basename(document.uri.fsPath)
      )
    );
    subscriptions.push(
      watcher,
      watcher.onDidChange(() => reload()),
      watcher.onDidCreate(() => reload()),
      watcher.onDidDelete(() => store.forget(key))
    );

    webviewPanel.onDidDispose(() => {
      disposed = true;
      registration?.dispose();
      reload.cancel();
      for (const subscription of subscriptions) subscription.dispose();
    });
  }

  private async saveExport(source: vscode.Uri, format: 'svg' | 'png' | 'csv', data: string): Promise<void> {
    const suggestedName = `${path.basename(source.fsPath, path.extname(source.fsPath))}.${format}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(source.with({ path: path.dirname(source.path) }), suggestedName),
      filters: { [format.toUpperCase()]: [format] },
    });
    if (!target) return;

    try {
      // PNG arrives base64-encoded from the canvas; text formats are plain.
      const bytes = format === 'png' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8');
      await vscode.workspace.fs.writeFile(target, bytes);
      void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to write file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** The tools match on real paths, so a symlinked workspace still finds its panel. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
