/**
 * Waiting for a worker thread without gaps. The coordinator model used to poll with `bb thread wait` and
 * `bb thread output`; between two commands a worker could resume, finish or fail unseen (Antigravity ends a
 * turn while its tests run in the background and resumes by itself). Here every answer carries the event
 * cursor `seq`, and the next call looks at what happened after it, so nothing between calls is lost.
 *
 * BB's queue has many paused and held states (thread-busy, stopping, concurrency, approvals, superseded
 * retries…), and no rule built from them alone stays right. So the state rests on explicit facts only, and
 * `quietForMs` — time since the thread's newest event — bounds every case: whatever the state, a worker
 * that is not done and has been quiet long enough goes to the owner instead of being polled forever.
 */
import type { BbPluginApi } from '@get-bb/plugin-sdk';

type Threads = Pick<BbPluginApi['sdk']['threads'], 'get' | 'wait' | 'output' | 'events' | 'queuedMessages'>;
type Row = { seq: number | string; type: string; createdAt: number | string; data?: unknown };
type Queued = { state: string; waitingOn?: { kind: string } | null };
export type WorkerWait = {
  /** working: a turn runs, is on its way, or BB still holds a message for it; idle: its last turn ended;
   * stopped: someone stopped it by hand and nothing is left to run; failed: BB reports an error with no retry left. */
  state: 'working' | 'idle' | 'stopped' | 'failed';
  /** Pass as `--after` to the next call. */
  seq: number;
  /** A turn started after the previous cursor. */
  resumed: boolean;
  /** Time since the thread's newest event, whatever the state. */
  quietForMs: number;
  output: string | null;
};

// Any message BB may still run counts; only an exhausted or superseded one never will. quietForMs bounds the rest.
const live = (q: Queued[]) => q.some(m => m.state !== 'failed_exhausted' && m.waitingOn?.kind !== 'superseded');
const exhausted = (q: Queued[]) => q.some(m => m.state === 'failed_exhausted');
// pending and starting are a turn on its way, except a pending thread whose first prompt has exhausted its retries.
// stopping is a stop on its way, not a verdict: BB's start watchdog stops a turn too, and the event that follows says which.
const busy = (status: string, q: Queued[]) => status === 'active' || status === 'starting' || status === 'stopping' || (status === 'pending' && !(exhausted(q) && !live(q)));
const reason = (row?: Row) => (row?.data as { reason?: string } | undefined)?.reason;

type Options = { budgetMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

/** One answer within `budgetMs`, so a CLI call never hits BB's command timeout. */
export async function waitWorker(threads: Threads, threadId: string, after: number,
  { budgetMs = 90_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: Options = {}): Promise<WorkerWait> {
  const deadline = now() + budgetMs;
  const left = () => Math.max(0, deadline - now());
  const queue = async () => await threads.queuedMessages.list({ threadId }) as Queued[];
  const startedAfter = async () => (await threads.events.list({ threadId, afterSeq: String(after), types: ['turn/started'], order: 'asc', limit: '1' }) as Row[]).length > 0;

  // Wait until the state settles or the budget runs out.
  for (let first = true; left() > 0; first = false) {
    const [thread, q] = await Promise.all([threads.get({ threadId }), queue()]);
    if (busy(thread.status, q) || live(q)) {
      const before = now();
      await threads.wait({ threadId, status: 'idle', timeoutMs: left() }).catch(() => undefined);
      // A paused queue row keeps the thread idle while BB holds it: re-checking it each second would only spin.
      if (now() - before < 1000 && left() > 0) await sleep(Math.min(1000, left()));
    } else if (thread.status === 'error' && !exhausted(q)) await sleep(Math.min(1000, left()));  // BB may queue its retry a moment later
    else if (first && thread.status === 'idle' && !exhausted(q) && !(await startedAfter())) {
      // Idle since the last look: give it the budget to resume by itself.
      if (!await threads.events.wait({ threadId, afterSeq: String(after), type: 'turn/started', waitMs: String(left()) })) break;
    } else break;
  }

  // The cursor is taken before the state is read: anything that happens after it is seen by the next call.
  const [last] = await threads.events.list({ threadId, order: 'desc', limit: '1' }) as Row[];
  const seq = Math.max(after, Number(last?.seq ?? 0));
  const read = async () => {
    const [thread, q] = await Promise.all([threads.get({ threadId }), queue()]);
    const newest = async (type: 'turn/started' | 'turn/completed' | 'system/thread/interrupted') => (await threads.events.list({ threadId, types: [type], order: 'desc', limit: '1' }) as Row[])[0];
    const [start, end, interrupt] = await Promise.all((['turn/started', 'turn/completed', 'system/thread/interrupted'] as const).map(newest));
    return { thread, q, start, end, interrupt };
  };
  const n = (row?: Row) => Number(row?.seq ?? 0);
  const judge = ({ thread, q, start, end, interrupt }: Awaited<ReturnType<typeof read>>): WorkerWait['state'] => {
    if (busy(thread.status, q) || live(q)) return 'working';
    // A stop newer than the last finished turn stays a stop, even if a late start of the cancelled turn arrives.
    const lastStop = n(interrupt) > n(end) ? interrupt : undefined;
    if (lastStop && reason(lastStop) === 'manual-stop') return 'stopped';
    // Any other interruption (provider-turn-idle, a host restart) is a failed run the coordinator retries.
    // An exhausted row is a failure only before any turn finished: an old one must not spoil a later successful turn.
    if (lastStop || thread.status === 'error' || (exhausted(q) && !end)) return 'failed';
    // A turn the provider cancelled without BB's manual stop is a failed run, retried like any other.
    if (end && (end.data as { status?: string } | undefined)?.status === 'interrupted') return 'failed';
    return n(start) > seq && n(start) > n(end) ? 'working' : 'idle';
  };
  const before = await read();
  let state = judge(before);
  let output: string | null = null;
  let latest = before;
  if (state !== 'working') {
    output = (await threads.output({ threadId })).output;
    // The report must belong to the turn judged above: a turn that started meanwhile makes it someone else's.
    latest = await read();
    const again = judge(latest);
    if (again === 'working' || n(latest.start) > n(before.start)) { state = 'working'; output = null; }
    else state = again;  // a failure or stop that appeared meanwhile wins over the first verdict
  }
  // Quiet since the newest thing seen, including a turn that started during the last read; a thread with no event yet
  // is quiet since it was created, so a worker held before its first event still reaches the owner.
  const seen = Math.max(Number(last?.createdAt ?? 0), ...[latest.start, latest.end, latest.interrupt].map(row => Number(row?.createdAt ?? 0)));
  const quietForMs = Math.max(0, now() - (seen || Number((latest.thread as { createdAt?: number }).createdAt ?? now())));
  // resumed comes from the same last read as the state, so the two never disagree.
  return { state, seq, resumed: n(latest.start) > after, quietForMs, output };
}
