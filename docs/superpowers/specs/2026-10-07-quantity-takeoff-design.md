# Quantity takeoff — design

Date: 2026-10-07 · Status: draft for owner review

## Goal

Give anyone who receives a DWG / DXF the quantities an estimator needs, without AutoCAD: how many of
each block (doors, windows, fixtures), how long the linework on each layer is, and how much area the
closed shapes and hatches cover — then hand those numbers to Excel or an estimating program.

Audience: general Marketplace users; English UI; CSV / tab-separated output that any spreadsheet or
estimating software can take. It is the free equivalent of AutoCAD's `DATAEXTRACTION` / `COUNT`, not a
costing package (no rates, no norms).

Success:
- Opening the panel on a floor plan lists every block with its count — dynamic blocks under their
  real names (`Door-900`, not `*U12`) — and every layer with object count, length and area.
- Lengths and areas are exact for lines, arcs, circles and polylines with bulges; within 0.1 % for
  ellipses, splines and non-uniformly scaled blocks.
- Shift+clicking a few objects shows their combined length and area in the status bar.
- "Copy table" pastes cleanly into Excel; "Export CSV" opens in Excel with correct accents.

## What is measured

The unit is the **object** (`ParsedDxf.objects`): one wall polyline, one door INSERT.

| Shape | Length | Area |
|---|---|---|
| LINE | segment length | — |
| ARC | r × sweep | — |
| CIRCLE | 2πr | πr² |
| LWPOLYLINE / 2D POLYLINE | segments; bulge segments as true arcs; closing segment if closed | if closed: shoelace + circular-segment area per bulge |
| ELLIPSE | sampled | if full: sampled polygon |
| SPLINE | sampled | — |
| SOLID / 3DFACE | perimeter | polygon area |
| HATCH | — | **hatch area** (separate column): even-odd area of its loops (outer minus holes) |
| TEXT, MTEXT, DIMENSION, POINT | — | — |
| INSERT | counted as one block; the geometry it expands to is measured too (under its scale) | likewise |

Geometry is measured in world coordinates after block transforms, in mapEntity where the raw shape
is still available (so bulges and circles are exact). Under a uniform scale lengths scale by *s* and
areas by *s²*; under a non-uniform scale the sampled shape is measured. Viewport collection does not
measure (the model page already counts that geometry, at its true scale).

Hatch area has its own column because a hatch usually fills a closed polyline that is already
counted in "Area"; adding them would count the floor twice.

**Dynamic blocks.** An INSERT of a dynamic block names an anonymous block (`*U12`, `*B24`). Its
real name comes from the `BLOCK_RECORD` table: the anonymous record carries xdata
`1001 AcDbBlockRepBTag` → `1005 <handle>` pointing at the original record. Verified on
`blocks_and_tables_-_imperial.dwg`: 29 of 29 anonymous blocks resolve (`*B24` → `Window`).
`ObjectInfo.block` becomes the effective name — which also fixes the `*B24` names in Find and
the inspector, and keeps visual-diff signatures stable when AutoCAD renumbers anonymous blocks.

**Units.** `$INSUNITS` from the header (1 inch, 2 foot, 4 mm, 5 cm, 6 m, … per the DXF reference);
14 of the 17 corpus drawings declare one. Results show in m / m² for metric drawings and ft / ft² for
imperial ones; a dropdown switches output units. A unitless drawing (`$INSUNITS` 0 or missing) shows
"Drawing units" until the user picks what one unit is.

**Scope.** The page on screen; layers currently hidden are excluded ("what you see is what you
measure"), stated in the panel header.

## User interface

```
[Model Space▾] [Layers 11/11] [Find] [Quantities] [−][+][Fit] [SVG][PNG]
┌─ Quantities · Model Space · visible layers ──── Units: mm → [m ▾] ─┐
│ [Blocks]  Layers                                                    │
│ Block                                    Count                      │
│ Door-900                                    14    ⌖                 │
│ Window                                      22    ⌖                 │
│ …                                                                   │
│                                   [Copy table]  [Export CSV]        │
└─────────────────────────────────────────────────────────────────────┘
Layers tab:  Layer | Objects | Length | Area | Hatch area | ⌖
Status bar with a selection:  3 selected · Length 24.60 m · Area 41.25 m²
```

- **Quantities** toolbar button opens a panel docked on the right (where the inspector sits; one at a
  time). Two tabs: **Blocks** (name, count) and **Layers** (objects, length, area, hatch area).
  Sorted by name; empty columns show "—".
- **⌖** on a row selects those objects with the existing highlight and zooms to them.
- **Shift+click** on the canvas adds / removes an object from the selection; the status bar shows
  the selection's count, length, area and hatch area. A plain click still selects one object and
  opens the inspector; Esc clears.
- The panel updates when layers are toggled or the page changes.
- **Copy table** puts the visible tab on the clipboard as tab-separated text (pastes as cells in
  Excel and estimating tools). **Export CSV** saves the visible tab through the host's save dialog,
  UTF-8 with BOM so Excel reads accents, numbers with `.` decimals and no thousands separators.

## Architecture

```
parser (worker)                                   webview
──────────────                                    ───────
blockNames.ts  BLOCK_RECORD → effective names     takeoff.ts   aggregate(objects, page, hidden) → tables
measure.ts     length/area of raw shapes          units.ts     $INSUNITS → metres, formatting
parseDxf.ts    ObjectInfo += length, area,        table.ts     rows → TSV / CSV text
               hatchArea, block = effective name  takeoffPanel.ts  DOM, tabs, ⌖, copy / export
ParsedDxf.units = $INSUNITS                       main.ts      button, Shift+click, status bar
                                                  host: EXPORT handles format 'csv'
```

- `src/dxf/measure.ts` — pure: `polylineMeasure(vertices with bulge, closed)`, `hatchArea(loops)`,
  `polygonArea`, scaling rules. Called from `mapEntity`, which adds to `context.objects[currentObj]`
  when `context.measuring` is true (off during viewport collection).
- `src/dxf/blockNames.ts` — pure scan of the BLOCK_RECORD table.
- `src/webview/takeoff.ts`, `units.ts`, `table.ts` — pure, unit-tested.
- `src/webview/takeoffPanel.ts` — DOM only.

Wire format additions (`src/shared/types.ts`): `ObjectInfo.length?`, `area?`, `hatchArea?`
(drawing units, omitted when zero); `ParsedDxf.units?: number`.

## Error handling

- No objects on the page → "Nothing to measure on this sheet".
- Unitless drawing → values in drawing units with a prompt to choose units; never guessed silently.
- Clipboard unavailable in the webview → fall back to Export CSV with a message.

## Testing

- measure: line, arc, circle exact; bulge semicircle length πr and area πr²/2; closed polyline with
  a bulge; hatch with a hole; ellipse within 0.1 %.
- parseDxf: an INSERT scaled ×2 doubles length and quadruples area; viewport collection does not
  add; values land on the outermost object; `$INSUNITS` read.
- blockNames: fixture BLOCK_RECORD with AcDbBlockRepBTag; real file `blocks_and_tables_-_imperial`
  counts windows under `Window`.
- takeoff: grouping by effective block name and layer, hidden layers excluded, selection sums.
- units / table: conversion factors, unitless, CSV quoting (commas, quotes, newlines), BOM, TSV.
- Corpus unchanged (entity counts); preview harness renders the panel (`--quantities`).

## Out of scope

Pricing, norms or estimate documents; grouping by attribute values (v2); measuring inside a drawn
polygon / by window selection; 3D quantities; Excel `.xlsx` files (CSV / clipboard cover it without a
dependency).
