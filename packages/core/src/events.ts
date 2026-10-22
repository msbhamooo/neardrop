export type EventMap = Record<string, unknown>;

/** Tiny typed event emitter (no dependency, works in Node + browsers + workers). */
export class Emitter<E extends EventMap> {
  private listeners = new Map<keyof E, Set<(payload: unknown) => void>>();

  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (payload: unknown) => void);
    return () => set!.delete(fn as (payload: unknown) => void);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        // listener errors must not break the transfer loop
        // eslint-disable-next-line no-console
        console.error('[neardrop] listener error', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
