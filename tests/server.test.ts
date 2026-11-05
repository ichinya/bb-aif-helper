import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { cardDirective } from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import { VERSION_TTL } from '../versions.ts';

async function setup() {
  let value = snapshot(); value.actions = workflowActions(value);
  let sends = 0;
  let failSend = false;
  let pending = 0;
  let output: string | null = null;
  let events: any[] = [];
  let collections = 0;
  let collectBlock: Promise<void> | null = null;
  let collectFailure = false;
  const hostInputs: any[] = [];
  let thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, events: { list: async (args: any) => { assert(Number(args.limit) <= 100); return events; } }, output: async () => ({ output }), send: async () => { sends++; if (failSend) throw new Error('lost connection'); return {} as any; }, interactions: { list: async () => Array.from({ length: pending }, () => ({})) as any } },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async ({ input }) => { collections++; hostInputs.push(structuredClone(input)); if (collectBlock) await collectBlock; if (collectFailure) throw new Error('host unavailable'); return structuredClone(value); },
  });
  await plugin(h.bb);
  return { ...h, get value() { return value; }, set value(v) { value = v; }, get sends() { return sends; },
    get collections() { return collections; }, setCollectBlock(block: Promise<void> | null) { collectBlock = block; },
    get hostInputs() { return hostInputs; }, setCollectFailure(fails: boolean) { collectFailure = fails; },
    setEvents(rows: any[]) { events = rows; }, setOutput(text: string | null) { output = text; }, setQueued(count: number) { thread = { ...thread, queuedMessageCount: count }; },
    setFailure(v: boolean) { failSend = v; }, setPending(v: number) { pending = v; }, setActive(v: boolean) { thread = { ...thread, status: v ? 'active' : 'idle', runtime: { displayStatus: v ? 'active' : 'idle' } }; } };
}
function runInput(fingerprint = 'a'.repeat(64)) { return { threadId: 'thr_test', target: '.ai-factory/plans/demo.md', phase: 'plan', fingerprint, actionId: 'improve', requestId: randomUUID() }; }

test('version probes are cached for a day across force requests and plugin reload, then expire', async () => {
  const h = await setup(); let live = h.harness; let api = h.bb;
  try {
    h.value.upstream = { ...h.value.upstream, version: '2.21.0' };
    const request = { threadId: 'thr_test', phase: 'plan', force: true, checkUpdates: true };
    const first = await live.behavior.callRpc('status', request) as any;
    assert.equal(h.hostInputs[0].checkUpdates, true); assert.equal(h.hostInputs[0].cachedVersions, null);
    await live.behavior.callRpc('status', request);
    assert.equal(h.hostInputs[1].checkUpdates, false); assert(h.hostInputs[1].cachedVersions);
    const next = await live.lifecycle.reload(plugin); live = next.harness; api = next.bb;
    await live.behavior.callRpc('status', request);
    assert.equal(h.hostInputs[2].checkUpdates, false); assert(h.hostInputs[2].cachedVersions);
    api.storage.database().prepare('UPDATE local_versions SET at = ?').run(Date.now() - VERSION_TTL - 1);
    await api.storage.kv.set('upstream:host_test:lee-to/ai-factory:', { ...first.upstream, checkedAt: new Date(Date.now() - VERSION_TTL - 1).toISOString() });
    await live.behavior.callRpc('status', request);
    assert.equal(h.hostInputs[3].checkUpdates, true); assert.equal(h.hostInputs[3].cachedVersions, null);
  } finally { await live.lifecycle.dispose(); }
});

