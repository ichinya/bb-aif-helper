import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { contextBlock, researchBlock } from '../delegation.ts';

// The coordinator works on Windows here: every value reaches BB and the folder's machine as data, never through a shell.
const ROOT = 'C:\\Users\\Dev User\\репо';
async function setup() {
  let choice: any = { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast', parallel: 2 };  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  const calls: { method: string; input: any; hostId: string }[] = [];  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  const spawns: any[] = [];  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  let keepRunning = false;
  const threads: Record<string, any> = {
    thr_test: makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } }),
    thr_worker: { ...makeThreadResponse({ id: 'thr_worker', projectId: 'proj_test', environmentId: 'env_worker', status: 'idle', runtime: { displayStatus: 'idle' } }), parentThreadId: 'thr_test' },
    thr_other: { ...makeThreadResponse({ id: 'thr_other', projectId: 'proj_test', environmentId: 'env_worker', status: 'idle', runtime: { displayStatus: 'idle' } }), parentThreadId: 'thr_x' },
  };
  const envs: Record<string, any> = {
    env_test: { id: 'env_test', projectId: 'proj_test', path: ROOT, hostId: 'host_win', status: 'ready', lifecycle: { phase: 'active' } },
    env_worker: { id: 'env_worker', projectId: 'proj_test', path: 'C:\\Users\\Dev User\\.bb-aif-helper\\worktrees\\r-1\\demo-2-x', hostId: 'host_win', environmentProviderId: 'aif-chat-worktree', status: 'ready', lifecycle: { phase: 'active' } },
  };
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat', 'aif-scout'], experimental_hostEntry: true,
    sdk: {
      // Each spawn gets its own id, readable afterwards, as BB answers; most tests archive it at once, so the limit never bites.
      threads: { get: async ({ threadId }: any) => { if (!threads[threadId]) throw new Error('not found'); return threads[threadId]; }, // list filters as BB does: children of a parent, spawned by a plugin, archived ones left out on request.
        list: async (a: any = {}) => Object.values(threads).filter(t => (!a.parentThreadId || t.parentThreadId === a.parentThreadId) && (!a.originPluginId || t.originPluginId === a.originPluginId) && (a.archived !== false || !t.archivedAt)),
        spawn: async (args: any) => { spawns.push(args); const id = spawns.length === 1 ? 'thr_new' : `thr_new${spawns.length}`; threads[id] = { ...threads.thr_test, id, title: args.title, parentThreadId: 'thr_test', originPluginId: 'aif-chat', environmentId: `env_copy${spawns.length}`, archivedAt: keepRunning ? null : 'archived' }; return threads[id]; },
        // thr_worker finished one turn: started at seq 1, completed at seq 2.
        events: { list: async ({ afterSeq = '0', types, order, limit }: any) => { let rows = [{ seq: 1, type: 'turn/started', createdAt: 0 }, { seq: 2, type: 'turn/completed', createdAt: 0, data: { status: 'completed' } }].filter(e => e.seq > Number(afterSeq) && (!types || types.includes(e.type))); if (order === 'desc') rows = rows.reverse(); return limit ? rows.slice(0, Number(limit)) : rows; },
          wait: async () => null },
        wait: async () => ({}), output: async () => ({ output: 'Done: src/b.ts' }), queuedMessages: { list: async () => [] } } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
      environments: { get: async ({ environmentId }: any) => envs[environmentId] } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
    },
    experimental_callHostRpc: async call => {
      calls.push({ method: call.method, input: call.input, hostId: call.hostId });
      if (call.method === 'collect') throw new Error('not needed');
      if (call.method === 'delegation') return { choice, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null } as any;  // guardian: allow — loose mock of the BB SDK and host RPC in this test
      if (call.method === 'readBrief') return { text: 'Do task 2.' };
      if (call.method === 'headCommit') return { sha: 'c'.repeat(40) };
      if (call.method === 'bringBack') return { applied: true, files: ['src/b.ts'] };
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { h, calls, spawns, threads, setChoice: (c: any) => { choice = c; }, keepWorkers: () => { keepRunning = true; } };
}

