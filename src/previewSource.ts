/**
 * Where a preview reads its drawing from.
 *
 * - `file`: the real path on disk, shared with the AI side (store, bridge, disk cache), so a symlink matches.
 * - `memory`: anything else (the `git:` old side of a Source Control diff, `vscode-vfs:`, …). Its `fsPath`
 *   is not the bytes it stands for — for `git:` it is the working-tree file — so it is read through
 *   `vscode.workspace.fs`, kept in memory only under the full uri, and never offered to an agent.
 */
export type PreviewSource = { kind: 'file'; path: string } | { kind: 'memory'; key: string };

export interface UriLike {
  scheme: string;
  fsPath: string;
  toString(): string;
}

export function previewSource(uri: UriLike, realPath: (p: string) => string): PreviewSource {
  if (uri.scheme === 'file') return { kind: 'file', path: realPath(uri.fsPath) };
  return { kind: 'memory', key: uri.toString() };
}
