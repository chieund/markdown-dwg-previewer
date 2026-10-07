/**
 * A size-bounded map that forgets the least recently used entry first.
 *
 * Parsed drawings can run to hundreds of megabytes, so keeping every one ever
 * opened for the life of the window grows memory without bound.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    // Map keeps insertion order, so re-inserting marks the entry most recent.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }
}

export interface Debounced {
  (): void;
  cancel(): void;
}

/** Runs `fn` once, `delayMs` after the last of a burst of calls. */
export function debounce(fn: () => void, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  }) as Debounced;
  run.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}
