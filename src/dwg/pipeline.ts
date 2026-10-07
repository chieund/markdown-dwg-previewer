/**
 * Drawing bytes → parsed pages. Free of `vscode`, so it can run in a worker.
 */
import * as path from 'path';
import { convertDwgToDxf } from './converter';
import { decodeDxfBuffer } from './encoding';
import { describeUnreadableFormat, detectDrawingFormat } from './format';
import { parseDxf } from '../dxf/parseDxf';
import type { ParsedDxf } from '../shared/types';

export type Stage = 'converting' | 'parsing';

export async function processDrawing(
  bytes: Uint8Array,
  filePath: string,
  converterPath: string,
  progress: (stage: Stage) => void
): Promise<ParsedDxf> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // DXF is this extension's own intermediate format, so a DXF file skips
  // conversion entirely and goes straight to the parser.
  const format = detectDrawingFormat(buffer);
  let dxfText: string;

  if (format === 'dxf-text') {
    dxfText = decodeDxfBuffer(buffer);
  } else if (format === 'dwg') {
    progress('converting');
    dxfText = await convertDwgToDxf(buffer, filePath, converterPath);
  } else {
    throw new Error(describeUnreadableFormat(format, path.basename(filePath)));
  }

  progress('parsing');
  // libredwg writes every layer's colour negative, so on/off only means
  // something in a DXF the user's CAD software wrote.
  return parseDxf(dxfText, { trustLayerOffFlags: format === 'dxf-text' });
}
