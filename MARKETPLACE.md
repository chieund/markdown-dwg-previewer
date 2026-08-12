# DWG Previewer — View AutoCAD DWG Files in VS Code

**Open any `.dwg` drawing straight in VS Code. No AutoCAD. No license. No conversion step.**

Someone sends you a DWG file. You don't have AutoCAD — or you do, but launching it just to
glance at a floor plan is absurd. Install this extension, double-click the file, and the
drawing opens in your editor: pan it, zoom it, turn layers on and off, flip between sheets,
export it as an image.

Works fully offline on Windows, macOS and Linux. Your drawings never leave your machine.

---

## Why people install it

**You received a DWG and can't open it.** No AutoCAD license, no trial signup, no sketchy
"free online DWG viewer" that wants you to upload a client's floor plan to a random server.

**Your repository contains CAD files.** Site plans, panel layouts, machine drawings — review
them during a pull request without leaving the editor or asking someone to export a PDF.

**You just need to check one thing.** A dimension, a room label, which layer something sits
on. Ten seconds instead of a five-minute application launch.

**You're a developer working with CAD data.** Inspect the drawings your code parses, right
next to the code that parses them.

---

## What you get

- **Instant preview** — double-click a `.dwg` file, that's the whole workflow
- **Pan and zoom** — scroll to zoom toward the cursor, drag to pan, double-click to fit
- **Layer control** — show or hide any layer, with an entity count for each
- **Multi-sheet drawings** — switch between Model Space and every Paper Space layout
- **Export to SVG or PNG** — drop a drawing into a document, ticket, or chat
- **Live reload** — the view refreshes the moment the file changes on disk
- **Fits your theme** — follows your VS Code colors
- **Fast on big drawings** — a 45,000-entity site plan opens in about two seconds, and
  reopening it is instant

---

## Quick start

1. Install **DWG Previewer**
2. Open a `.dwg` file
3. There is no step 3

Nothing to configure. No converter to install. No account.

---

## FAQ

**Do I need AutoCAD installed?**
No. The DWG reader is built into the extension.

**Which AutoCAD versions are supported?**
R14 through 2020 and later (AC1014 – AC1032).

**Can I edit drawings?**
No — this is a viewer. Your files are opened read-only and are never modified.

**Are my files uploaded anywhere?**
Never. Everything runs locally inside VS Code, and it works with no internet connection.

**Does it work with DXF files?**
Not yet — `.dwg` only for now.

**Is 3D supported?**
This is a 2D viewer. 3D drawings open, but solids are not rendered; 3DFACE geometry appears
as wireframe.

**A drawing looks incomplete — why?**
The toolbar shows a banner naming any entity type it couldn't draw, so you always know when
something is missing rather than quietly getting a partial picture. Please report those
files — that banner is exactly the list of what to add next.

---

## What it can draw

| | |
|---|---|
| **Geometry** | LINE · CIRCLE · ARC · POLYLINE · LWPOLYLINE · SPLINE · ELLIPSE |
| **Fills** | SOLID · HATCH |
| **Text** | TEXT · MTEXT · ATTRIB — with fonts, alignment and rotation |
| **Blocks** | INSERT — nested, rotated, mirrored, scaled, and grid arrays |
| **Dimensions** | DIMENSION — measurement label and line |
| **Other** | POINT · 3DFACE · viewports on paper-space sheets |

Layers keep their colors, linetypes and line weights from the original drawing.

---

## Settings

None required. One optional setting, `dwgPreviewer.converterPath`, lets you point at an
external converter for unusual files — almost nobody needs it.

---

## Found a problem?

Open **View → Output** and select **DWG Previewer** to see exactly what happened during
conversion, then open an issue on the repository with that log and, if you can share it,
the drawing.
