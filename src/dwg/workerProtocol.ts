import type { ParsedDxf } from '../shared/types';
import type { Stage } from './pipeline';

export interface WorkerRequest {
  id: number;
  bytes: Uint8Array;
  filePath: string;
  converterPath: string;
}

export type WorkerReply =
  | { type: 'log'; msg: string }
  | { id: number; type: 'progress'; stage: Stage }
  | { id: number; type: 'done'; parsed: ParsedDxf }
  | { id: number; type: 'error'; message: string };
