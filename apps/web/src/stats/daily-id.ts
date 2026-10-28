/** Random id that changes every UTC day, so usage can be counted per day but never followed across days. */
export interface DailyIdStore {
  get(): { day: string; id: string } | undefined;
  set(v: { day: string; id: string }): void;
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export function getDailyId(store: DailyIdStore, now: number = Date.now(), uuid: () => string = () => crypto.randomUUID()): string {
  const day = utcDay(now);
  let cur: { day: string; id: string } | undefined;
  try { cur = store.get(); } catch { /* storage blocked */ }
  if (cur && cur.day === day && typeof cur.id === 'string') return cur.id;
  const id = uuid();
  try { store.set({ day, id }); } catch { /* storage blocked: id is per page load */ }
  return id;
}
