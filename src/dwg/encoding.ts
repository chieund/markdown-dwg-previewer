/**
 * Turns the bytes of a text DXF into a string.
 *
 * DXF files before R2007 (AC1021) are written in the code page named by the
 * `$DWGCODEPAGE` header variable, not UTF-8 — a Japanese drawing is Shift-JIS
 * (`ANSI_932`). Reading those as UTF-8 turns every label into U+FFFD. Valid
 * UTF-8 is still preferred whatever the header says, because many non-AutoCAD
 * writers emit UTF-8 under an old version stamp, and Shift-JIS text is almost
 * never valid UTF-8 by accident.
 */

/** Enough to reach `$ACADVER` and `$DWGCODEPAGE`, which open the header. */
const HEADER_SNIFF_BYTES = 64 * 1024;

const CODE_PAGES: Record<string, string> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  DOS932: 'shift_jis',
};

export function decodeDxfBuffer(buffer: Uint8Array): string {
  let body = buffer;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Not UTF-8 — fall through to the code page the header declares.
  }

  const head = Buffer.from(body.subarray(0, HEADER_SNIFF_BYTES)).toString('latin1');
  // R2007 and later are UTF-8 by definition; a stray bad byte stays a U+FFFD.
  const version = headerValue(head, '$ACADVER');
  if (version && version >= 'AC1021') return new TextDecoder('utf-8').decode(body);

  const codepage = headerValue(head, '$DWGCODEPAGE')?.toUpperCase();
  const encoding = (codepage && CODE_PAGES[codepage]) || 'windows-1252';
  try {
    return new TextDecoder(encoding).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

/** Value of a header variable: `9 / $NAME / <code> / <value>`. */
function headerValue(head: string, name: string): string | undefined {
  const lines = head.split(/\r\n|\r|\n/);
  for (let i = 0; i + 3 < lines.length; i++) {
    if (lines[i].trim() === '9' && lines[i + 1].trim() === name) return lines[i + 3].trim();
  }
  return undefined;
}
