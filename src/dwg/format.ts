/**
 * Tells DWG, text DXF and binary DXF apart from the file's own bytes.
 *
 * The file extension is not trusted: drawings get renamed, and a `.dxf` holding
 * a DWG (or the reverse) would otherwise fail deep inside the parser with a
 * message that says nothing useful. Sniffing the header lets the editor pick the
 * right path, and lets it explain itself when it cannot open a file at all.
 */
export type DrawingFormat = 'dwg' | 'dxf-text' | 'dxf-binary' | 'unknown';

/** Every DWG release stamps `AC10xx` into the first six bytes. */
const DWG_MAGIC = /^AC10\d{2}/;

/** Binary DXF opens with this sentinel, followed by CR LF SUB NUL. */
const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF';

/** Enough to cover a leading BOM plus a few 999 comment blocks. */
const SNIFF_BYTES = 4096;

export function detectDrawingFormat(buffer: Buffer): DrawingFormat {
  if (buffer.length < 2) return 'unknown';

  const head = buffer.subarray(0, SNIFF_BYTES).toString('latin1');

  if (DWG_MAGIC.test(head)) return 'dwg';
  if (head.startsWith(BINARY_DXF_SENTINEL)) return 'dxf-binary';
  if (looksLikeTextDxf(head)) return 'dxf-text';

  return 'unknown';
}

/**
 * A text DXF is a stream of group-code/value line pairs opening with `0`
 * / `SECTION`. Files may lead with a byte-order mark and with `999` comment
 * pairs, both of which are skipped here.
 */
function looksLikeTextDxf(head: string): boolean {
  const lines = head.replace(/^﻿|^\xEF\xBB\xBF/, '').split(/\r\n|\r|\n/);

  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  // Skip comment pairs, which are the one thing allowed before the first section
  while (i + 1 < lines.length && lines[i].trim() === '999') i += 2;

  return lines[i]?.trim() === '0' && lines[i + 1]?.trim().toUpperCase() === 'SECTION';
}

/** Message shown when a file cannot be routed to either reader. */
export function describeUnreadableFormat(format: DrawingFormat, fileName: string): string {
  if (format === 'dxf-binary') {
    return (
      `"${fileName}" is a binary DXF, which this extension cannot read yet.\n\n` +
      'Re-save it from your CAD application as an ASCII DXF, or as a DWG, and it will open.'
    );
  }
  return (
    `"${fileName}" is not a DWG or DXF drawing.\n\n` +
    'The file header matches neither format — it may be corrupted, or it may be a ' +
    'different file type that was given a drawing extension.'
  );
}
