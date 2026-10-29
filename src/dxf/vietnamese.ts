/**
 * Old Vietnamese drawings store text as TCVN3 (ABC) bytes and rely on a font
 * (`.VnTime`, `VNARIAL.TTF`, `vn-abc.shx` …) to draw them; read as a Western
 * code page the bytes come out as "cöa" for "cửa". The font a text is drawn
 * in tells which texts are TCVN3, so the decision is made per text.
 */

export type LegacyFont = 'tcvn3' | 'tcvn3-caps' | null;

/** TCVN3 byte → the Vietnamese letter it stands for. */
const TCVN3: Map<number, string> = new Map([
    [0xa1, 'Ă'], [0xa2, 'Â'], [0xa3, 'Ê'], [0xa4, 'Ô'], [0xa5, 'Ơ'], [0xa6, 'Ư'], [0xa7, 'Đ'],
    [0xa8, 'ă'], [0xa9, 'â'], [0xaa, 'ê'], [0xab, 'ô'], [0xac, 'ơ'], [0xad, 'ư'], [0xae, 'đ'],
    [0xb5, 'à'], [0xb6, 'ả'], [0xb7, 'ã'], [0xb8, 'á'], [0xb9, 'ạ'],
    [0xbb, 'ằ'], [0xbc, 'ẳ'], [0xbd, 'ẵ'], [0xbe, 'ắ'], [0xc6, 'ặ'],
    [0xc7, 'ầ'], [0xc8, 'ẩ'], [0xc9, 'ẫ'], [0xca, 'ấ'], [0xcb, 'ậ'],
    [0xcc, 'è'], [0xce, 'ẻ'], [0xcf, 'ẽ'], [0xd0, 'é'], [0xd1, 'ẹ'],
    [0xd2, 'ề'], [0xd3, 'ể'], [0xd4, 'ễ'], [0xd5, 'ế'], [0xd6, 'ệ'],
    [0xd7, 'ì'], [0xd8, 'ỉ'], [0xdc, 'ĩ'], [0xdd, 'í'], [0xde, 'ị'],
    [0xdf, 'ò'], [0xe1, 'ỏ'], [0xe2, 'õ'], [0xe3, 'ó'], [0xe4, 'ọ'],
    [0xe5, 'ồ'], [0xe6, 'ổ'], [0xe7, 'ỗ'], [0xe8, 'ố'], [0xe9, 'ộ'],
    [0xea, 'ờ'], [0xeb, 'ở'], [0xec, 'ỡ'], [0xed, 'ớ'], [0xee, 'ợ'],
    [0xef, 'ù'], [0xf1, 'ủ'], [0xf2, 'ũ'], [0xf3, 'ú'], [0xf4, 'ụ'],
    [0xf5, 'ừ'], [0xf6, 'ử'], [0xf7, 'ữ'], [0xf8, 'ứ'], [0xf9, 'ự'],
    [0xfa, 'ỳ'], [0xfb, 'ỷ'], [0xfc, 'ỹ'], [0xfd, 'ý'], [0xfe, 'ỵ'],
  ] as [number, string][]
);

/** Which legacy encoding a font file (or typeface name) draws, if any. Case-insensitive. */
export function legacyFontOf(fontFile: string | undefined): LegacyFont {
  if (!fontFile) return null;
  const name = fontFile.trim().toLowerCase().split(/[\\/]/).pop() ?? '';
  // `.VnTime` is TCVN3; the trailing H marks the all-capitals variant (`.VnTimeH`).
  if (/^\.vn[a-z0-9 _-]*$/.test(name)) return name.endsWith('h') ? 'tcvn3-caps' : 'tcvn3';
  if (/^vh[a-z0-9 _-]*\.ttf$/.test(name)) return 'tcvn3-caps';
  const ttf = /^vn[a-z0-9 _-]*\.ttf$/.exec(name);
  if (ttf) {
    const base = ttf[0].slice(0, -4).replace(/_?\d+$/, '');
    return base.endsWith('h') ? 'tcvn3-caps' : 'tcvn3';
  }
  const shx = /^vn[a-z0-9_-]*\.shx$/.exec(name);
  if (shx) {
    const base = shx[0].slice(0, -4);
    return base.endsWith('h') ? 'tcvn3-caps' : 'tcvn3';
  }
  return null;
}

const byteOfChar = new Map<string, Map<string, number>>();

/** Character → the byte (0x80–0xFF) that `label` decodes to it. */
function reverseTable(label: string): Map<string, number> {
  let table = byteOfChar.get(label);
  if (!table) {
    table = new Map();
    const decoder = new TextDecoder(label);
    for (let byte = 0x80; byte <= 0xff; byte++) {
      const ch = decoder.decode(new Uint8Array([byte]));
      if (ch.length === 1 && ch !== '\ufffd' && !table.has(ch)) table.set(ch, byte);
    }
    byteOfChar.set(label, table);
  }
  return table;
}

/**
 * Reads text that was decoded as `decodedWith` back as TCVN3.
 * Characters that are not a TCVN3 letter (ASCII, U+FFFD, anything unmapped) stay as they are.
 */
export function decodeTcvn3(text: string, caps: boolean, decodedWith: string): string {
  const bytes = reverseTable(decodedWith);
  let out = '';
  for (const ch of text) {
    const byte = bytes.get(ch);
    out += (byte !== undefined ? TCVN3.get(byte) : undefined) ?? ch;
  }
  return caps ? out.toLocaleUpperCase('vi') : out;
}
