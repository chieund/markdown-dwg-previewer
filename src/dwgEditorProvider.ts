import * as vscode from 'vscode';
import * as path from 'path';
import { webviewHtml } from './webviewHtml';
import { LruCache, debounce } from './dwg/cache';
import type { DrawingWorker } from './dwg/workerClient';
import type { ParsedDxf } from './shared/types';

/** Parsed results keyed by file path, valid while the file's mtime is unchanged. */
interface CacheEntry {
  mtime: number;
  parsed: ParsedDxf;
}

/** A few recent drawings, so reopening a tab is instant without keeping every drawing ever opened. */
const parseCache = new LruCache<string, CacheEntry>(4);

/**
 * Conversions under way, so two panels on one file share the work, each still
 * hearing about progress. Keyed by path + mtime.
 */
const inFlight = new Map<string, { result: Promise<ParsedDxf>; listeners: Set<Progress> }>();

/** CAD software writes a file in several steps; wait for it to settle before re-reading. */
const RELOAD_DEBOUNCE_MS = 300;

type Progress = (stage: 'reading' | 'converting' | 'parsing') => void;

async function loadDrawing(
  worker: DrawingWorker,
  uri: vscode.Uri,
  mtime: number,
  progress: Progress
): Promise<ParsedDxf> {
  const filePath = uri.fsPath;
  const cached = parseCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.parsed;

  const key = `${filePath}\0${mtime}`;
  let pending = inFlight.get(key);
  if (pending) {
    pending.listeners.add(progress);
  } else {
    const listeners = new Set<Progress>([progress]);
    const result = convertAndParse(worker, uri, (stage) => listeners.forEach((listener) => listener(stage))).then(
      (parsed) => {
        parseCache.set(filePath, { mtime, parsed });
        return parsed;
      }
    );
    result.finally(() => inFlight.delete(key)).catch(() => {});
    pending = { result, listeners };
    inFlight.set(key, pending);
  }
  try {
    return await pending.result;
  } finally {
    pending.listeners.delete(progress);
  }
}

async function convertAndParse(worker: DrawingWorker, uri: vscode.Uri, progress: Progress): Promise<ParsedDxf> {
  progress('reading');
  const bytes = await vscode.workspace.fs.readFile(uri);
  const converterPath = vscode.workspace.getConfiguration('dwgPreviewer').get<string>('converterPath', '');
  // Conversion and parsing run on a worker thread, off the extension host's.
  return worker.run(bytes, uri.fsPath, converterPath, progress);
}

export class DwgEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'dwgPreviewer.dwgView';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly worker: DrawingWorker
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

    /** Bumped per load; a slower, older load must not overwrite a newer one. */
    let generation = 0;
    let disposed = false;

    const post = (run: number, message: unknown) => {
      if (!disposed && run === generation) void webviewPanel.webview.postMessage(message);
    };

    const sendContent = async () => {
      const run = ++generation;
      try {
        const stat = await vscode.workspace.fs.stat(document.uri);
        const parsed = await loadDrawing(this.worker, document.uri, stat.mtime, (stage) =>
          post(run, { type: 'DXF_PROGRESS', stage })
        );
        post(run, { type: 'DXF_DATA', ...parsed });
      } catch (err) {
        post(run, {
          type: 'DXF_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const reload = debounce(() => void sendContent(), RELOAD_DEBOUNCE_MS);

    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(
      webviewPanel.webview.onDidReceiveMessage((message) => {
        if (message?.type === 'READY') {
          void sendContent();
        } else if (message?.type === 'EXPORT') {
          if ((message.format === 'svg' || message.format === 'png') && typeof message.data === 'string') {
            void this.saveExport(document.uri, message.format, message.data);
          }
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
      watcher.onDidDelete(() => parseCache.delete(document.uri.fsPath))
    );

    webviewPanel.onDidDispose(() => {
      disposed = true;
      reload.cancel();
      for (const subscription of subscriptions) subscription.dispose();
    });
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
}
