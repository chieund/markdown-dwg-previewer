/**
 * Real names behind the anonymous block names dynamic blocks are inserted by.
 *
 * AutoCAD does not insert `Door-900` directly. It inserts an anonymous record
 * named `*B24` — a representation whose visibility states depend on a parameter
 * — and points at the original block through xdata `AcDbBlockRepBTag`. Without
 * this mapping every door in a drawing is listed under a different `*B…`
 * number, which is useless for a takeoff and unstable for a diff: renumbering
 * them after an edit turns every door into "removed + added".
 *
 * The records live in the BLOCK_RECORD table of the TABLES section, which
 * dxf-parser does not read, so they are scanned from the raw text like the
 * other facts it drops.
 */

/** Xdata app name AutoCAD writes the representation handle under. */
const BLOCK_REP_TAG = 'AcDbBlockRepBTag';

interface BlockRecord {
  handle: string;
  name: string;
  /** Handle of the block this record is a representation of, when it is one. */
  represented?: string;
}

/**
 * Maps block name → the name it stands for, for anonymous blocks only.
 *
 * Returns an empty map for the many drawings that use no dynamic blocks, which
 * is why the scan is skipped outright when the tag is nowhere in the file.
 */
export function scanBlockNames(text: string): Record<string, string> {
  if (!text.includes(BLOCK_REP_TAG)) return {};

  const lines = text.split(/\r\n|\r|\n/);
  const records: BlockRecord[] = [];
  /** Handle of every block record, so a representation tag can be resolved. */
  const nameByHandle = new Map<string, string>();

  let section: string | null = null;
  let inBlockRecords = false;
  let handle: string | null = null;
  let name: string | null = null;
  let represented: string | undefined;
  /** True straight after `1001 AcDbBlockRepBTag`, where the handle follows. */
  let expectsHandle = false;

  const finish = () => {
    if (handle && name) {
      records.push({ handle, name, represented });
      nameByHandle.set(handle, name);
    }
    handle = null;
    name = null;
    represented = undefined;
    expectsHandle = false;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '0') {
      if (value === 'SECTION') {
        section = lines[i + 3]?.trim() ?? null;
        continue;
      }
      if (value === 'ENDSEC') {
        if (inBlockRecords) finish();
        inBlockRecords = false;
        section = null;
        continue;
      }
      if (inBlockRecords) finish();
      // Only the BLOCK_RECORD table is of interest; the other tables hold
      // handles and names of a completely different kind.
      inBlockRecords = section === 'TABLES' && value === 'BLOCK_RECORD';
      continue;
    }

    if (!inBlockRecords) continue;
    // 5 is the record's own handle; 1005 belongs to an xdata value.
    if (code === '5') handle = value;
    else if (code === '2') name = value;
    else if (code === '1001' && value === BLOCK_REP_TAG) expectsHandle = true;
    else if (code === '1005' && expectsHandle) {
      represented = value;
      expectsHandle = false;
    }
  }
  if (inBlockRecords) finish();

  const resolved: Record<string, string> = {};
  for (const record of records) {
    if (!record.represented) continue;
    // Only a record that really resolves earns a name: a dangling handle would
    // otherwise list every door under a bare handle number.
    const original = nameByHandle.get(record.represented);
    if (original && original !== record.name) resolved[record.name] = original;
  }
  return resolved;
}