/**
 * Per-entity facts dxf-parser drops, read straight from the DXF text.
 *
 * dxf-parser keeps the extrusion direction for some entity types and not for
 * others (CIRCLE, TEXT), never keeps the text style (group 7), and gives no way
 * to tell where in the file an entity sat. All three are keyed here by the
 * entity handle (group 5), which every R13+ file writes.
 */
export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface EntityExtras {
  /** Position of the entity in the file, for restoring draw order. */
  ordinal: Map<string, number>;
  /** Non-default extrusion directions only. */
  extrusion: Map<string, Vector3D>;
  /** Text style name (group 7). */
  style: Map<string, string>;
  /**
   * Entity types the file draws — in the ENTITIES section or on a layout
   * (`*Paper_Space…` blocks). Ordinary block definitions are left out: a block
   * library the drawing never inserts is not something missing from the view.
   */
  types: Set<string>;
}

export function scanEntityExtras(text: string): EntityExtras {
  const lines = text.split(/\r\n|\r|\n/);
  const extras: EntityExtras = { ordinal: new Map(), extrusion: new Map(), style: new Map(), types: new Set() };

  let section: string | null = null;
  let ordinal = 0;
  /** Inside BLOCKS: whether the block being read is a layout. */
  let inLayout = false;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0') continue;
    const value = lines[i + 1].trim();

    if (value === 'SECTION') {
      section = lines[i + 3]?.trim() ?? null;
      continue;
    }
    if (value === 'ENDSEC') {
      section = null;
      continue;
    }
    if (section !== 'ENTITIES' && section !== 'BLOCKS') continue;

    if (value === 'BLOCK') {
      inLayout = /^\*Paper_Space/i.test(blockName(lines, i + 2));
    } else if (value === 'ENDBLK') {
      inLayout = false;
    } else if (section === 'ENTITIES' || inLayout) {
      extras.types.add(value);
    }

    let handle: string | null = null;
    let style: string | null = null;
    const direction: Vector3D = { x: 0, y: 0, z: 1 };
    let hasDirection = false;

    for (let j = i + 2; j + 1 < lines.length; j += 2) {
      const code = lines[j].trim();
      if (code === '0') break;
      const v = lines[j + 1].trim();
      if (code === '5') handle = v;
      else if (code === '7') style = v;
      else if (code === '210') { direction.x = Number(v); hasDirection = true; }
      else if (code === '220') { direction.y = Number(v); hasDirection = true; }
      else if (code === '230') { direction.z = Number(v); hasDirection = true; }
    }

    ordinal++;
    if (handle === null) continue;
    extras.ordinal.set(handle, ordinal);
    if (style) extras.style.set(handle, style);
    if (hasDirection && (direction.x !== 0 || direction.y !== 0 || direction.z !== 1)) {
      extras.extrusion.set(handle, direction);
    }
  }

  return extras;
}

/** The name (group 2) of the BLOCK record whose groups start at `start`. */
function blockName(lines: string[], start: number): string {
  for (let j = start; j + 1 < lines.length; j += 2) {
    const code = lines[j].trim();
    if (code === '0') break;
    if (code === '2') return lines[j + 1].trim();
  }
  return '';
}
