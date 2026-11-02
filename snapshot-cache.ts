import type { Snapshot } from './model.ts';

export type CachedSnapshot = { at: number; value: Snapshot };
type Entry = CachedSnapshot & { dirty?: boolean; retryAt?: number; error?: boolean; saved?: boolean };
type Store = { read(key: string): CachedSnapshot | null; write(key: string, entry: CachedSnapshot): void; changed(key: string): void };
const TTL = 60000;
const MAX_AGE = 24 * 60 * 60000;

/** Shared, bounded stale-while-revalidate cache. Forced reads never fall back. */
export class SnapshotCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, { epoch: number; promise: Promise<Entry> }>();
  private epochs = new Map<string, number>();
  private disposed = false;
  constructor(private store: Store, private now = Date.now) {}

  async get(key: string, load: () => Promise<Snapshot>, force = false): Promise<Snapshot> {
    let entry = this.entries.get(key);
    if (!entry && !force) {
      try {
        const saved = this.store.read(key);
        if (saved && this.now() - saved.at < MAX_AGE && this.now() >= saved.at) {
          entry = { ...saved, saved: true, dirty: true }; this.remember(key, entry);
        }
      } catch { /* Bad saved data is a cache miss. */ }
    }
    if (force || !entry || this.now() - entry.at >= MAX_AGE) {
      const epoch = this.epochs.get(key) ?? 0;
      let live = await this.refresh(key, load);
      if (!this.disposed && epoch !== (this.epochs.get(key) ?? 0)) {
        const newer = this.entries.get(key);
        if (newer && !newer.dirty) live = newer;
        else return this.get(key, load, true);
      }
      const value = structuredClone(live.value);
      value.cache = { source: 'live', refreshing: false, refreshError: false };
      return value;
    }
    if ((entry.dirty || this.now() - entry.at >= TTL) && this.now() >= (entry.retryAt ?? 0)) void this.refresh(key, load).catch(() => {});
    const value = structuredClone(entry.value);
    value.cache = { source: entry.saved ? 'saved' : 'memory', refreshing: this.pending.has(key), refreshError: !!entry.error };
    return value;
  }

  private refresh(key: string, load: () => Promise<Snapshot>): Promise<Entry> {
    const epoch = this.epochs.get(key) ?? 0;
    const existing = this.pending.get(key);
    if (existing?.epoch === epoch) return existing.promise;
    const promise = Promise.resolve().then(load).then(value => {
      const entry: Entry = { at: this.now(), value: structuredClone(value) };
      if (!this.disposed && epoch === (this.epochs.get(key) ?? 0)) {
        this.remember(key, entry);
        try { this.store.write(key, { at: entry.at, value: entry.value }); } catch { /* Disk failures do not break a live status. */ }
        this.store.changed(key);
      }
      return entry;
    }).catch(error => {
      const cached = this.entries.get(key);
      if (!this.disposed && epoch === (this.epochs.get(key) ?? 0) && cached) {
        cached.error = true; cached.retryAt = this.now() + 15000;
        this.store.changed(key);
      }
      throw error;
    }).finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); });
    this.pending.set(key, { epoch, promise });
    return promise;
  }

  private remember(key: string, entry: Entry) {
    if (this.entries.size >= 100 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
  }

  invalidate(matches: (key: string) => boolean = () => true) {
    for (const key of new Set([...this.entries.keys(), ...this.pending.keys()])) if (matches(key)) {
      const entry = this.entries.get(key); if (entry) { entry.dirty = true; entry.retryAt = 0; }
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    }
  }
  dispose() { this.disposed = true; this.entries.clear(); this.pending.clear(); this.epochs.clear(); }
}