test('spawn-worker starts the owner model on a fresh copy seeded with the coordinator\'s work, as a child of the chat', async () => {
  const { h, spawns } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '2', '--brief', 'C:\\Temp\\brief 2.md', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout!).id, 'thr_new');
    const [args] = spawns;
    assert.equal(args.environment.type, 'provider');
    assert.equal(args.environment.environmentProviderId, 'aif-chat-worktree');
    assert.equal(args.environment.inputs.basePath, ROOT, 'a Windows path with a space and Cyrillic arrives as is');
    assert.equal(args.environment.inputs.ref, 'c'.repeat(40));
    assert.equal(args.environment.inputs.seed, true, 'the copy gets the uncommitted work of earlier tasks');
    assert.match(args.prompt, /Change files only: do not run git commands that change the index/);
    assert.match(args.environment.inputs.name, /^demo-2-[0-9a-f]{8}$/);
    assert.deepEqual(args.environment.machine, { type: 'existing', hostId: 'host_win' });
    assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ['codex', 'gpt-6.2-sol', 'high', 'fast']);
    // BB drops a provider or model without a provenance source and falls back to the provider default (Lane Pilot workers ran on Flash).
    assert.deepEqual(args.executionInputSources, { providerId: 'explicit', model: 'explicit', reasoningLevel: 'explicit', serviceTier: 'explicit' });
    assert.deepEqual([args.parentThreadId, args.lifecycleOwnerThreadId, args.parentNotifications], ['thr_test', 'thr_test', 'off']);
    assert.match(args.prompt, /^Do task 2\.[\s\S]*Do not commit\.$/);
    // A retry gets its own copy name.
    await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '2', '--brief', 'C:\\Temp\\brief 2.md']);
    assert.notEqual(spawns[1].environment.inputs.name, args.environment.inputs.name);
    // A nested task id, as the plan card reads `Task 1.2`, is accepted; anything else is refused before a spawn.
    const nested = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '1.2', '--brief', 'C:\\Temp\\brief 2.md']);
    assert.equal(nested.exitCode, 0, nested.stderr);
    assert.match(spawns[2].environment.inputs.name, /^demo-1\.2-[0-9a-f]{8}$/);
    assert.equal(spawns[2].title, 'AIF · demo · 1.2');
    // Models write the id as `task-3`, `Task 3` or `#3`: the number is what counts.
    for (const [i, loose] of ['task-3', 'Task 3', '#3', ' TASK_3 '].entries()) {
      const ok = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', loose, '--brief', 'C:\\Temp\\brief 2.md']);
      assert.equal(ok.exitCode, 0, loose);
      assert.equal(spawns[3 + i].title, 'AIF · demo · 3', loose);
    }
    for (const bad of ['1.', '.2', '1..2', '1 2', 'a', 'task', 'task-', 'task-a', '-3', '_3', '--3', 'task--3', 'task -3', '#-3']) {
      const refused = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', bad, '--brief', 'C:\\Temp\\brief 2.md']);
      assert.notEqual(refused.exitCode, 0, bad);
    }
    assert.equal(spawns.length, 7);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('bring-back takes only a worker of this chat, in an AI Factory copy on the same machine', async () => {
  const { h, calls } = await setup();
  try {
    const ok = await h.harness.behavior.runCli(['bring-back', '--thread', 'thr_test', '--worker', 'thr_worker', '--json']);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.deepEqual(calls.find(c => c.method === 'bringBack')!.input, { root: ROOT, copy: 'C:\\Users\\Dev User\\.bb-aif-helper\\worktrees\\r-1\\demo-2-x' });
    const foreign = await h.harness.behavior.runCli(['bring-back', '--thread', 'thr_test', '--worker', 'thr_other']);
    assert.equal(foreign.exitCode, 1);
    assert.match(foreign.stderr ?? '', /не исполнитель этого чата/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a coordinator with the old block calling groups or checkpoint gets an error and falls back to one worker', async () => {
  const { h, calls } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--max', '2', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(JSON.parse(result.stdout!).error, /groups удалена/);
    const old = await h.harness.behavior.runCli(['checkpoint', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--group', '1', '--json']);
    assert.match(JSON.parse(old.stdout!).error, /checkpoint удалена/);
    assert.equal(calls.length, 0, 'nothing is read or changed on the machine');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('wait-worker answers for a child of this chat only, with the cursor for the next call', async () => {
  const { h } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_worker', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const answer = JSON.parse(result.stdout!);
    assert.deepEqual([answer.state, answer.seq, answer.resumed, answer.output], ['idle', 2, true, 'Done: src/b.ts']);
    const foreign = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_other', '--json']);
    assert.match(`${foreign.stdout ?? ''}${foreign.stderr ?? ''}`, /не исполнитель этого чата/);
    for (const bad of ['-1', '1.5', 'x']) {
      const refused = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_worker', '--after', bad, '--json']);
      assert.match(`${refused.stdout ?? ''}${refused.stderr ?? ''}`, /--after/, bad);
    }
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a worker never inherits the coordinator\'s service tier: no tier in the Code role means default', async () => {
  const { h, spawns, setChoice } = await setup();
  try {
    setChoice({ mode: 'bb', providerId: 'acp-antigravity', model: 'gemini-4-hydrogen', reasoning: 'high', parallel: 4 });
    const result = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', 'demo', '--task', '1', '--brief', 'C:\\Temp\\brief.md', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(spawns[0].serviceTier, 'default');
    assert.equal(spawns[0].executionInputSources.serviceTier, 'explicit');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('spawn-worker reads the setting at each launch: parallel off or the limit reached refuses, even for two launches at once', async () => {
  const { h, spawns, threads, setChoice, keepWorkers } = await setup();
  keepWorkers();
  const spawn = (task: string) => h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', 'demo', '--task', task, '--brief', 'C:\\Temp\\brief.md', '--json']);
  try {
    setChoice({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
    const off = await Promise.all([spawn('1'), spawn('2')]);
    assert.deepEqual(off.map(r => r.exitCode), [1, 1]);
    assert.match(off[0].stderr ?? '', /Параллельный режим выключен/);
    assert.equal(spawns.length, 0, 'no worker starts after the owner turned parallel off');

    setChoice({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', parallel: 2 });
    const three = await Promise.all([spawn('1'), spawn('2'), spawn('3')]);
    assert.deepEqual(three.map(r => r.exitCode), [0, 0, 1], 'launched at once, the third waits for a slot');
    assert.match(three[2].stderr ?? '', /Уже запущено исполнителей: 2 из 2/);
    // A worker renamed by hand still holds its slot; other children of the chat (one-worker flow, research) hold none.
    threads.thr_new.title = 'Fix test fixtures';
    assert.equal((await spawn('3')).exitCode, 1);
    // Archiving a finished worker frees its slot; a deleted one does too.
    threads.thr_new.archivedAt = '2026-11-26T00:00:00Z';
    assert.equal((await spawn('3')).exitCode, 0);
    delete threads.thr_new2;
    assert.equal((await spawn('4')).exitCode, 0);
    assert.equal(spawns.length, 4);
    // A worker restored from the archive takes its slot back.
    threads.thr_new.archivedAt = null;
    assert.match((await spawn('5')).stderr ?? '', /Уже запущено исполнителей: 3 из 2/);
    // A worker an older plugin version started, with nothing recorded about it here, counts too.
    for (const id of ['thr_new', 'thr_new3', 'thr_new4']) delete threads[id];
    threads.thr_old = { ...threads.thr_test, id: 'thr_old', parentThreadId: 'thr_test', originPluginId: 'aif-chat', archivedAt: null };
    assert.equal((await spawn('5')).exitCode, 0);
    assert.equal((await spawn('6')).exitCode, 1, 'the old worker and the new one fill the two slots');
  } finally { await h.harness.lifecycle.dispose(); }
});

// Every way a worker starts — spawn-worker on the server, the one-worker command and the research lines of the blocks —
// launches the same provider, model, reasoning and tier: a fix in one path alone (188c9e6) shows up here.
test('spawn-worker and the commands in the blocks start a worker with the same provider, model, reasoning and tier', async () => {
  const flags = (text: string) => [...text.matchAll(/--provider '([^']*)' --model '([^']*)'(?: --reasoning-level '([^']*)')? --service-tier '([^']*)'/g)]
    .map(m => ({ providerId: m[1], model: m[2], reasoningLevel: m[3] ?? null, serviceTier: m[4] }));
  const choices = [
    { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' },
    { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', tier: 'default' },
    { mode: 'bb' as const, providerId: 'acp-antigravity', model: 'gemini-4-carbon' },
  ];
  for (const choice of choices) {
    const { h, spawns, setChoice } = await setup();
    try {
      setChoice({ ...choice, parallel: 2 });
      const r = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', 'demo', '--task', '1', '--brief', 'C:\\Temp\\brief.md', '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      const server = { providerId: spawns[0].providerId, model: spawns[0].model, reasoningLevel: spawns[0].reasoningLevel ?? null, serviceTier: spawns[0].serviceTier };
      const oneWorker = flags(contextBlock({ ...choice, parallel: 2 }));
      const research = flags(researchBlock({ research: choice, research2: { mode: 'self' }, research3: { mode: 'self' } })!);
      assert.ok(oneWorker.length > 0 && research.length > 0, 'both blocks carry a spawn command');
      for (const f of [...oneWorker, ...research]) assert.deepEqual(f, server, `${choice.providerId}/${choice.model} tier=${choice.tier ?? '—'}`);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});
