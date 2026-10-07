# Visual diff for DWG / DXF — design

Date: 2026-10-07 · Status: approved to build (owner asked to proceed without review stops; decisions below are the implementer's, open to change)

## Goal

When a drawing changes — in Git or between two files — show *what* changed on the drawing itself:
added geometry in green, removed in red, changed objects in yellow over their old shape, everything
else faded. Today VS Code can only say "binary file changed".

Success: on a drawing where a door was moved, a room label edited and a wall deleted, the diff view
shows exactly those three objects, lists them, and zooms to each from the list.

## Entry points

| Command | Where | Compares |
|---|---|---|
| **DWG: Compare with HEAD** | Explorer / editor title context menu on `.dwg` `.dxf`; Source Control changes list | working file ↔ the version in `HEAD` |
| **DWG: Compare with File…** | Explorer / editor title context menu | this file ↔ a file picked in a dialog |
| **DWG: Compare Selected** | Explorer, two drawings selected | first ↔ second (older ↔ newer by selection order) |

The `HEAD` version is read through the built-in Git extension's API (`repository.buffer(ref, path)`),
not by running `git` ourselves: a repository's config can make `git` run arbitrary programs, and the
Git extension already handles workspace trust. No Git extension, no repository, the file not in
`HEAD` (an empty read) or a Git LFS pointer → a clear error message. Invoked on a `git:` resource
(the old side of a diff editor), the working file behind it is compared.

## Matching objects

Diff works on top-level objects (`ParsedDxf.objects`, the same unit as search and the inspector), page
by page; pages are paired by name (Model Space ↔ Model Space, Paper Space 2 ↔ Paper Space 2). A page
only on one side is entirely added / removed.

1. **By handle.** AutoCAD keeps an entity's handle across saves. Same handle *and type* on both
   sides → compare signatures: equal = unchanged, different = **changed**. Handle only in the new
   file = **added**, only in the old = **removed**. Only handles read from the file count —
   dxf-parser invents numeric ones for R12 entities, and those would pair objects by position.
   If more than half of a page's handle pairs (≥ 4 pairs) differ, the writer probably renumbered
   handles sequentially after a deletion; that page is matched by content instead.
2. **By signature, when handles don't line up.** Some writers renumber every handle on save, and R12
   files have none. If fewer than half of the objects with handles share a handle with the other
   side, handles are ignored for the page: objects are matched by signature as a multiset — equal
   signatures pair up as unchanged, leftovers are added / removed. This mode cannot report
   "changed"; a moved door shows as removed + added, which is still correct.

**Signature** of an object = its type, layer, block name, text, attributes, and the geometry of every
entity drawn for it, sorted (so re-ordering a block's pieces is not a change), with numbers snapped to
an absolute grid of one billionth of the drawing's size (so float noise like `-1.42e-14` is not a
change, while a 1 mm move at survey coordinates in the millions still is). Entities that belong to
no object become objects of their own. Viewport content is not compared — the model page already
covers it — but the newer side's viewports are drawn, greyed, as context.

## View

A webview panel titled `plan.dwg (HEAD) ↔ plan.dwg`. Reuses the existing renderer, pan/zoom and
status bar.

- Draw order: unchanged (faded grey) → removed (red) → old shape of changed (red, faded, dashed) →
  new shape of changed (yellow) → added (green).
- Toolbar: page selector (pages with changes show a count), toggles **Added / Removed / Changed /
  Unchanged** each with its count, **Changes** dropdown listing every changed object
  (e.g. `Changed · TEXT "LIVING ROOM" → "LOUNGE"`), ◀ ▶ to step through them, Fit.
- Picking a change zooms to it (union of old and new bounds) and highlights it.
- "No differences" state when nothing changed on any page.

## Architecture

```
extension host                                      webview (same bundle, diff mode)
──────────────                                      ────────────────────────────────
commands.ts ── reads both versions (fs / Git API)   diffView.ts
   │                                                  ├─ toolbar: pages, toggles, changes list
   ├─ DrawingWorker.run(old), .run(new)  (worker)     ├─ renders categories with status colours
   ├─ diffDrawings(old, new)   ← src/diff/ (pure)     └─ zoom to change, highlight
   └─ DiffPanel: webview + postMessage(DIFF_DATA) ──►
```

- `src/diff/signature.ts` — object signatures.
- `src/diff/diffDrawings.ts` — pairing pages, matching, building `DrawingDiff` (pure, unit-tested).
- `src/diffPanel.ts` — the webview panel (host side).
- `src/compareCommands.ts` — the three commands and reading the `HEAD` version.
- `src/webview/diffView.ts` — rendering and controls; `main.ts` routes `DIFF_DATA` to it.

Wire format (`src/shared/types.ts`):

```ts
type ChangeKind = 'added' | 'removed' | 'changed';
interface DiffPage {
  name: string;
  bounds: Bounds | null;
  unchanged: DxfEntity[]; added: DxfEntity[]; removed: DxfEntity[];
  changedOld: DxfEntity[]; changedNew: DxfEntity[];
  changes: { kind: ChangeKind; label: string; bounds: Bounds | null }[];
}
interface DrawingDiff { oldLabel: string; newLabel: string; pages: DiffPage[]; handleMatching: boolean }
```

## Error handling

- Either side fails to convert/parse → panel shows which side and why (same messages as the viewer).
- Entity limit reached on either side → the diff runs on what was read and says so.

## Testing

- `diffDrawings`: unchanged / added / removed / changed by handle; float noise is not a change;
  attribute edit is a change; renumbered handles fall back to signatures; pages paired by name,
  one-sided pages; change labels and bounds.
- Real files: a script derives a modified copy of a corpus drawing (delete, move, edit text, add) and
  the preview harness renders the diff (`--diff=<other file>`).
- Manual in VS Code: commands from Explorer and Source Control.

## Out of scope

Side-by-side synchronized panes; diffing against arbitrary commits (only `HEAD`); three-way merge;
editing.
