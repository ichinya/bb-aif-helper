import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import type { ExperimentalHostRpcContext, ExperimentalHostWatchEvent } from '@get-bb/plugin-sdk';
import { hostContract, hostSignals } from './contract.ts';
import { collectSnapshot } from './reader.ts';
import { readDelegation, writeDelegation } from './delegation.ts';
import { savePlanDocument, markPlanVerified } from './plan-document.ts';
import { WATCH_IGNORED, relevantChange } from './live-updates.ts';
import { createWorktree, removeWorktree } from './worktree.ts';
import { bringBack, headCommit, readBrief } from './parallel-git.ts';

type Subscription = { dispose(): Promise<void> };
type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;
type WatchEntry = { subs: Subscription[]; dirs: Set<string> };
const watches = new Map<string, WatchEntry>();
const disposeAll = (subs: Subscription[] | undefined) => Promise.all((subs ?? []).map(sub => sub.dispose().catch(() => {})));
const WATCH_OPTIONS = { debounceMs: 300, maxWaitMs: 1000 };
// BB shares one native watcher per directory: when BB's own workspace watcher on the same root
// skips a git-ignored directory (.ai-factory/, .bb/), a root subscription never sees changes
// there. A second subscription rooted at the directory itself does.
const SEPARATE_DIRS = ['.ai-factory', '.bb/aif-helper'];

const watchListener = (root: string, context: HostContext) =>
  async (event: ExperimentalHostWatchEvent, base: string) => {
    try {
        if (event.kind === 'changed') {
          const relevant = event.changes.some(change => {
            const rel = path.isAbsolute(change.path) ? path.relative(root, change.path) : path.join(path.relative(root, base), change.path);
            return relevantChange(rel);
          });
          if (relevant) await context.experimental_emitSignal('filesChanged', { root });
        } else if (event.kind === 'rescan-required') {
          await context.experimental_emitSignal('filesChanged', { root });
        } else {
          const current = watches.get(root);
          watches.delete(root);
          await disposeAll(current?.subs);
          await context.experimental_emitSignal('watchLost', { root, reason: event.message.slice(0, 500) });
        }
      } catch { /* signal delivery must not escape the watcher listener */ }
  };

const isDirectory = (target: string) => stat(target).then(st => st.isDirectory(), () => false);

// A separate dir can appear after watch (savePlan creates .bb/aif-helper/): subscribe it then.
// Best-effort — the plan is already saved, so a watch failure must not fail the RPC.
const addSeparateWatches = async (root: string, context: HostContext) => {
  let key = root;
  let entry = watches.get(key);
  if (!entry) {
    const real = await realpath(root).catch(() => null);
    if (real && real !== key) { key = real; entry = watches.get(key); }
  }
  if (!entry) return;
  const listener = watchListener(key, context);
  for (const dir of SEPARATE_DIRS) {
    const full = path.join(key, dir);
    if (entry.dirs.has(dir) || !await isDirectory(full)) continue;
    try {
      const sub = await context.experimental_watch({ rootPath: full, ...WATCH_OPTIONS }, event => listener(event, full));
      if (watches.get(key) !== entry) { await sub.dispose().catch(() => {}); break; }
      entry.subs.push(sub);
      entry.dirs.add(dir);
    } catch { /* retried on the next savePlan */ }
  }
};

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    collect: async (input, context) => {
      // The agent reads the delegation blocks straight from skill-context; keep them current after a plugin update.
      await readDelegation(input.root).catch(() => undefined);
      return collectSnapshot(input, context.signal);
    },
    delegation: input => readDelegation(input.root),
    setDelegation: input => writeDelegation(input.root, input.choice, input.role),
    savePlan: async (input, context) => {
      const result = await savePlanDocument(input);
      await addSeparateWatches(input.root, context);
      return result;
    },
    markPlanVerified: input => markPlanVerified(input),
    createWorktree: input => createWorktree(input),
    removeWorktree: input => removeWorktree(input),
    headCommit: input => headCommit(input),
    bringBack: input => bringBack(input),
    readBrief: input => readBrief(input),
    watch: async (input, context) => {
      const root = input.root;
      if (watches.has(root)) return { ok: true as const };
      const listener = watchListener(root, context);
      const subs: Subscription[] = [await context.experimental_watch({ rootPath: root, ignoredPaths: WATCH_IGNORED, ...WATCH_OPTIONS }, event => listener(event, root))];
      const dirs = new Set<string>();
      try {
        for (const dir of SEPARATE_DIRS) {
          const full = path.join(root, dir);
          if (await isDirectory(full)) {
            subs.push(await context.experimental_watch({ rootPath: full, ...WATCH_OPTIONS }, event => listener(event, full)));
            dirs.add(dir);
          }
        }
      } catch (error) { await disposeAll(subs); throw error; }
      watches.set(root, { subs, dirs });
      return { ok: true as const };
    },
    unwatch: async input => {
      const current = watches.get(input.root);
      if (current) {
        watches.delete(input.root);
        await disposeAll(current.subs);
      }
      return { ok: true as const };
    },
  },
  dispose: async () => {
    const pending = [...watches.values()];
    watches.clear();
    await Promise.all(pending.map(entry => disposeAll(entry.subs)));
  },
});
