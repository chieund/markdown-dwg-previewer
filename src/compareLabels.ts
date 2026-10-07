import * as path from 'path';

/** Short names for the two sides of a comparison, unambiguous but no longer than needed. */
export function compareLabels(oldPath: string, newPath: string, revision?: string): { oldLabel: string; newLabel: string } {
  const oldName = path.basename(oldPath);
  const newName = path.basename(newPath);
  if (revision) return { oldLabel: `${oldName} (${revision})`, newLabel: newName };
  if (oldName !== newName) return { oldLabel: oldName, newLabel: newName };
  const withFolder = (p: string) => `${path.basename(path.dirname(p))}/${path.basename(p)}`;
  return { oldLabel: withFolder(oldPath), newLabel: withFolder(newPath) };
}

const LFS_POINTER = 'version https://git-lfs.github.com/spec';

/**
 * Why bytes read from HEAD are not a drawing, if they are not. An empty read is
 * what Git returns for a path missing from HEAD (new, renamed, untracked); CAD
 * repositories often keep drawings in Git LFS, where HEAD holds a pointer.
 */
export function headContentProblem(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return 'the file is not in HEAD — it may be new, renamed or untracked.';
  const head = Buffer.from(bytes.subarray(0, LFS_POINTER.length)).toString('latin1');
  if (head === LFS_POINTER) {
    return 'the drawing is stored in Git LFS, so HEAD holds only a pointer to it. Compare with a checked-out copy of the old version instead (Compare with File…).';
  }
  return undefined;
}
