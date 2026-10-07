import type { DxfPage } from '../shared/types';

/**
 * Layers the CAD file itself has switched off; the viewer opens with them hidden.
 *
 * Unless that hides everything on the first page: a drawing that opens blank
 * reads as a broken viewer, and some files (AutoCAD's own title-block samples)
 * keep all their geometry on a layer that happens to be off.
 */
export function initialHiddenLayers(pages: DxfPage[]): Set<string> {
  const hidden = new Set<string>();
  for (const page of pages) {
    for (const layer of page.layers) if (layer.off) hidden.add(layer.name);
  }
  const first = pages[0];
  if (first && first.layers.length > 0 && first.layers.every((layer) => hidden.has(layer.name))) {
    return new Set();
  }
  return hidden;
}

export interface ViewState {
  pageName: string;
  hiddenLayers: Set<string>;
}

/**
 * What survives a live reload. Saving the drawing in CAD software reloads the
 * preview; throwing away the page, layer choices and zoom on every save makes
 * side-by-side editing unusable. They carry over as long as the page still
 * exists, and only for layers the new drawing still has.
 */
export function carryOverView(
  previous: ViewState,
  pages: DxfPage[]
): { pageIndex: number; hiddenLayers: Set<string>; keepView: boolean } {
  const pageIndex = pages.findIndex((page) => page.name === previous.pageName);
  if (pageIndex < 0) {
    return { pageIndex: 0, hiddenLayers: initialHiddenLayers(pages), keepView: false };
  }

  const known = new Set(pages.flatMap((page) => page.layers.map((layer) => layer.name)));
  const hiddenLayers = new Set([...previous.hiddenLayers].filter((name) => known.has(name)));
  return { pageIndex, hiddenLayers, keepView: true };
}
