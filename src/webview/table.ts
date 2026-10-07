/**
 * Turning a table into text that a spreadsheet or estimating program can read.
 *
 * Two formats, because they serve different hands: the clipboard wants
 * tab-separated values so it pastes straight into Excel cells, and a file
 * wants CSV with the quoting the format requires.
 */

/** Excel writes and expects CRLF, and treats a leading UTF-8 BOM as "not plain ASCII". */
const ROW_ENDING = '\r\n';

/** Byte-order mark, so Excel reads accents in layer and block names correctly. */
export const UTF8_BOM = '\uFEFF';

/** Cells may not carry a tab or a line break; a space keeps the text readable. */
function flatten(cell: string): string {
  return cell.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Tab-separated values, one line per row.
 *
 * A spreadsheet splits cells on the tab, so any tab or newline inside a name
 * would shift every following value into the wrong column.
 */
export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.map(flatten).join('\t')).join(ROW_ENDING) + ROW_ENDING;
}

/** RFC 4180 quoting: a field needs quotes if it holds a comma, a quote or a newline. */
export function csvField(value: string): string {
  const text = value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Comma-separated values, quoting only where the format demands it. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvField).join(',')).join(ROW_ENDING) + ROW_ENDING;
}