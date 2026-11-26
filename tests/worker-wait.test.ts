import test from 'node:test';
import assert from 'node:assert/strict';
import { waitWorker } from '../worker-wait.ts';

// A fake worker thread: an event log, a status and a clock. `script` runs while waitWorker waits, like the real worker.
function worker(status: string, events: { type: string; data?: unknown }[], output: string | null) {
  let clock = 1_000_000;
  const log = events.map((e, i) => ({ seq: i + 1, createdAt: clock, ...e }));
  const state = { status, output, queue: [] as string[], script: [] as (() => void)[], afterGet: [] as (() => void)[], afterOutput: [] as (() => void)[] };
  const add = (type: string, data?: unknown) => log.push({ seq: log.length + 1, createdAt: clock, type, data });  // stamped with the fake clock
  const step = () => { const next = state.script.shift(); next?.(); };
  const threads = {
    get: async () => { const status = state.status; state.afterGet.shift()?.(); return { status, createdAt: 1_000_000 }; },
    queuedMessages: { list: async () => state.queue.map(s => { const [st, kind] = s.split(':'); return { state: st, waitingOn: kind ? { kind } : null }; }) },
    output: async () => { const output = state.output; state.afterOutput.shift()?.(); return { output }; },
    wait: async ({ timeoutMs }: { timeoutMs: number }) => {
      while (state.status !== 'idle' && state.script.length) step();
      if (state.status !== 'idle') { clock += timeoutMs; throw new Error('timeout'); }
      return {};
    },
    events: {
      list: async ({ afterSeq = '0', types, order, limit }: { afterSeq?: string; types?: string[]; order?: string; limit?: string }) => {
        let rows = log.filter(e => e.seq > Number(afterSeq) && (!types || types.includes(e.type)));
        if (order === 'desc') rows = rows.reverse();
        return rows.slice(0, Number(limit ?? 100));  // BB returns at most 100 rows by default
      },
      wait: async ({ afterSeq, type, waitMs }: { afterSeq: string; type: string; waitMs: string }) => {
        const found = () => log.find(e => e.seq > Number(afterSeq) && e.type === type);
        while (!found() && state.script.length) step();
        if (!found()) clock += Number(waitMs);
        return found() ?? null;
      },
    },
  };
  return { threads: threads as any, state, add, now: () => clock, opts: { budgetMs: 90_000, now: () => clock, sleep: async (ms: number) => { clock += ms; step(); } }, tickIdle: (ms: number) => { clock += ms; } };  // guardian: allow — loose fake of the BB SDK threads area in this test
}

const done = [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }];

test('a busy worker is waited for until idle, and its report comes with the cursor', async () => {
  const w = worker('active', [{ type: 'turn/started' }], null);
  w.state.script.push(() => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done: src/a.ts'; });
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 2, true, 'Done: src/a.ts']);
});

test('an idle worker that resumes by itself after the cursor is followed to its next idle (Antigravity pauses)', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.state.script.push(() => { w.add('turn/started'); w.state.status = 'active'; },
    () => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done, tsc passes'; });
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 4, true, 'Done, tsc passes']);
});

test('a resume that started and finished between two calls is not missed', async () => {
  const w = worker('idle', [...done, { type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }], 'Done');
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 4, true, 'Done']);
});

test('an idle worker that does not resume returns after the budget with how long it has been idle', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 2, false, 'waiting for tsc']);
  assert.equal(r.quietForMs, 90_000);
});

test('an error and a stop are reported as such, not as a slow worker', async () => {
  const failed = worker('error', done, null);
  assert.equal((await waitWorker(failed.threads, 'thr_w', 0, failed.opts)).state, 'failed');
  const stopped = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  assert.equal((await waitWorker(stopped.threads, 'thr_w', 2, stopped.opts)).state, 'stopped');
  // A provider cancellation without BB's manual stop event is a failure the coordinator retries.
  const interrupted = worker('idle', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'interrupted' } }], null);
  assert.equal((await waitWorker(interrupted.threads, 'thr_w', 0, interrupted.opts)).state, 'failed');
});

