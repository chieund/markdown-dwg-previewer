import type { ObjectInfo } from '../shared/types';

export type HitKind = 'text' | 'attribute' | 'block' | 'layer' | 'type';

export interface SearchHit {
  kind: HitKind;
  label: string;
  /** Extra context shown beside the label, e.g. the block an attribute sits on. */
  detail?: string;
  page: number;
  /** Indices into the object table that this hit selects. */
  objects: number[];
}

export interface SearchGroup {
  kind: HitKind;
  /** Hits found, before the listing limit. */
  total: number;
  hits: SearchHit[];
}

const GROUP_ORDER: HitKind[] = ['text', 'attribute', 'block', 'layer', 'type'];

/**
 * Finds `query` anywhere a user might look for it: displayed text, attribute
 * tags and values (hidden ones too — they hold part numbers and makers), block
 * names, layer names and entity types. Matching ignores case. Results come
 * grouped by kind so a broad query ("door") stays readable; blocks, layers and
 * types collapse into one hit per name and page.
 */
export function searchDrawing(objects: ObjectInfo[], query: string, limit = 50): SearchGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches = (value: string | undefined) => value !== undefined && value.toLowerCase().includes(needle);

  const found = new Map<HitKind, SearchHit[]>(GROUP_ORDER.map((kind) => [kind, []]));
  const grouped = new Map<string, SearchHit>();
  const addGrouped = (kind: HitKind, name: string, page: number, index: number) => {
    const key = `${kind}\0${page}\0${name}`;
    let hit = grouped.get(key);
    if (!hit) {
      hit = { kind, label: name, page, objects: [] };
      grouped.set(key, hit);
      found.get(kind)!.push(hit);
    }
    hit.objects.push(index);
  };

  objects.forEach((object, index) => {
    // Nothing on the canvas to show for it
    if (object.empty) return;
    if (matches(object.text)) {
      found.get('text')!.push({ kind: 'text', label: object.text!, detail: object.layer, page: object.page, objects: [index] });
    }
    for (const attribute of object.attributes ?? []) {
      if (!matches(attribute.tag) && !matches(attribute.value)) continue;
      found.get('attribute')!.push({
        kind: 'attribute',
        label: `${attribute.tag} = ${attribute.value}${attribute.hidden ? ' (hidden)' : ''}`,
        detail: object.block,
        page: object.page,
        objects: [index],
      });
    }
    if (matches(object.block)) addGrouped('block', object.block!, object.page, index);
    if (matches(object.layer)) addGrouped('layer', object.layer, object.page, index);
    if (matches(object.type)) addGrouped('type', object.type, object.page, index);
  });

  return GROUP_ORDER.map((kind) => {
    const hits = found.get(kind)!;
    return { kind, total: hits.length, hits: hits.slice(0, limit) };
  }).filter((group) => group.total > 0);
}