test('a failed remote version attempt still enforces the daily retry interval', async () => {
  const h = await setup(); try {
    h.setCollectFailure(true);
    await assert.rejects(h.harness.behavior.callRpc('status', { threadId: 'thr_test', checkUpdates: true }));
    h.setCollectFailure(false);
    const next = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', checkUpdates: true }) as any;
    assert.equal(h.hostInputs[0].checkUpdates, true); assert.equal(h.hostInputs[1].checkUpdates, false);
    assert(next.upstream.checkedAt); assert(next.upstream.error);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('explicit maintenance invalidates local version samples without bypassing remote limits', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'update-factory' });
    assert(h.hostInputs[1].cachedVersions);
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    assert.equal(h.hostInputs[2].cachedVersions, null);
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: null });
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    assert.equal(h.hostInputs[3].cachedVersions, null);
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    assert(h.hostInputs[4].cachedVersions); assert(h.hostInputs.every(input => !input.checkUpdates));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('invalid selection exposes a guarded updater RPC without enabling ordinary workflow', async () => {
  const h = await setup(); try {
    h.value = { ...h.value, profile: 'invalid', target: null };
    const value = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan', force: true }) as any;
    assert.deepEqual(value.actions.map((a: any) => a.id), ['update-factory']);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()));
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'update-factory' });
    assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('cards with different phases share a scan; force and action dispatch still re-read the host', async () => {
  const h = await setup(); try {
    const [plan, verify] = await Promise.all([
      h.harness.behavior.callRpc('status', { threadId: 'thr_test', target: runInput().target, phase: 'plan' }),
      h.harness.behavior.callRpc('status', { threadId: 'thr_test', target: runInput().target, phase: 'verify' }),
    ]) as any[];
    assert.equal(h.collections, 1); assert.equal(plan.phase, 'plan'); assert.equal(verify.phase, 'verify');
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', target: runInput().target });
    assert.equal(h.collections, 1);
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', target: runInput().target, force: true });
    assert.equal(h.collections, 2);
    h.value.fingerprint = 'b'.repeat(64);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()));
    assert.equal(h.collections, 3); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('SQLite snapshot is returned after plugin reload while the host revalidates in the background', async () => {
  const h = await setup(); let live = h.harness; let release!: () => void;
  try {
    await live.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    live = (await live.lifecycle.reload(plugin)).harness;
    h.setCollectBlock(new Promise<void>(resolve => { release = resolve; }));
    const saved = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(saved.cache.source, 'saved'); assert.equal(saved.cache.refreshing, true); assert.equal(h.collections, 2);
    h.setCollectBlock(null); release();
  } finally { release?.(); await live.lifecycle.dispose(); }
});

test('a live completed gate blocks unchanged checks across reload and re-enables them after input changes', async () => {
  const h = await setup(); let live = h.harness;
  try {
    h.value.inputsFingerprint = 'c'.repeat(64);
    h.value.checks = [{ id: 'verify', label: 'Verify', state: 'notrun', path: null, detail: 'Missing', required: false }];
    const text = gateText({ affected_files: ['.ai-factory/plans/demo.md'] });
    h.setEvents([{ seq: 31, createdAt: Date.now(), type: 'item/completed', data: { item: { type: 'agentMessage', text } } }]);
    const historical = await live.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(historical.checks[0].chat.freshness, 'unknown');
    await live.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: text });
    const done = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(done.checks[0].chat.freshness, 'unchanged');
    assert.equal(done.actions.find((a: any) => a.id === 'check-verify').disabledReason, 'unchanged');
    await assert.rejects(live.behavior.callRpc('run', { ...runInput(), actionId: 'check-verify' }));
    h.setOutput('$aif-verify');
    const suggestion = await live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(suggestion.items[0].available, false);
    await assert.rejects(live.behavior.callRpc('runSuggestion', suggestionInput(suggestion, 'aif-verify')));
    live = (await live.lifecycle.reload(plugin)).harness;
    const restored = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(restored.checks[0].chat.freshness, 'unchanged');
    h.value.inputsFingerprint = 'd'.repeat(64); h.value.fingerprint = 'd'.repeat(64);
    await live.behavior.emitThreadEvent('thread.active', { thread: makeThreadResponse({ id: 'thr_test' }) });
    const changed = await live.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(changed.checks[0].chat.freshness, 'changed');
    assert.equal(changed.actions.find((a: any) => a.id === 'check-verify').available, true);
    // A duplicate idle announcement cannot rebind an old result to the new inputs.
    await live.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: text });
    await live.behavior.callRpc('run', { ...runInput('d'.repeat(64)), actionId: 'check-verify' });
    assert.equal(h.sends, 1);
  } finally { await live.lifecycle.dispose(); }
});

