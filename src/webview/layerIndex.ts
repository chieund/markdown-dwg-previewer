interface Hideable {
  style: { display: string };
}

/**
 * The drawn elements of one page, grouped by layer.
 *
 * Toggling a layer used to throw the whole SVG away and render every entity
 * again — seconds on a 100k-entity drawing, for one checkbox. Flipping
 * `display` on the layer's own elements costs only that layer, and keeps the
 * draw order between layers that a regrouping would lose.
 */
export class LayerIndex<T extends Hideable = Hideable> {
  private readonly elements = new Map<string, T[]>();
  private readonly counts = new Map<string, number>();

  /** Registers one entity; `element` is null when it drew nothing. */
  add(layer: string, element: T | null, hidden: Set<string>): void {
    this.counts.set(layer, (this.counts.get(layer) ?? 0) + 1);
    if (!element) return;
    if (hidden.has(layer)) element.style.display = 'none';
    let list = this.elements.get(layer);
    if (!list) this.elements.set(layer, (list = []));
    list.push(element);
  }

  apply(hidden: Set<string>): void {
    for (const [layer, list] of this.elements) {
      const display = hidden.has(layer) ? 'none' : '';
      for (const element of list) element.style.display = display;
    }
  }

  visibleCount(hidden: Set<string>): number {
    let total = 0;
    for (const [layer, count] of this.counts) if (!hidden.has(layer)) total += count;
    return total;
  }
}
