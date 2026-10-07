import * as vscode from 'vscode';
import { compareLabels, headContentProblem } from './compareLabels';
import { diffDrawings } from './diff/diffDrawings';
import type { DrawingWorker } from './dwg/workerClient';
import { webviewHtml } from './webviewHtml';

/** One side of a comparison: its bytes, where they came from, and how to name it. */
interface Side {
  bytes: Uint8Array;
  path: string;
}

/** The slice of the built-in Git extension's API (git.d.ts, version 1) used here. */
interface GitRepository {
  rootUri: vscode.Uri;
  buffer(ref: string, path: string): Promise<Uint8Array>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

const DRAWING = /\.(dwg|dxf)$/i;

export function registerCompareCommands(context: vscode.ExtensionContext, worker: DrawingWorker): void {
  const open = (before: Side, after: Side, revision?: string) =>
    openComparison(context, worker, before, after, revision);

  context.subscriptions.push(
    vscode.commands.registerCommand('dwgPreviewer.compareWithHead', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri) return void vscode.window.showErrorMessage('Open or select a DWG / DXF drawing to compare.');
      try {
        const head = await readFromHead(uri);
        await open({ bytes: head, path: uri.fsPath }, { bytes: await vscode.workspace.fs.readFile(uri), path: uri.fsPath }, 'HEAD');
      } catch (err) {
        void vscode.window.showErrorMessage(`Cannot compare with HEAD: ${describe(err)}`);
      }
    }),

    vscode.commands.registerCommand('dwgPreviewer.compareWithFile', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri) return void vscode.window.showErrorMessage('Open or select a DWG / DXF drawing to compare.');
      const [other] =
        (await vscode.window.showOpenDialog({
          title: `Compare ${uri.path.split('/').pop()} with…`,
          canSelectMany: false,
          filters: { Drawings: ['dwg', 'dxf'] },
          defaultUri: vscode.Uri.joinPath(uri, '..'),
        })) ?? [];
      if (!other) return;
      await openFiles(open, other, uri);
    }),

    // Explorer, two drawings selected: the first selected is treated as the older one
    vscode.commands.registerCommand('dwgPreviewer.compareSelected', async (_clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      if (!selected || selected.length !== 2 || !selected.every((uri) => DRAWING.test(uri.path))) {
        return void vscode.window.showErrorMessage('Select exactly two DWG / DXF drawings to compare.');
      }
      await openFiles(open, selected[0], selected[1]);
    })
  );
}

async function openFiles(
  open: (before: Side, after: Side) => Promise<void>,
  before: vscode.Uri,
  after: vscode.Uri
): Promise<void> {
  try {
    const [oldBytes, newBytes] = await Promise.all([vscode.workspace.fs.readFile(before), vscode.workspace.fs.readFile(after)]);
    await open({ bytes: oldBytes, path: before.fsPath }, { bytes: newBytes, path: after.fsPath });
  } catch (err) {
    void vscode.window.showErrorMessage(`Cannot compare: ${describe(err)}`);
  }
}

/**
 * The drawing a command was invoked on: Explorer item, Source Control entry,
 * or the active editor tab. A `git:` resource (the old side of a diff editor)
 * stands for a revision of a working file — the file is what gets compared,
 * or HEAD would be compared with itself.
 */
function targetUri(arg: unknown): vscode.Uri | undefined {
  let uri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) uri = arg;
  else if ((arg as { resourceUri?: unknown } | undefined)?.resourceUri instanceof vscode.Uri) {
    uri = (arg as { resourceUri: vscode.Uri }).resourceUri;
  } else {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) uri = input.uri;
  }
  if (uri?.scheme === 'git') {
    try {
      uri = vscode.Uri.file((JSON.parse(uri.query) as { path: string }).path);
    } catch {
      return undefined;
    }
  }
  return uri && uri.scheme === 'file' && DRAWING.test(uri.path) ? uri : undefined;
}

/**
 * The committed version of a file, through the built-in Git extension. Running
 * `git` ourselves would let a cloned repository's config run programs; the Git
 * extension already deals with that and with workspace trust.
 */
async function readFromHead(uri: vscode.Uri): Promise<Uint8Array> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!extension) throw new Error('the built-in Git extension is not available.');
  const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
  const repository = git.getRepository(uri);
  if (!repository) throw new Error('the file is not inside a Git repository.');
  let bytes: Uint8Array;
  try {
    bytes = await repository.buffer('HEAD', uri.fsPath);
  } catch {
    bytes = new Uint8Array();
  }
  const problem = headContentProblem(bytes);
  if (problem) throw new Error(problem);
  return bytes;
}

async function openComparison(
  context: vscode.ExtensionContext,
  worker: DrawingWorker,
  before: Side,
  after: Side,
  revision?: string
): Promise<void> {
  const { oldLabel, newLabel } = compareLabels(before.path, after.path, revision);
  const panel = vscode.window.createWebviewPanel('dwgPreviewer.diff', `${oldLabel} ↔ ${newLabel}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
  });
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri);

  let disposed = false;
  panel.onDidDispose(() => (disposed = true));
  const post = (message: unknown) => {
    if (!disposed) void panel.webview.postMessage(message);
  };

  /** A webview reload sends READY again; only the latest run may post. */
  let generation = 0;
  const subscription = panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type !== 'READY') return;
    const run = ++generation;
    const postLatest = (reply: unknown) => {
      if (run === generation) post(reply);
    };
    const converterPath = vscode.workspace.getConfiguration('dwgPreviewer').get<string>('converterPath', '');
    const read = async (side: Side, label: string) => {
      try {
        return await worker.run(side.bytes, side.path, converterPath, (stage) => postLatest({ type: 'DXF_PROGRESS', stage }));
      } catch (err) {
        throw new Error(`${label}: ${describe(err)}`);
      }
    };
    try {
      // One worker thread: the two sides are read one after the other either way
      const oldDrawing = await read(before, oldLabel);
      const newDrawing = await read(after, newLabel);
      postLatest({ type: 'DIFF_DATA', diff: diffDrawings(oldDrawing, newDrawing, oldLabel, newLabel) });
    } catch (err) {
      postLatest({ type: 'DXF_ERROR', message: describe(err) });
    }
  });
  panel.onDidDispose(() => subscription.dispose());
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