test('old results and unavailable input hashes never lock repeat checks', async () => {
  const h = await setup(); try {
    h.value.inputsFingerprint = 'c'.repeat(64);
    h.value.checks = [{ id: 'verify', label: 'Verify', state: 'notrun', path: null, detail: '', required: false }];
    const text = gateText({ affected_files: ['.ai-factory/plans/demo.md'] });
    h.setEvents([{ seq: 7, createdAt: Date.now() - 120000, type: 'item/completed', data: { item: { type: 'agentMessage', text } } }]);
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: text });
    const s = await h.harness.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(s.checks[0].chat.freshness, 'unknown');
    assert.equal(s.actions.find((a: any) => a.id === 'check-verify').available, true);
    h.value.inputsFingerprint = null;
    h.setEvents([{ seq: 8, createdAt: Date.now(), type: 'item/completed', data: { item: { type: 'agentMessage', text } } }]);
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: text });
    await h.harness.behavior.emitThreadEvent('thread.active', { thread: makeThreadResponse({ id: 'thr_test' }) });
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'check-verify' });
    assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('status restores completed verify from chat, persists across reload and does not invent file evidence', async () => {
  const h = await setup(); let live = h.harness;
  try {
    h.value.checks = [{ id: 'verify', label: 'Verify', state: 'notrun', path: null, detail: 'Missing', required: false }];
    h.setEvents([{ seq: 12, createdAt: Date.now(), type: 'item/completed', data: { item: { type: 'agentMessage', text: gateText({ affected_files: ['.ai-factory/plans/demo.md'] }) } } }]);
    const first = await live.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(first.checks[0].chat.result.status, 'warn'); assert.equal(first.checks[0].state, 'notrun');
    h.setEvents([]); h.setOutput('Later answer without a gate');
    live = (await live.lifecycle.reload(plugin)).harness;
    const restored = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(restored.checks[0].chat.seq, 12); assert.equal(h.sends, 0);
    h.value = { ...h.value, root: '/different-checkout' };
    live = (await live.lifecycle.reload(plugin)).harness;
    const other = await live.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(other.checks[0].chat, undefined);
  } finally { await live.lifecycle.dispose(); }
});

