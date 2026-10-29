/**
 * Case- and accent-insensitive form, so "coc" finds "cọc" and "dam" finds "Dầm".
 * Kept in `shared` because both the extension host (search) and the webview
 * (layer names) need the same folding.
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}