test('a worker still busy when the budget runs out is reported working, without a report', async () => {
  const w = worker('active', [{ type: 'turn/started' }], 'partial');
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.deepEqual([r.state, r.output], ['working', null]);
});

test('an error is not final while BB retries by itself; one that stays is reported failed', async () => {
  const retried = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  retried.state.script.push(() => { retried.add('turn/started'); retried.state.status = 'active'; },
    () => { retried.add('turn/completed', { status: 'completed' }); retried.state.status = 'idle'; retried.state.output = 'Done'; });
  const r = await waitWorker(retried.threads, 'thr_w', 2, retried.opts);
  assert.deepEqual([r.state, r.resumed, r.output], ['idle', true, 'Done']);
  const failed = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  assert.equal((await waitWorker(failed.threads, 'thr_w', 2, failed.opts)).state, 'failed');
});

test('an old stop does not outweigh a later successful turn', async () => {
  const w = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }, { type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }], 'Done');
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.output], ['idle', 'Done']);
});

test('a stop after a hundred lifecycle events is still seen', async () => {
  const turns = Array.from({ length: 50 }, () => done).flat();
  const w = worker('idle', [...turns, { type: 'turn/started' }, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  assert.equal((await waitWorker(w.threads, 'thr_w', 0, w.opts)).state, 'stopped');
  const again = await waitWorker(w.threads, 'thr_w', 102, w.opts);
  assert.equal(again.state, 'stopped');
});

test('a worker that resumes right after its status was read is reported working, not idle for a long time', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.tickIdle(600_000);
  // The first read waits out the budget; the resume lands between the second status read and the event read.
  w.state.afterGet.push(() => undefined, () => { w.add('turn/started'); w.state.status = 'active'; });
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.output], ['working', null]);
});

test('an error with BB\'s retry still queued is working, not failed, even past the budget', async () => {
  const w = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  w.state.queue = ['scheduled'];  // the retry waits in the queue for a later moment
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.output], ['working', null]);
});

test('a report read while a new turn starts is not handed out as the final one', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.state.afterOutput.push(() => { w.add('turn/started'); w.state.status = 'active'; w.state.output = 'half done'; });
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.deepEqual([r.state, r.output], ['working', null]);
});

test('a stop during startup stays a stop when the cancelled turn\'s start arrives late', async () => {
  const w = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }, { type: 'turn/started' }], null);
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.equal(r.state, 'stopped');
  assert.equal((await waitWorker(w.threads, 'thr_w', r.seq, w.opts)).state, 'stopped');
});

test('an error whose retry BB queues a moment later is followed, not reported failed', async () => {
  const w = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  w.state.script.push(() => { w.state.queue = ['queued']; },
    () => { w.state.queue = []; w.add('turn/started'); w.state.status = 'active'; },
    () => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done'; });
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.deepEqual([r.state, r.resumed, r.output], ['idle', true, 'Done']);
});

test('an exhausted retry is a failure, not endless work', async () => {
  const w = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  w.state.queue = ['failed_exhausted'];
  assert.equal((await waitWorker(w.threads, 'thr_w', 2, w.opts)).state, 'failed');
});

test('resumed and the state come from the same read: a resume seen at the end means working', async () => {
  const w = worker('idle', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }], 'Done');
  // gets: the first look, the read before the report, the read after it; the resume lands in the last one.
  w.state.afterGet.push(() => undefined, () => undefined, () => { w.add('turn/started'); w.state.status = 'active'; });
  const r = await waitWorker(w.threads, 'thr_w', 1, w.opts);
  assert.deepEqual([r.state, r.output, r.resumed], ['working', null, true]);
});

