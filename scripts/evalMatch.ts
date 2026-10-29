/**
 * Answer matching for the agent evaluation.
 *
 * Markdown emphasis characters (* _ `) are ignored. An expect/forbid entry is one or more alternatives separated by "|".
 *  - A plain number ("120.5", "57", "-918.95") matches as a whole number: no digit,
 *    ".", "," or "-" directly before it, no digit or ".<digit>" / ",<digit>" after it.
 *    Thousands separators ("," or ".") are allowed inside integers of 4+ digits, and
 *    trailing decimal zeros are ignored: "120.5" matches "120.5", "120,50", "120.50";
 *    "57" matches "57", "57.0" and "57 doors" but not "157", "570", "57.5" or "-57".
 *  - Anything else is literal text (case- and accent-insensitive, any whitespace run
 *    matches a space), not touching letters or digits on either side; when it starts or
 *    ends with a digit the number rules above apply at that edge.
 */

import * as path from 'path';

const fold = (s: string) =>
  s.replace(/[\u2212\u2013\u2012]/g, '-').replace(/[*_`]/g, '').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

function numberPattern(n: string): string {
  const neg = n.startsWith('-');
  const [int, dec] = n.replace(/^-/, '').split(/[.,]/);
  let intRe: string;
  if (int.length > 3 && int[0] !== '0') {
    // optional thousands separators every three digits from the right
    const head = int.slice(0, int.length % 3 || 3);
    const rest = int.slice(head.length).match(/\d{3}/g) ?? [];
    intRe = head + rest.map((g) => `[.,]?${g}`).join('');
  } else intRe = int;
  const decDigits = dec === undefined ? '' : dec.replace(/0+$/, '');
  const decRe = decDigits ? `[.,]${decDigits}0*` : '(?:[.,]0+)?';
  return `${neg ? '-' : '(?<!-)'}${intRe}${decRe}`;
}

function alternativeRegex(alt: string): RegExp | undefined {
  const a = fold(alt.trim());
  if (!a) return undefined;
  const numBefore = '(?<![\\p{N}]|\\p{N}[.,])';
  const numAfter = '(?![\\p{N}]|[.,]\\p{N})';
  if (NUMBER.test(a)) return new RegExp(`${numBefore}${numberPattern(a)}${numAfter}`, 'u');
  const body = escapeRe(a).replace(/\s+/g, '\\s+');
  const start = /^\d/.test(a) ? `${numBefore}(?<!-)` : '(?<![\\p{L}\\p{N}])';
  const end = /\d$/.test(a) ? numAfter : '(?![\\p{L}\\p{N}])';
  return new RegExp(`${start}${body}${end}`, 'u');
}

/** True when `entry` (alternatives split by "|") matches somewhere in `answer`. */
export function matches(answer: string, entry: string): boolean {
  const text = fold(answer);
  return entry.split('|').some((alt) => alternativeRegex(alt)?.test(text) ?? false);
}

export interface Score {
  pass: boolean;
  missing: string[];
  forbidden: string[];
}

export function score(answer: string, expect: string[], forbid: string[] = []): Score {
  const missing = expect.filter((e) => !matches(answer, e));
  const forbidden = forbid.filter((f) => matches(answer, f));
  return { pass: missing.length === 0 && forbidden.length === 0 && expect.length > 0, missing, forbidden };
}

/** A question's drawing: an absolute path as given, a relative one under `samples` ($DWG_SAMPLES). */
export function resolveDrawing(drawing: string, samples: string | undefined = process.env.DWG_SAMPLES): string {
  if (path.isAbsolute(drawing)) return drawing;
  if (!samples) throw new Error(`"${drawing}" is relative: set DWG_SAMPLES to the folder that holds the sample drawings`);
  return path.resolve(samples, drawing);
}
