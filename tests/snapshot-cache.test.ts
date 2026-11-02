import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCache, type CachedSnapshot } from '../snapshot-cache.ts';
import { snapshot } from './fixtures.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  let now = 100000; const disk = new Map<string, CachedSnapshot>(); let changes = 0; let writes = 0;
  const cache = new SnapshotCache({ read: key => structuredClone(disk.get(key) ?? null),
    write: (key, value) => { writes++; disk.set(key, structuredClone(value)); }, changed: () => { changes++; } }, () => now);
  return { cache, disk, tick(ms: number) { now += ms; }, get changes() { return changes; }, get writes() { return writes; } };
}
test('concurrent readers share one scan and cannot mutate the cached snapshot', async () => {
  const h = setup(); const wait = deferred<ReturnType<typeof snapshot>>(); let calls = 0;
  const load = () => { calls++; return wait.promise; };
  const first = h.cache.get('same', load); const second = h.cache.get('same', load);
  wait.resolve(snapshot()); const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(h.writes, 1);
  a.target!.title = 'modified'; assert.notEqual(b.target!.title, a.target!.title);
  const cached = await h.cache.get('same', load); assert.equal(calls, 1); assert.equal(cached.cache?.source, 'memory');
  h.cache.dispose();
});
test('expired data returns immediately while one shared refresh updates it', async () => {
  const h = setup(); await h.cache.get('key', async () => snapshot()); h.tick(60001);
  const wait = deferred<ReturnType<typeof snapshot>>(); let calls = 0;
  const load = () => { calls++; return wait.promise; };
  const cached = await h.cache.get('key', load);
  assert.equal(cached.cache?.refreshing, true); assert.equal(cached.fingerprint, 'a'.repeat(64));
  const fresh = h.cache.get('key', load, true);
  wait.resolve(snapshot({ fingerprint: 'b'.repeat(64) }));
  assert.equal((await fresh).fingerprint, 'b'.repeat(64)); assert.equal(calls, 1); h.cache.dispose();
});
test('a saved snapshot survives restart and is shown before its revalidation finishes', async () => {
  const h = setup(); h.disk.set('key', { at: 100000, value: snapshot() });
  const wait = deferred<ReturnType<typeof snapshot>>();
  const saved = await h.cache.get('key', () => wait.promise);
  assert.equal(saved.cache?.source, 'saved'); assert.equal(saved.cache?.refreshing, true);
  const fresh = h.cache.get('key', () => wait.promise, true); wait.resolve(snapshot({ configured: false }));
  assert.equal((await fresh).configured, false); assert.equal(h.writes, 1); h.cache.dispose();
});
test('background failures keep saved data with backoff; forced failures never use it as fresh', async () => {
  const h = setup(); await h.cache.get('key', async () => snapshot()); h.tick(60001); let calls = 0;
  const fail = async () => { calls++; throw new Error('offline'); };
  await h.cache.get('key', fail); await assert.rejects(h.cache.get('key', fail, true));
  const saved = await h.cache.get('key', fail);
  assert.equal(saved.cache?.refreshError, true); assert.equal(calls, 1);
  await assert.rejects(h.cache.get('key', fail, true)); assert.equal(calls, 2); h.cache.dispose();
});
test('invalidation during a scan prevents old completion overwriting newer data', async () => {
  const h = setup(); const old = deferred<ReturnType<typeof snapshot>>();
  const before = h.cache.get('key', () => old.promise);
  h.cache.invalidate(key => key === 'key');
  const newer = await h.cache.get('key', async () => snapshot({ fingerprint: 'b'.repeat(64) }), true);
  old.resolve(snapshot()); await before;
  assert.equal(h.disk.get('key')!.value.fingerprint, newer.fingerprint); assert.equal(h.writes, 1); h.cache.dispose();
});
test('different scopes never share values, and disposed loads cannot write or notify', async () => {
  const h = setup(); await h.cache.get('one', async () => snapshot());
  const other = await h.cache.get('two', async () => snapshot({ root: '/other' })); assert.equal(other.root, '/other');
  h.cache.invalidate(key => key === 'one');
  let loads = 0;
  const wait = deferred<ReturnType<typeof snapshot>>(); const pending = h.cache.get('one', () => { loads++; return wait.promise; }, true);
  h.cache.dispose(); const writes = h.writes; const changes = h.changes; wait.resolve(snapshot()); await pending;
  assert.equal(h.writes, writes); assert.equal(h.changes, changes); assert.equal(loads, 1);
});