test('a follow-up BB holds after a stop is working, and quietForMs bounds it instead of polling forever', async () => {
  const w = worker('idle', [{ type: 'turn/started' }, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  w.state.queue = ['waiting:thread-busy'];
  let r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  for (let i = 0; i < 5; i++) r = await waitWorker(w.threads, 'thr_w', r.seq, w.opts);
  assert.equal(r.state, 'working');
  assert.ok(r.quietForMs >= 480_000, String(r.quietForMs));
});

test('a manual stop with nothing left to run is stopped; a provider that missed its start is failed', async () => {
  const stopped = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  assert.equal((await waitWorker(stopped.threads, 'thr_w', 0, stopped.opts)).state, 'stopped');
  const missed = worker('error', [{ type: 'turn/started' }, { type: 'system/thread/interrupted', data: { reason: 'provider-turn-idle' } }], null);
  assert.equal((await waitWorker(missed.threads, 'thr_w', 0, missed.opts)).state, 'failed');
});

test('a follow-up waiting for a stop to settle or for a concurrency slot is working, not stopped', async () => {
  for (const row of ['waiting:stopping', 'waiting:thread-busy', 'queued']) {
    const w = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
    w.state.queue = [row];
    assert.equal((await waitWorker(w.threads, 'thr_w', 0, w.opts)).state, 'working', row);
  }
});

test('a worker waiting for an approval is working, with its quiet time growing', async () => {
  const w = worker('active', [{ type: 'turn/started' }], null);
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.equal(r.state, 'working');
  assert.ok(r.quietForMs >= 90_000);
});

test('a superseded old retry does not hide the finished report', async () => {
  const w = worker('idle', done, 'Done');
  w.state.queue = ['waiting:superseded'];
  assert.deepEqual(Object.values(await waitWorker(w.threads, 'thr_w', 0, w.opts)).slice(0, 1).concat((await waitWorker(w.threads, 'thr_w', 0, w.opts)).output), ['idle', 'Done']);
});

test('a first prompt that exhausted its retries before any turn is failed, without waiting out the budget', async () => {
  for (const status of ['idle', 'pending']) {
    const w = worker(status, [], null);
    w.state.queue = ['failed_exhausted'];
    const start = w.now();
    assert.equal((await waitWorker(w.threads, 'thr_w', 0, w.opts)).state, 'failed', status);
    assert.equal(w.now() - start, 0, status);
  }
});

test('a turn that fails during the wait is followed while BB queues its retry a second later', async () => {
  const w = worker('active', [{ type: 'turn/started' }], null);
  w.state.script.push(() => { w.add('turn/completed', { status: 'failed' }); w.state.status = 'error'; },
    () => { w.state.queue = ['queued']; },
    () => { w.state.queue = []; w.add('turn/started'); w.state.status = 'active'; },
    () => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done'; });
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.deepEqual([r.state, r.output], ['idle', 'Done']);
});

test('a worker held before its first event is quiet since its creation, so the owner question still comes', async () => {
  const w = worker('pending', [], null);
  w.state.queue = ['waiting:thread-busy'];
  let r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  for (let i = 0; i < 5; i++) r = await waitWorker(w.threads, 'thr_w', r.seq, w.opts);
  assert.deepEqual([r.state, r.seq], ['working', 0]);
  assert.ok(r.quietForMs >= 480_000, String(r.quietForMs));
});

test('a thread still stopping is working until the event says which stop it was', async () => {
  const w = worker('stopping', [{ type: 'turn/started' }], null);
  w.state.script.push(() => { w.add('system/thread/interrupted', { reason: 'provider-turn-idle' }); w.state.status = 'idle'; });
  assert.equal((await waitWorker(w.threads, 'thr_w', 0, w.opts)).state, 'failed');
});

test('an old exhausted row does not make a later successful turn look failed', async () => {
  const w = worker('idle', done, 'Done: src/a.ts');
  w.state.queue = ['failed_exhausted'];
  const r = await waitWorker(w.threads, 'thr_w', 0, w.opts);
  assert.deepEqual([r.state, r.output], ['idle', 'Done: src/a.ts']);
});

test('a resume seen in the last read resets the quiet time', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.tickIdle(600_000);
  w.state.afterGet.push(() => undefined, () => { w.add('turn/started'); w.state.status = 'active'; });
  const r = await waitWorker(w.threads, 'thr_w', 2, w.opts);
  assert.equal(r.state, 'working');
  assert.ok(r.quietForMs < 480_000, String(r.quietForMs));
});

test('a failure seen while the report is read wins over the first verdict', async () => {
  const w = worker('idle', done, 'Done');
  w.state.afterOutput.push(() => { w.state.status = 'error'; });
  assert.equal((await waitWorker(w.threads, 'thr_w', 0, w.opts)).state, 'failed');
});
