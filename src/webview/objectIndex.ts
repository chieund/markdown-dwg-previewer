import { computeBounds } from '../shared/bounds';
import type { Bounds, DxfEntity } from '../shared/types';

/**
 * The page's drawn elements, keyed by the top-level object they belong to.
 *
 * Selecting a door must light up every line of it, and clicking any one of
 * those lines must find the door; zooming to it needs the bounds of all its
 * pieces. Entities without an object (none today, but nothing guarantees it)
 * stay drawn and simply cannot be selected.
 */
export class ObjectIndex<T extends object> {
  private readonly elements = new Map<number, T[]>();
  private readonly entities = new Map<number, DxfEntity[]>();
  private readonly owner = new WeakMap<T, number>();

  add(entity: DxfEntity, element: T | null): void {
    const obj = entity.obj;
    if (obj === undefined) return;
    let drawn = this.entities.get(obj);
    if (!drawn) this.entities.set(obj, (drawn = []));
    drawn.push(entity);
    if (element) this.attach(obj, element);
  }

  /**
   * Links a drawn element to its object. Large pages register every entity up
   * front (so bounds are complete at once) and attach elements as each
   * animation-frame batch draws them.
   */
  attach(obj: number | undefined, element: T): void {
    if (obj === undefined) return;
    let list = this.elements.get(obj);
    if (!list) this.elements.set(obj, (list = []));
    list.push(element);
    this.owner.set(element, obj);
  }

  objectOf(element: T): number | undefined {
    return this.owner.get(element);
  }

  elementsOf(objects: number[]): T[] {
    return objects.flatMap((obj) => this.elements.get(obj) ?? []);
  }

  boundsOf(objects: number[]): Bounds | null {
    return computeBounds(objects.flatMap((obj) => this.entities.get(obj) ?? []));
  }
}