test('native status tool returns one directive and never dispatches a model', async () => {
  const h = await setup(); try {
    const result = await h.harness.behavior.callAgentTool('aif_chat_status', { phase: 'plan' }, { threadId: 'thr_test', projectId: 'proj_test' } as any);
    assert.match(JSON.stringify(result), /previewDirective/); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('button sends exactly to selected thread with current plan and no permission/model override', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('run', runInput()); assert.equal(h.sends, 1);
    const calls = h.harness.inspection.sdk.callsTo('threads.send');
    assert.equal(calls.length, 1);
    assert.match(JSON.stringify(calls[0]), /thr_test/); assert.match(JSON.stringify(calls[0]), /aif-improve/);
    const sent = calls[0][0] as any;
    assert.deepEqual(sent.input.filter((part: any) => part.visibility !== 'agent-only').map((part: any) => part.text), ['$aif-improve "@.ai-factory/plans/demo.md"']);
    const hidden = sent.input.find((part: any) => part.visibility === 'agent-only');
    assert.match(hidden.text, /expectedFingerprint/); assert.match(hidden.text, /Не расширяй scope/);
    assert(!JSON.stringify(calls[0]).includes('permissionMode')); assert(!JSON.stringify(calls[0]).includes('model'));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('basic exploration and installation are click-only scoped prompts without invoking missing skills', async () => {
  for (const actionId of ['basic-explore', 'basic-install']) {
    const h = await setup(); try {
      h.value = snapshot({ configured: false, profile: 'none', phase: 'unknown', target: null, candidates: [], skills: [] });
      const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
      assert.equal(h.sends, 0);
      const input = { ...runInput(view.fingerprint), phase: 'unknown', target: '', actionId };
      h.setPending(1); await assert.rejects(h.harness.behavior.callRpc('run', input)); h.setPending(0);
      h.setActive(true); await assert.rejects(h.harness.behavior.callRpc('run', input)); h.setActive(false);
      await h.harness.behavior.callRpc('run', input);
      const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
      assert(sent.input[0].text.startsWith('BB AIF Helper:'));
      assert.equal(sent.input[1].visibility, 'agent-only');
      if (actionId === 'basic-explore') {
        assert.match(sent.input[1].text, /Исследуй текущую задачу/); assert(!sent.input[1].text.includes('npm install'));
      } else assert.match(sent.input[1].text, /ai-factory init --agents codex-app/);
      assert.equal(h.sends, 1);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('basic advancement obeys the last gate and cannot execute without its selected plan', async () => {
  const h = await setup(); try {
    const plan = { path: '.bb-aif-helper/plans/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const, tasks: [{ id: '1', title: 'Work', done: false }] };
    h.value = snapshot({ configured: false, profile: 'none', phase: 'unknown', skills: [], target: plan, candidates: [{ ...plan }], worktree: { hasUncommitted: true } });
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    const input = { ...runInput(view.fingerprint), phase: 'unknown', target: plan.path };
    h.setOutput(gateText({ status: 'fail', blocking: true, blockers: [{ id: '1', severity: 'error', summary: 'Blocked.' }], suggested_next: null }));
    for (const actionId of ['basic-implement', 'basic-commit']) {
      await assert.rejects(h.harness.behavior.callRpc('run', { ...input, actionId }));
    }
    h.setOutput(null); h.value.target = null; h.value.candidates = [];
    await assert.rejects(h.harness.behavior.callRpc('run', { ...input, actionId: 'basic-implement' }));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('successful installation releases only the basic UI selection and activates the installed workflow', async () => {
  const h = await setup(); try {
    const plan = { path: '.bb-aif-helper/plans/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const, tasks: [{ id: '1', title: 'Work', done: false }] };
    h.value = snapshot({ configured: false, profile: 'none', phase: 'unknown', skills: [], target: plan, candidates: [{ ...plan }] });
    await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--target', plan.path]);
    assert(await h.bb.storage.kv.get('selection:thr_test'));
    h.value = snapshot({ phase: 'unknown', target: null, candidates: [] });
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(view.profile, 'upstream'); assert(!view.actions.some((a: any) => a.id.startsWith('basic-')));
    assert.equal(await h.bb.storage.kv.get('selection:thr_test'), undefined);
    assert.equal(h.hostInputs.at(-1).target, ''); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('commit after archive rechecks files, active work and the last gate before sending a scoped request', async () => {
  const h = await setup(); try {
    h.value = snapshot({ profile: 'aifhub-openspec', phase: 'done', target: null, candidates: [], worktree: { hasUncommitted: true } });
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'done', force: true }) as any;
    assert.equal(view.actions[0].id, 'commit'); assert.equal(h.sends, 0);
    const input = { ...runInput(view.fingerprint), target: '', phase: 'done', actionId: 'commit' };
    h.setActive(true); await assert.rejects(h.harness.behavior.callRpc('run', input));
    h.setActive(false); h.setPending(1); await assert.rejects(h.harness.behavior.callRpc('run', input)); h.setPending(0);
    h.setOutput(gateText({ status: 'fail', blocking: true, blockers: [{ id: 'security', severity: 'error', summary: 'Blocked.' }],
      suggested_next: { command: '/aif-fix', reason: 'Fix first.' } }));
    await assert.rejects(h.harness.behavior.callRpc('run', input)); assert.equal(h.sends, 0);
    h.setOutput('Sync completed.');
    h.value.worktree.hasUncommitted = false;
    await assert.rejects(h.harness.behavior.callRpc('run', input)); assert.equal(h.sends, 0);
    h.value.worktree.hasUncommitted = true;
    await h.harness.behavior.callRpc('run', input);
    const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.equal(sent.input[0].text, '$aif-commit');
    assert.match(sent.input[1].text, /сохрани несвязанные изменения/); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('stale card is rejected before dispatch', async () => {
  const h = await setup(); try {
    await assert.rejects(h.harness.behavior.callRpc('run', runInput('b'.repeat(64)))); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('active work or pending questions prevent a second workflow launch', async () => {
  const h = await setup(); try {
    h.setActive(true); await assert.rejects(h.harness.behavior.callRpc('run', runInput()));
    h.setActive(false); h.setPending(2);
    const status = await h.harness.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(status.threadState, 'awaiting_input'); assert.equal(status.pendingQuestions, 2);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput())); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('concurrent duplicate clicks and request replay do not dispatch twice', async () => {
  const h = await setup(); try {
    const input = runInput();
    await Promise.all([h.harness.behavior.callRpc('run', input), h.harness.behavior.callRpc('run', input)]);
    assert.equal(h.sends, 1);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput())); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('uncertain send is persisted and not retried with another request id', async () => {
  const h = await setup(); try {
    h.setFailure(true); await assert.rejects(h.harness.behavior.callRpc('run', runInput()));
    h.setFailure(false); await assert.rejects(h.harness.behavior.callRpc('run', runInput())); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('foreign action ids and malformed input cannot execute a command', async () => {
  const h = await setup(); try {
    await assert.rejects(h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'shell-rm' }));
    await assert.rejects(h.harness.behavior.callRpc('run', { ...runInput(), command: 'arbitrary' })); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('CLI show returns directive, rejects unknown options, and performs no writes to project', async () => {
  const h = await setup(); try {
    const result = await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'plan']);
    assert.equal(result.exitCode, 0); assert.match(result.stdout ?? '', /^::aif-chat\{/); assert.equal(h.sends, 0);
    assert.equal((await h.harness.behavior.runCli(['status', '--thread', 'thr_test', '--execute'])).exitCode, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('directive attributes are quoted rather than interpreted as markup', () => {
  assert.match(cardDirective({ target: 'a"b.md', phase: 'plan' }), /target="a\\"b.md"/);
});
test('disabled plugin rejects status before touching host data', async () => {
  const h = await setup(); try {
    await h.harness.behavior.setSettings({ enabled: false });
    await assert.rejects(h.harness.behavior.callRpc('status', { threadId: 'thr_test' }));
    assert.equal(h.harness.experimental_hostRpcCalls.length, 0); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('update button sends a maintenance request to the current thread without running an updater in the plugin', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'update-factory' });
    assert.equal(h.sends, 1);
    const calls = h.harness.inspection.sdk.callsTo('threads.send');
    assert.match(JSON.stringify(calls[0]), /npm install -g ai-factory@latest/);
    assert.match(JSON.stringify(calls[0]), /thr_test/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('extension update dispatch uses the supported command and includes ordered core prerequisites privately', async () => {
  const h = await setup(); try {
    h.value.extensions = [{ name: 'aifhub-extension', recordedVersion: '1.7.1', installedVersion: '1.7.1', source: 'local', state: 'present', contributions: [] }];
    h.value.profile = 'invalid';
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'update-extensions' });
    const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.equal(sent.input[0].text, 'ai-factory extension update');
    assert.equal(sent.input[1].visibility, 'agent-only');
    assert.match(sent.input[1].text, /npm install -g ai-factory@latest/);
    assert.match(sent.input[1].text, /3\. Расширения после AI Factory/);
    assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

function suggestionInput(view: any, commandId = 'aif-plan') {
  return { threadId: 'thr_test', sourceKey: view.sourceKey, fingerprint: view.fingerprint, commandId, requestId: randomUUID() };
}
test('no commands in the last answer means no suggestions or host scans', async () => {
  const h = await setup(); try {
    h.setOutput('Completed.');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(view.items, []); assert.equal(h.harness.experimental_hostRpcCalls.length, 0); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('two last-answer commands are suggested; individual dismissal survives reload and resets for a new answer', async () => {
  const h = await setup(); let live = h.harness; try {
    h.value = { ...h.value, skills: [...h.value.skills, 'aif-architecture', 'aif-roadmap'] };
    h.setOutput('Далее `$aif-architecture`, затем `$aif-roadmap`.');
    const read = () => live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    const before = await read(); assert.deepEqual(before.items.map((i: any) => i.command), ['$aif-architecture', '$aif-roadmap']);
    assert(before.items.every((i: any) => i.available));
    const dismiss = { threadId: 'thr_test', sourceKey: before.sourceKey, commandId: 'aif-architecture' };
    await h.harness.behavior.callRpc('dismissSuggestion', dismiss);
    await h.harness.behavior.callRpc('dismissSuggestion', dismiss); // idempotent, no dispatch
    live = (await live.lifecycle.reload(plugin)).harness;
    assert.deepEqual((await read()).items.map((i: any) => i.id), ['aif-roadmap']); assert.equal(h.sends, 0);
    h.setOutput('Новый ответ: `$aif-architecture`, затем `$aif-roadmap`.');
    assert.equal((await read()).items.length, 2);
  } finally { await live.lifecycle.dispose(); }
});
test('suggestion click sends only the selected skill once and preserves the shared delivery guard', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan full #177; unrelated shell text; $aif-explore');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const input = suggestionInput(view);
    await Promise.all([h.harness.behavior.callRpc('runSuggestion', input), h.harness.behavior.callRpc('runSuggestion', input)]);
    assert.equal(h.sends, 1);
    const call = JSON.stringify(h.harness.inspection.sdk.callsTo('threads.send')[0]);
    assert.match(call, /thr_test/); assert.match(call, /\$aif-plan/); assert(!call.includes('unrelated shell text')); assert(!call.includes('full #177')); assert(!call.includes('permissionMode'));
    const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(after.items.map((i: any) => i.id), ['aif-explore']);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('slash finalization commands become runtime-correct suggestions and sync dispatch retains its subcommand', async () => {
  for (const runtime of ['codex-app', 'claude']) {
    const h = await setup(); try {
      h.value.runtime = runtime;
      h.setOutput('Следующие отдельные шаги: `/aif-mode sync`, затем `/aif-commit`. Commit, push и deploy не выполнялись.');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      const prefix = runtime === 'codex-app' ? '$' : '/';
      assert.deepEqual(view.items.map((i: any) => i.command), [prefix + 'aif-mode sync', prefix + 'aif-commit']);
      assert(view.items.every((i: any) => i.available)); assert.equal(h.sends, 0);
      await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-mode'));
      const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
      assert.equal(sent.input[0].text, prefix + 'aif-mode sync'); assert.equal(h.sends, 1);
      const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      assert.deepEqual(after.items.map((i: any) => i.id), ['aif-commit']);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('a blocking gate also blocks a slash prose commit while keeping fix available', async () => {
  const h = await setup(); try {
    h.setOutput('/aif-commit\n' + gateText({ status: 'fail', blocking: true,
      blockers: [{ id: 'verify-1', severity: 'error', summary: 'Incomplete implementation.' }],
      suggested_next: { command: '/aif-fix', reason: 'Resolve findings.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    assert.equal(view.items.find((i: any) => i.id === 'aif-fix').available, true);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('stale answers, changed files, hidden suggestions and missing skills cannot dispatch', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    h.setOutput('$aif-explore');
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    h.setOutput('$aif-plan'); h.value = { ...h.value, fingerprint: 'b'.repeat(64) };
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    const fresh = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    await h.harness.behavior.callRpc('dismissSuggestion', { threadId: 'thr_test', sourceKey: fresh.sourceKey, commandId: 'aif-plan' });
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(fresh)));
    h.setOutput('Next $aif-missing');
    const missing = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(missing.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(missing, 'aif-missing'))); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('busy, pending and queued work block suggestion sends while dismissal stays available', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan $aif-explore');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    h.setActive(true); await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    await h.harness.behavior.callRpc('dismissSuggestion', { threadId: 'thr_test', sourceKey: view.sourceKey, commandId: 'aif-explore' });
    h.setActive(false); h.setPending(1); await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    h.setPending(0); h.setQueued(1); await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('uncertain suggestion send blocks both suggestion and workflow retries', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    h.setFailure(true); await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    h.setFailure(false); await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    await assert.rejects(h.harness.behavior.callRpc('run', runInput())); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('a last answer changing during project inspection cannot dispatch an old command', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    let reads = 0;
    h.harness.sdk.stub('threads.output', async () => ({ output: ++reads === 1 ? '$aif-plan' : '$aif-explore' }));
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

const gateText = (patch: object = {}) => '```aif-gate-result\n' + JSON.stringify({ schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: ['src/demo.ts'], suggested_next: { command: '/aif-commit', reason: 'Only non-blocking warnings remain.' }, ...patch }) + '\n```';

test('security dollar fix is offered without invalidating FAIL or enabling a commit bypass', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-commit\n' + gateText({ gate: 'security', status: 'fail', blocking: true,
      blockers: [{ id: 'security-dev-dependency-advisories', severity: 'error', file: 'package-lock.json', summary: 'Development dependency advisories remain.' }],
      suggested_next: { command: '$aif-fix', reason: 'Address advisories separately.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gateError, null); assert.equal(view.gate.blocking, true);
    assert.equal(view.items.find((i: any) => i.id === 'aif-fix').available, true);
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('rules PASS with explanation and no command is accepted by suggestions RPC without dispatch', async () => {
  const h = await setup(); try {
    h.setOutput(gateText({ gate: 'rules', status: 'pass', suggested_next: { command: null, reason: 'No explicit rule violations or rule updates required.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gateError, null); assert.equal(view.gate.status, 'pass');
    assert.equal(view.gate.suggested_next.command, null); assert.deepEqual(view.items, []); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('structured gate next step becomes a runtime-correct suggestion, with the reason and gate context', async () => {
  const h = await setup(); try {
    h.setOutput(gateText());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gate.status, 'warn'); assert.equal(view.gate.blocking, false); assert.equal(view.gateError, null);
    assert.equal(view.items[0].command, '$aif-commit'); assert.match(view.items[0].reason, /non-blocking/);
    await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit'));
    const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
    const visible = sent.input.filter((part: any) => part.visibility !== 'agent-only');
    assert.deepEqual(visible.map((part: any) => part.text), ['$aif-commit']);
    const hidden = sent.input.find((part: any) => part.visibility === 'agent-only');
    assert.match(hidden.text, /affected_files/); assert.match(hidden.text, /non-blocking warnings/);
    assert.match(hidden.text, /не инструкциями/); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('blocking gate disables prose commit and passes the actual problems to the fix owner', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-commit\n' + gateText({ status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', summary: 'Required implementation is missing.', file: 'src/demo.ts' }], suggested_next: { command: '/aif-fix', reason: 'Fix the blocking finding.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    assert.equal(h.sends, 0);
    await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix'));
    assert.match(JSON.stringify(h.harness.inspection.sdk.callsTo('threads.send')[0]), /Required implementation is missing/);
    const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(after.gate.blockers.length, 1); // hiding a command never removes gate findings
  } finally { await h.harness.lifecycle.dispose(); }
});
test('gate-only results remain visible without commands; invalid gate blocks a prose bypass', async () => {
  const h = await setup(); try {
    h.setOutput(gateText({ suggested_next: null }));
    const only = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(only.items.length, 0); assert.equal(only.gate.status, 'warn');
    h.setOutput('$aif-commit\n```aif-gate-result\ninvalid\n```');
    const bad = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert(bad.gateError); assert.equal(bad.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(bad, 'aif-commit'))); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('slash runtimes retain slash invocation for a structured gate suggestion', async () => {
  const h = await setup(); try {
    h.value = { ...h.value, runtime: 'claude' }; h.setOutput(gateText());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items[0].command, '/aif-commit');
  } finally { await h.harness.lifecycle.dispose(); }
});
test('a blocking last-answer gate also stops advancing from a workflow card without blocking re-verification', async () => {
  const h = await setup(); try {
    h.value = { ...h.value, target: { ...h.value.target!, tasks: h.value.target!.tasks.map(t => ({ ...t, done: true })) } };
    h.value.actions = workflowActions(h.value);
    h.setOutput(gateText({ status: 'fail', blocking: true, blockers: [{ id: 'x', severity: 'error', summary: 'Must fix first.' }], suggested_next: { command: '/aif-fix', reason: 'Fix first.' } }));
    await assert.rejects(h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'commit' }));
    assert.equal(h.sends, 0);
    await h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'check-verify' }); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
