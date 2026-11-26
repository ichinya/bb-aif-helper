import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { cardDirective } from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import { VERSION_TTL } from '../versions.ts';
import { readinessSteps } from '../readiness.ts';
import { nativePlanInput } from '../basic-workflow.ts';

async function setup() {
  let value = snapshot(); value.actions = workflowActions(value);
  let sends = 0;
  let failSend = false;
  let pending = 0;
  let output: string | null = null;
  let events: any[] = [];
  let eventsFailure = false;
  let eventsHook = () => {};
  let collections = 0;
  let collectBlock: Promise<void> | null = null;
  let collectFailure = false;
  let collectHook: ((input: any) => ReturnType<typeof snapshot>) | null = null;
  let planSupported = true;
  const savedPlans: any[] = [];
  const verifiedPlans: any[] = [];
  let saveFailure = false;
  const hostInputs: any[] = [];
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  let thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat', 'aif-scout'], experimental_hostEntry: true,
    sdk: {
      providers: { list: async () => [{ id: thread.providerId, composerActions: planSupported
        ? [{ kind: 'plan', command: { trigger: '/', name: 'plan', trailingText: ' ' } }] : [] }] as any },
      threads: { get: async () => thread, events: { list: async (args: any) => { assert(Number(args.limit) <= 100); eventsHook(); if (eventsFailure) throw new Error('history unavailable'); return events; } }, output: async () => ({ output }), send: async () => { sends++; if (failSend) throw new Error('lost connection'); return {} as any; }, interactions: { list: async () => Array.from({ length: pending }, () => ({})) as any } },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async call => {
      const { method, input } = call;
      hostCalls.push({ method, input: structuredClone(input), hostId: call.hostId });
      if (method === 'watch' || method === 'unwatch') return { ok: true as const };
      if (method === 'savePlan') { if (saveFailure) throw new Error('disk unavailable'); savedPlans.push(structuredClone(input)); return { path: '.bb/aif-helper/plans/saved.md' }; }
      if (method === 'markPlanVerified') { verifiedPlans.push(structuredClone(input)); return { path: (input as any).target, verified: true }; }
      if (method !== 'collect') return structuredClone(value);
      collections++; hostInputs.push(structuredClone(input));
      if (collectBlock) await collectBlock;
      if (collectFailure) throw new Error('host unavailable');
      return structuredClone(collectHook ? collectHook(input) : value);
    },
  });
  await plugin(h.bb);
  return { ...h, get value() { return value; }, set value(v) { value = v; }, get sends() { return sends; },
    get collections() { return collections; }, setCollectBlock(block: Promise<void> | null) { collectBlock = block; }, setCollectHook(hook: (input: any) => ReturnType<typeof snapshot>) { collectHook = hook; },
    get hostInputs() { return hostInputs; }, get hostCalls() { return hostCalls; }, get savedPlans() { return savedPlans; }, get verifiedPlans() { return verifiedPlans; },
    setSaveFailure(value: boolean) { saveFailure = value; }, setCollectFailure(fails: boolean) { collectFailure = fails; }, setPlanSupported(value: boolean) { planSupported = value; },
    setEvents(rows: any[]) { events = rows; }, setEventsFailure(fails: boolean) { eventsFailure = fails; }, setEventsHook(hook: () => void) { eventsHook = hook; }, setOutput(text: string | null) { output = text; }, setQueued(count: number) { thread = { ...thread, queuedMessageCount: count }; },
    setFailure(v: boolean) { failSend = v; }, setPending(v: number) { pending = v; }, setActive(v: boolean) { thread = { ...thread, status: v ? 'active' : 'idle', runtime: { displayStatus: v ? 'active' : 'idle' } }; } };
}
function runInput(fingerprint = 'a'.repeat(64)) { return { threadId: 'thr_test', target: '.ai-factory/plans/demo.md', phase: 'plan', fingerprint, actionId: 'improve', requestId: randomUUID() }; }

test('preparation visibility is shared within a project and scoped by folder in the personal project', async () => {
  const h = await setup();
  try {
    h.value.preparation = [{ id: 'describe', label: 'Описать проект', optional: false, state: 'missing', paths: ['.ai-factory/DESCRIPTION.md'] }];
    const projectId = (id: string) => id.startsWith('personal') ? 'proj_personal' : id === 'other' ? 'proj_other' : 'proj_test';
    h.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({
      id: threadId, projectId: projectId(threadId), environmentId: threadId, status: 'idle',
    }));
    h.harness.sdk.stub('environments.get', async ({ environmentId }) => ({
      id: environmentId, projectId: projectId(environmentId), path: `/${environmentId}`,
      hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' },
    }) as any);
    const status = async (threadId: string) =>
      await h.harness.behavior.callRpc('status', { threadId }) as typeof h.value;
    const setVisibility = (threadId: string, visible: boolean) =>
      h.harness.behavior.callRpc('setPreparationVisibility', { threadId, visible });

    const initial = await status('thr_test');
    assert.equal(initial.preparationVisible, false);
    await setVisibility('thr_test', true);
    assert.equal((await status('same_project')).preparationVisible, true);
    assert.equal((await status('other')).preparationVisible, false);
    assert.equal((await status('thr_test')).fingerprint, initial.fingerprint);
    await setVisibility('same_project', false);
    assert.equal((await status('thr_test')).preparationVisible, false);
    await setVisibility('personal_one', true);
    assert.equal((await status('personal_one')).preparationVisible, true);
    assert.equal((await status('personal_two')).preparationVisible, false);
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('2.22 commit boundaries also block a generic commit suggestion while coupling retains its explicit opt-in', async () => {
  const h = await setup(); try {
    h.value.versions.installed = '2.22.0'; h.value.worktree.hasUncommitted = true;
    h.value.target!.settings = { commitStrategy: 'single-commit', methodology: 'tdd', tddGranularity: 'task-based' };
    h.setOutput('$aif-commit');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items[0].available, false); assert.match(view.items[0].reason, /aif-implement/);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', { threadId: 'thr_test', sourceKey: view.sourceKey,
      fingerprint: view.fingerprint, commandId: 'aif-commit', requestId: randomUUID() }));
    assert.equal(h.sends, 0);
    h.setOutput('$aif-review +coupling --unsafe');
    const coupling = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(coupling.items[0].command, '$aif-review +coupling --unsafe');
    const couplingResult = await h.harness.behavior.callRpc('runSuggestion', { threadId: 'thr_test', sourceKey: coupling.sourceKey,
      fingerprint: coupling.fingerprint, commandId: 'aif-review', requestId: randomUUID() }) as any;
    assert.equal(couplingResult.sent, false); assert.equal(couplingResult.command, '$aif-review +coupling --unsafe');
    assert.equal(h.sends, 0);
    assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

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
    const stale = await h.harness.behavior.callRpc('run', runInput());
    assert.deepEqual(stale, { sent: false, stale: true, message: 'Карточка устарела. Проверьте обновлённую задачу и нажмите ещё раз.' });
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

test('a nonterminal gate remains a historical claim and never establishes a current-input baseline', async () => {
  const h = await setup(); try {
    h.value.inputsFingerprint = 'c'.repeat(64);
    h.value.checks = [{ id: 'verify', label: 'Verify', state: 'notrun', path: null, detail: 'Missing', required: false }];
    const text = gateText({ status: 'pass', suggested_next: null, affected_files: ['.ai-factory/plans/demo.md'] }) + '\nSummary after gate.';
    h.setEvents([{ seq: 31, createdAt: Date.now(), type: 'item/completed', data: { item: { type: 'agentMessage', text } } }]);
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_test' }), lastAssistantText: text });
    const status = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(status.checks[0].chat.result.status, 'pass'); assert.equal(status.checks[0].chat.freshness, 'unknown');
    assert.equal(status.actions.find((a: any) => a.id === 'check-verify').available, true);
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
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

test('only the latest issued card is current per thread, persists across reload and performs no project reads', async () => {
  const h = await setup(); let live = h.harness;
  const show = async () => {
    const result = await live.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'explore']);
    assert.equal(result.exitCode, 0);
    return result.stdout!.match(/card="([^"]+)"/)![1];
  };
  try {
    const first = await show();
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: first }) as any).state, 'current');
    // A suppressed output does not supersede the existing card.
    h.setPending(1);
    assert.equal((await live.behavior.runCli(['show', '--thread', 'thr_test'])).stdout, '');
    h.setPending(0);
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: first }) as any).state, 'current');
    const latest = await show(); assert.notEqual(first, latest);
    const scans = h.collections;
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: first }) as any).state, 'superseded');
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_other', cardId: latest }) as any).state, 'hidden');
    live = (await live.lifecycle.reload(plugin)).harness;
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: latest }) as any).state, 'current');
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: first }) as any).state, 'superseded');
    assert.equal(h.collections, scans); assert.equal(h.sends, 0);
    await live.behavior.emitThreadEvent('thread.deleted', { thread: makeThreadResponse({ id: 'thr_test' }) });
    assert.equal((await live.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: latest }) as any).state, 'hidden');
  } finally { await live.lifecycle.dispose(); }
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
      const input = { ...runInput(view.fingerprint), phase: 'unknown', target: '', actionId,
        ...(actionId === 'basic-explore' ? { researchTask: 'Почему форма отклоняет завтрашнюю дату?' } : {}) };
      h.setPending(1); await assert.rejects(h.harness.behavior.callRpc('run', input)); h.setPending(0);
      h.setActive(true); await assert.rejects(h.harness.behavior.callRpc('run', input)); h.setActive(false);
      await h.harness.behavior.callRpc('run', input);
      const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
      assert(sent.input[0].text.startsWith('BB AIF Helper:'));
      assert.equal(sent.input[1].visibility, 'agent-only');
      if (actionId === 'basic-explore') {
        assert.match(sent.input[0].text, /Задача для исследования:\nПочему форма отклоняет завтрашнюю дату\?/);
        assert.match(sent.input[1].text, /Исследуй текущую задачу/); assert(!sent.input[1].text.includes('npm install'));
      } else assert.match(sent.input[1].text, /ai-factory init --agents codex-app/);
      assert.equal(h.sends, 1);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('a stale stored basic selection is cleared, does not choose a different plan and stays cleared after reload/show', async () => {
  const h = await setup(); let live = h.harness;
  try {
    const deleted = '.bb/aif-helper/plans/deleted.md';
    const other = { path: '.bb/aif-helper/plans/other.md', id: 'other', title: 'Other', kind: 'basic' as const, tasks: [{ id: '1', title: 'Work', done: false }] };
    const base = snapshot({ configured: false, profile: 'none', target: other, candidates: [{ ...other }], skills: [], phase: 'unknown' });
    h.setCollectHook(input => input.target ? snapshot({ ...base, target: null, selectionReset: true, diagnostics: ['Ранее выбранный план не найден; выбор сброшен.'] }) : base);
    await h.bb.storage.kv.set('selection:thr_test', { environmentId: 'env_test', target: deleted, phase: 'explore' });
    await h.bb.storage.kv.set('chat-plan:thr_test', { environmentId: 'env_test', root: '/project', seq: 1, hash: 'a'.repeat(64), title: 'Old task', text: '# Old task' });
    const recovered = await live.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(recovered.profile, 'none'); assert.equal(recovered.selectionReset, true); assert.equal(recovered.target, null);
    assert.equal(recovered.chatPlan, undefined);
    assert(recovered.actions.some((a: any) => a.id === 'basic-explore')); assert(recovered.actions.some((a: any) => a.id === 'basic-plan'));
    assert.equal(h.hostInputs[0].target, deleted); assert.equal(h.hostInputs[1].target, '');
    assert.equal((await h.bb.storage.kv.get<any>('selection:thr_test'))!.target, '');
    const shown = await live.behavior.runCli(['show', '--thread', 'thr_test', '--target', deleted, '--phase', 'explore']);
    assert.equal(shown.exitCode, 0); assert(!shown.stdout.includes(deleted));
    assert.equal((await h.bb.storage.kv.get<any>('selection:thr_test'))!.target, '');
    live = (await live.lifecycle.reload(plugin)).harness;
    const persisted = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(persisted.profile, 'none'); assert.equal(persisted.target, null);
    assert.equal(h.sends, 0); assert.equal(h.savedPlans.length, 0);
  } finally { await live.lifecycle.dispose(); }
});

test('an archived native selection clears persistently, enables sync and retains the missing commit skill guard', async () => {
  const h = await setup(); let live = h.harness;
  try {
    const archived = 'openspec/changes/archive/2026-11-14-demo/tasks.md';
    const other = { path: 'openspec/changes/other/tasks.md', id: 'other', title: 'Other', kind: 'openspec' as const, tasks: [{ id: '1', title: 'Other work', done: false }] };
    const base = snapshot({ configured: true, profile: 'aifhub-openspec', target: other, candidates: [{ ...other }], skills: ['aif-mode'], phase: 'done' });
    h.setCollectHook(input => input.target ? snapshot({ ...base, target: null, selectionReset: true, diagnostics: ['Выбранный change найден в архиве; выбор сброшен.'] }) : base);
    await h.bb.storage.kv.set('selection:thr_test', { environmentId: 'env_test', target: archived, phase: 'done' });
    h.setOutput('Далее: `$aif-mode sync`, затем `$aif-commit`.');
    const view = await live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items[0].command, '$aif-mode sync'); assert.equal(view.items[0].available, true);
    assert(!view.items.some((item: any) => item.id === 'aif-commit'));
    const selected = await h.bb.storage.kv.get<any>('selection:thr_test');
    assert.equal(selected.target, ''); assert.equal(selected.newTask, true);
    const shown = await live.behavior.runCli(['show', '--thread', 'thr_test', '--target', archived, '--phase', 'done']);
    assert.equal(shown.exitCode, 0); assert(!shown.stdout.includes(archived));
    live = (await live.lifecycle.reload(plugin)).harness;
    const status = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(status.profile, 'aifhub-openspec'); assert.equal(status.target, null); assert.equal(status.phase, 'done');
    const fresh = await live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    await assert.rejects(live.behavior.callRpc('runSuggestion', suggestionInput(fresh, 'aif-commit')));
    assert.equal(h.sends, 0);
    const synced = await live.behavior.callRpc('runSuggestion', suggestionInput(fresh, 'aif-mode')) as any;
    assert.equal(synced.sent, false); assert.equal(synced.command, '$aif-mode sync');
    assert.equal(h.sends, 0);
    assert.equal(live.inspection.sdk.callsTo('threads.send').length, 0);
  } finally { await live.lifecycle.dispose(); }
});

test('mark-verified writes only the selected completed basic plan and never starts an agent', async () => {
  const h = await setup(); try {
    const target = { path: '.bb/aif-helper/plans/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const,
      verification: { contentHash: 'a'.repeat(64), verified: false }, tasks: [{ id: '1', title: 'Work', done: false }] };
    h.value = snapshot({ configured: false, profile: 'none', target, candidates: [{ ...target }], skills: [] });
    const args = ['mark-verified', '--thread', 'thr_test', '--target', target.path, '--json'];
    assert.equal((await h.harness.behavior.runCli(args)).exitCode, 1); assert.equal(h.verifiedPlans.length, 0);
    h.value.target!.tasks[0].done = true; h.setPending(1);
    assert.equal((await h.harness.behavior.runCli(args)).exitCode, 1); assert.equal(h.verifiedPlans.length, 0);
    h.setPending(0); h.setActive(true);
    const result = await h.harness.behavior.runCli(args);
    assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.stdout).verified, true);
    assert.deepEqual(h.verifiedPlans[0], { root: '/project', target: target.path, expectedHash: 'a'.repeat(64) });
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

for (const wrapped of [true, false]) test(`a ${wrapped ? 'wrapped' : 'standalone'} plan is saved only after generation, selects the file and supersedes an earlier inline form`, async () => {
  const h = await setup(); try {
    h.value = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'unknown' });
    const text = '# Ready\n## Tasks\n- [ ] 1. Fix input\n## Проверки\nOffline only.';
    const rows = [{ seq: 1, type: 'client/turn/requested', data: { input: [nativePlanInput('Составить план')] } },
      { seq: 2, type: 'item/completed', data: { item: { type: 'agentMessage', text: (wrapped ? '<proposed_plan>\n' : '') + '````aif-plan\n' + text + '\n````' + (wrapped ? '\n</proposed_plan>' : '') } } }];
    h.setEvents(rows); h.setActive(true);
    const oldId = '11111111-1111-4111-8111-111111111111';
    await h.bb.storage.kv.set('inline-card:thr_test', { cardId: oldId, environmentId: 'env_test' });
    const early = await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'plan']);
    assert.equal(early.stdout, ''); assert.equal(h.savedPlans.length, 0);
    assert.equal(await h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text }), null);
    h.setActive(false);
    assert.equal(await h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text: text + 'changed' }), null);
    const saved = await h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text }) as any;
    assert.equal(saved.path, '.bb/aif-helper/plans/saved.md'); assert.equal(h.savedPlans.length, 1);
    assert.equal(h.savedPlans[0].text, text); assert.equal(h.sends, 0);
    assert.deepEqual(await h.harness.behavior.callRpc('cardVisibility', { threadId: 'thr_test', cardId: oldId }), { state: 'superseded' });
    assert.equal((await h.bb.storage.kv.get<any>('selection:thr_test'))!.target, saved.path);
    await h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text });
    assert.equal(h.savedPlans.length, 1);
    const retry = await h.harness.behavior.runCli(['save-plan', '--thread', 'thr_test', '--json']);
    assert.equal(retry.exitCode, 0); assert.equal(JSON.parse(retry.stdout).path, saved.path);
    assert.equal(h.savedPlans.length, 1); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('saving failures keep the proposal intact and retryable without execution', async () => {
  const h = await setup(); try {
    h.value = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [] });
    const text = '# Ready\n## Tasks\n- [ ] Work';
    h.setEvents([{ seq: 1, type: 'client/turn/requested', data: { input: [nativePlanInput('Составить план')] } },
      { seq: 2, type: 'item/completed', data: { item: { type: 'agentMessage', text: '<proposed_plan>\n' + text + '\n</proposed_plan>' } } }]);
    h.setSaveFailure(true);
    await assert.rejects(h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text }));
    assert.equal(await h.bb.storage.kv.get('plan-document:thr_test'), undefined); assert.equal(h.sends, 0);
    h.setSaveFailure(false);
    assert(await h.harness.behavior.callRpc('planDocument', { threadId: 'thr_test', text }));
    assert.equal(h.savedPlans.length, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a builtin Plan proposal enables normal execution, binds its contents and preserves accepted context after reload', async () => {
  const h = await setup(); let live = h.harness;
  try {
    h.value = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'unknown' });
    const text = '<proposed_plan>\n# Chat task\n1. Fix input.\n2. Test offline.\nNo push.\n</proposed_plan>\n::aif-chat{phase="plan"}';
    const rows = [{ seq: 1, type: 'client/turn/requested', data: { input: [nativePlanInput('Составить план')] } },
      { seq: 2, type: 'item/completed', data: { item: { type: 'agentMessage', text } } }];
    h.setEvents(rows);
    const view = await live.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan' }) as any;
    assert.equal(view.chatPlan.title, 'Chat task'); assert.equal(view.chatPlan.accepted, false); assert.equal(h.sends, 0);
    assert.equal(view.actions.find((a: any) => a.id === 'basic-implement').label, 'Выполнить предложенный план');
    const input = { ...runInput(view.fingerprint), target: '', phase: 'plan', actionId: 'basic-implement' };
    h.setActive(true); await assert.rejects(live.behavior.callRpc('run', input)); h.setActive(false);
    const result = await live.behavior.callRpc('run', input) as any;
    assert.equal(result.newTask, true);
    const sent = live.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.equal(sent.input[0].text, 'BB AIF Helper: Выполнить предложенный план');
    assert.deepEqual(sent.input[0].mentions, []); assert(!sent.input[0].text.startsWith('/plan'));
    assert.match(sent.input[1].text, /No push/); assert.match(sent.input[1].text, /SHA-256/);
    assert.equal(h.sends, 1);
    h.setEvents([...rows, { seq: 3, type: 'client/turn/requested', data: { input: sent.input } }]);
    live = (await live.lifecycle.reload(plugin)).harness;
    const follow = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(follow.chatPlan.accepted, true); assert.equal(follow.phase, 'implement');
    assert(follow.actions.some((a: any) => a.id === 'basic-verify'));
    assert.equal(follow.target, null); assert.equal(follow.checks.length, 0);
    const done = await live.behavior.callRpc('status', { threadId: 'thr_test', phase: 'done' }) as any;
    assert(done.actions.some((a: any) => a.id === 'basic-explore'));
    await live.behavior.callRpc('run', { ...runInput(done.fingerprint), target: '', phase: 'done', actionId: 'basic-explore', researchTask: 'Next task' });
    const nextTask = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(nextTask.chatPlan, undefined); assert.equal(nextTask.phase, 'explore');
  } finally { await live.lifecycle.dispose(); }
});

test('a proposed chat plan cannot dispatch after a new user request or a changed version', async () => {
  for (const changed of [false, true]) {
    const h = await setup(); try {
      h.value = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [] });
      const request = { seq: 1, type: 'client/turn/requested', data: { input: [nativePlanInput('Составить план')] } };
      const reply = { seq: 2, type: 'item/completed', data: { item: { type: 'agentMessage', text: '<proposed_plan>\n# Work\n1. Test.\n</proposed_plan>' } } };
      h.setEvents([request, reply]);
      const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan' }) as any;
      h.setEvents(changed ? [request, { ...reply, seq: 3 }] : [request, reply, { ...request, seq: 3 }]);
      const result = await h.harness.behavior.callRpc('run', { ...runInput(view.fingerprint), target: '', phase: 'plan', actionId: 'basic-implement' }) as { stale?: true };
      assert.equal(result.stale, true);
      assert.equal(h.sends, 0); assert.equal(await h.bb.storage.kv.get('chat-plan:thr_test'), undefined);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('a new exploration releases the completed basic plan only after dispatch and survives reload', async () => {
  const h = await setup(); let live = h.harness;
  try {
    const target = { path: '.bb/aif-helper/plans/finished.md', title: 'Finished', id: 'finished', kind: 'basic' as const,
      tasks: [{ id: '1', title: 'Done', done: true }] };
    h.value = snapshot({ configured: false, profile: 'none', target, candidates: [{ ...target }], skills: [], phase: 'unknown' });
    const view = await live.behavior.callRpc('status', { threadId: 'thr_test', target: target.path, phase: 'done' }) as any;
    assert(view.actions.some((a: any) => a.label === 'Исследовать новую задачу')); assert.equal(h.sends, 0);
    const request = { ...runInput(view.fingerprint), target: target.path, phase: 'done', actionId: 'basic-explore', researchTask: 'Исследовать #16' };
    h.setActive(true); await assert.rejects(live.behavior.callRpc('run', request)); h.setActive(false);
    assert.equal(await h.bb.storage.kv.get('selection:thr_test'), undefined);
    const result = await live.behavior.callRpc('run', request) as any;
    assert.equal(result.newTask, true); assert.equal(h.sends, 1);
    const sent = live.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.match(sent.input[0].text, /Исследовать #16/); assert(!sent.input[1].text.includes(target.path));
    assert.match(sent.input[1].text, /"target":null/);
    const follow = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(follow.target, null); assert.equal(follow.phase, 'explore'); assert.equal(follow.candidates[0].path, target.path);
    assert(follow.actions.some((a: any) => a.id === 'basic-plan')); assert.equal(h.value.target!.tasks[0].done, true);
    live = (await live.lifecycle.reload(plugin)).harness;
    const restored = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(restored.target, null); assert.equal(restored.phase, 'explore'); assert.equal(restored.fingerprint, follow.fingerprint);
    const selected = await live.behavior.callRpc('status', { threadId: 'thr_test', target: target.path }) as any;
    assert.equal(selected.target.path, target.path);
  } finally { await live.lifecycle.dispose(); }
});

test('basic planning enters native Plan with a builtin pill and refinement uses the same mode', async () => {
  for (const refine of [false, true]) {
    const h = await setup(); try {
      const target = refine ? { path: '.bb-aif-helper/plans/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const, tasks: [{ id: '1', title: 'Work', done: false }] } : null;
      h.value = snapshot({ configured: false, profile: 'none', skills: [], target, candidates: target ? [{ ...target }] : [], phase: 'unknown' });
      const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
      const request = { ...runInput(view.fingerprint), phase: 'unknown', target: target?.path ?? '', actionId: 'basic-plan' };
      await h.harness.behavior.callRpc('run', request);
      const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
      assert.equal(sent.input[0].text, '/plan ' + (refine ? 'Уточнить план' : 'Составить план'));
      assert.deepEqual(sent.input[0].mentions, [{ start: 0, end: 5, resource: {
        kind: 'command', trigger: '/', name: 'plan', source: 'command', origin: 'builtin', label: 'plan', argumentHint: null,
      } }]);
      assert.match(sent.input[1].text, /штатном режиме Plan/);
      assert(!sent.input[1].text.includes('Иначе создай новый')); assert(!sent.input[1].text.includes('aif_chat_status'));
      assert.equal(h.harness.inspection.sdk.callsTo('threads.update').length, 0);
      assert.equal(sent.permissionMode, undefined); assert.equal(h.sends, 1);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('an unsupported Plan provider never falls back to file-writing and leaves dispatch retryable', async () => {
  const h = await setup(); try {
    h.value = snapshot({ configured: false, profile: 'none', skills: [], target: null, candidates: [], phase: 'unknown' });
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    const request = { ...runInput(view.fingerprint), phase: 'unknown', target: '', actionId: 'basic-plan' };
    h.setPlanSupported(false);
    await assert.rejects(h.harness.behavior.callRpc('run', request), /не объявляет штатный режим Plan/);
    assert.equal(h.sends, 0);
    assert.equal(await h.bb.storage.kv.get('deliveries:thr_test'), undefined);
    h.setPlanSupported(true); await h.harness.behavior.callRpc('run', request);
    assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('basic exploration requires a bounded description and sends it literally with the read-only prompt', async () => {
  const h = await setup(); try {
    h.value = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [] });
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'unknown' }) as any;
    const input = { ...runInput(view.fingerprint), target: '', phase: 'unknown', actionId: 'basic-explore' };
    await assert.rejects(h.harness.behavior.callRpc('run', input), /Опишите/);
    for (const researchTask of ['', ' \n ', 'x'.repeat(4001)]) {
      await assert.rejects(h.harness.behavior.callRpc('run', { ...input, researchTask }));
    }
    await assert.rejects(h.harness.behavior.callRpc('run', { ...input, actionId: 'basic-plan', researchTask: 'Задача' }), /только для кнопки/);
    assert.equal(h.sends, 0);
    const task = 'Исследовать #213\nПроверить `before_or_equal:today` и форму.';
    await h.harness.behavior.callRpc('run', { ...input, researchTask: `  ${task}\n ` });
    const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.equal(sent.input[0].text, `BB AIF Helper: Исследовать задачу\n\nЗадача для исследования:\n${task}`);
    assert.equal(sent.input[0].visibility, undefined);
    assert.equal(sent.input[1].visibility, 'agent-only');
    assert.match(sent.input[1].text, /не меняй код, конфигурацию и планы/);
    assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
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
test('stale card returns a normal result without dispatch or delivery state', async () => {
  const h = await setup(); try {
    const result = await h.harness.behavior.callRpc('run', runInput('b'.repeat(64))) as { sent: boolean; stale?: true };
    assert.equal(result.sent, false); assert.equal(result.stale, true); assert.equal(h.sends, 0);
    assert.equal(await h.bb.storage.kv.get('deliveries:thr_test'), undefined);
    const retry = await h.harness.behavior.callRpc('run', runInput()) as { sent: boolean };
    assert.equal(retry.sent, true); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
// Confirmed mechanism: show() (server.ts:219) saves the agent-declared phase into
// the thread selection — aif_chat_status reaches it through the same show()
// (server.ts:358); status() resolves a request phase of 'unknown' from that
// selection (server.ts:149) and mixes the phase into the fingerprint
// (server.ts:205), so a card rendered before the agent's show keeps a fingerprint
// that no longer matches and run/runSuggestion must resolve { sent: false,
// stale: true } instead of throwing an RPC handler error.
test('stale card and suggestion clicks resolve as stale without dispatch', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const card = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', target: '', phase: 'unknown' }) as any;
    const sug = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal((await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'plan'])).exitCode, 0);
    const ran = await h.harness.behavior.callRpc('run', { ...runInput(card.fingerprint), target: '', phase: 'unknown' }) as any;
    assert.equal(ran.sent, false); assert.equal(ran.stale, true);
    const picked = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(sug)) as any;
    assert.equal(picked.sent, false); assert.equal(picked.stale, true);
    assert.equal(h.sends, 0);
    assert.equal(await h.bb.storage.kv.get('deliveries:thr_test'), undefined);
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

test('plain exploration confirmation suppresses a new card and blocks both dispatch paths until the next user turn', async () => {
  const h = await setup(); try {
    const text = 'Предлагаю исследовать ограничения формы и сервера. Подтверждаете такой объём?\nПосле исследования — $aif-plan.';
    h.setOutput(text);
    const question = { seq: 10, type: 'item/completed', data: { item: { type: 'agentMessage', text } } };
    h.setEvents([question]);
    const value = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'explore' }) as any;
    assert.equal(value.pendingConfirmation, true); assert.equal(value.pendingQuestions, 0); assert.equal(value.threadState, 'awaiting_input');
    const show = await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'explore', '--json']);
    assert.equal(JSON.parse(show.stdout!).previewDirective, '');
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()), /подтверждения/);
    const suggestion = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(suggestion.threadState, 'awaiting_input');
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', { threadId: 'thr_test', sourceKey: suggestion.sourceKey,
      fingerprint: suggestion.fingerprint, commandId: 'aif-plan', requestId: randomUUID() }), /подтверждения/);
    assert.equal(h.sends, 0);
    // Clearing the wait does not approve or execute anything by itself.
    h.setEvents([{ seq: 11, type: 'client/turn/requested', data: { input: [{ type: 'text', text: 'Нет, изменим объём.' }] } }, question]);
    const answered = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'explore' }) as any;
    assert.equal(answered.pendingConfirmation, false); assert.equal(answered.threadState, 'idle'); assert.equal(h.sends, 0);
    const shown = await h.harness.behavior.runCli(['show', '--thread', 'thr_test', '--phase', 'explore']);
    assert.match(shown.stdout!, /^::aif-chat/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('confirmation is checked during dispatch even when a card was loaded before the question', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test' });
    h.setEvents([{ seq: 5, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Жду подтверждения.' } } }]);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()), /подтверждения/);
    h.setEventsFailure(true);
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()), /проверить ожидание подтверждения/);
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a confirmation appearing during the rest of the fresh status read still prevents dispatch', async () => {
  const h = await setup(); try {
    let reads = 0;
    h.setEventsHook(() => {
      if (++reads === 2) h.setEvents([{ seq: 8, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Подтверждаете такой объём?' } } }]);
    });
    await assert.rejects(h.harness.behavior.callRpc('run', runInput()), /подтверждения/);
    assert.equal(h.sends, 0);
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

const improveQuestion = 'Для `demo` подготовлен diff уточнения задач.\n**Применить этот diff к `design.md` и `tasks.md`?**\nПлан и код сохранены. После применения доступен `$aif-implement`.';

test('OpenSpec without a SessionBrief returns JSON-safe status and suggestions without an undefined field', async () => {
  const h = await setup(); try {
    h.value = snapshot({ profile: 'aifhub-openspec', target: { path: 'openspec/changes/demo/tasks.md', id: 'demo', title: 'Demo', kind: 'openspec',
      tasks: [{ id: '1', title: 'Work', done: false }] } });
    const status = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan' }) as any;
    assert.equal(Object.hasOwn(status, 'sessionBrief'), false);
    assert.equal(status.pendingConfirmation, false);
    h.setOutput('$aif-improve demo');
    const suggestions = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(suggestions.items[0].available, true); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a stale SessionBrief survives reload and offers scoped CLI recovery without allowing implementation', async () => {
  const h = await setup(); let live = h.harness;
  try {
    h.value.profile = 'aifhub-openspec'; h.value.target!.kind = 'openspec';
    h.value.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1', source: 'local', state: 'present', contributions: [], commands: ['aifhub-session-brief'] }];
    const stale = 'Задача заблокирована: **SessionBrief: stale**.\n`/aif-mode sync --change demo`\n`ai-factory aifhub-session-brief compile --change demo --json`\nПовторный `$aif-implement`.';
    h.setOutput(stale);
    h.setEvents([{ seq: 2, type: 'item/completed', data: { item: { type: 'agentMessage', text: stale } } }]);
    const status = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(status.sessionBrief.status, 'stale');
    assert.equal(status.actions.find((a: any) => a.id === 'implement').available, false);
    await assert.rejects(live.behavior.callRpc('run', { ...runInput(status.fingerprint), phase: 'unknown', actionId: 'implement' }), /SessionBrief/);
    const view = await live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.find((a: any) => a.id === 'aif-mode').command, '$aif-mode sync --change demo');
    assert.equal(view.items.find((a: any) => a.id === 'aif-implement').available, false);
    const compile = view.items.find((a: any) => a.id === 'aif-session-brief');
    assert.equal(compile.available, true); assert(!compile.command.startsWith('$'));
    await live.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-session-brief'));
    const sent = live.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.deepEqual(sent.input, [{ type: 'text', text: 'ai-factory aifhub-session-brief compile --change demo --json', mentions: [] }]);
    h.setOutput('Команда завершилась с кодом 0.'); h.setEvents([]);
    live = (await live.lifecycle.reload(plugin)).harness;
    const persisted = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(persisted.sessionBrief.status, 'stale');
    h.setEvents([{ seq: 3, type: 'client/turn/requested', data: { input: [{ type: 'text', text: 'ai-factory aifhub-session-brief status --change demo --json' }] } },
      { seq: 4, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'SessionBrief demo пересобран; повторная проверка подтвердила valid, без stale/blocker причин.' } } }]);
    const restored = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(restored.sessionBrief.status, 'valid');
    assert.equal(restored.actions.find((a: any) => a.id === 'implement').available, true);
    assert.equal(h.sends, 1);
  } finally { await live.lifecycle.dispose(); }
});

test('valid SessionBrief with stale generated rules offers the exact scoped sync before implementation', async () => {
  const h = await setup();
  const live = h.harness;
  try {
    h.value.profile = 'aifhub-openspec';
    h.value.target!.kind = 'openspec';
    h.value.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1',
      source: 'local', state: 'present', contributions: [], commands: ['aifhub-mode'] }];
    const command = 'ai-factory aifhub-mode sync --change demo --json';
    const text = 'SessionBrief: valid. Проверка отметила правила change и merged как `stale-generated-rules`.\n'
      + 'Следующий шаг — отдельная синхронизация правил.\n```powershell\n' + command + '\n```\n'
      + 'После синхронизации повторить `$aif-implement demo`.';
    const report = { seq: 10, type: 'item/completed', data: { item: { type: 'agentMessage', text } } };
    h.setEvents([report]);
    h.setOutput(text);
    const read = () => live.behavior.callRpc('status', { threadId: 'thr_test', phase: 'implement' }) as Promise<typeof h.value>;
    const current = await read();
    assert.equal(current.sessionBrief?.status, 'valid');
    assert.equal(current.actions[0].id, 'rules-sync');
    assert.equal(current.actions[0].command, command);
    assert.equal(current.actions[0].available, true);
    assert.equal(current.actions.find(a => a.id === 'implement')?.available, false);
    const view = await live.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.find((a: any) => a.id === 'aif-implement').available, false);
    await assert.rejects(live.behavior.callRpc('run', { ...runInput(current.fingerprint), phase: 'implement', actionId: 'implement' }), /синхронизируйте правила/);
    assert.equal(h.sends, 0);
    await live.behavior.callRpc('run', { ...runInput(current.fingerprint), phase: 'implement', actionId: 'rules-sync' });
    const sent = (live.inspection.sdk.callsTo('threads.send')[0][0] as any).input;
    assert.deepEqual(sent.filter((item: any) => item.visibility !== 'agent-only'), [{ type: 'text', text: command, mentions: [] }]);
    assert.match(sent[1].text, /только для выбранного change/);
    h.setEvents([{ seq: 12, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Правила change demo синхронизированы.' } } }, report]);
    const synced = await read();
    assert(!synced.actions.some(a => a.id === 'rules-sync'));
    assert.equal(synced.actions.find(a => a.id === 'implement')?.available, true);
    assert.equal(h.sends, 1);
  } finally { await live.lifecycle.dispose(); }
});

test('SessionBrief CLI suggestions reject a different change and missing extension command', async () => {
  const h = await setup(); try {
    h.value.profile = 'aifhub-openspec'; h.value.target!.kind = 'openspec';
    h.setOutput('`ai-factory aifhub-session-brief compile --change other --json`');
    const other = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(other.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(other, 'aif-session-brief')));
    h.setOutput('`ai-factory aifhub-session-brief compile --change demo --json`');
    const missing = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(missing.items[0].available, false); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('gate writer is offered before verify and dispatches the exact CLI once without claiming evidence', async () => {
  for (const from of ['<rules-output.md>', '".bb/chats/rules output.md"']) {
    const h = await setup(); try {
      h.value.profile = 'aifhub-openspec'; h.value.target!.kind = 'openspec';
      h.value.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1', state: 'present', source: 'local', contributions: [], commands: ['aifhub-write-gate-evidence'] }];
      h.value.skills.push('aif-verify');
      const command = 'ai-factory aifhub-write-gate-evidence --change demo --gate rules --from ' + from;
      h.setOutput('Сохраните результат writer, затем `$aif-verify demo`:\n```text\n' + command + '\n```');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      assert.deepEqual(view.items.map((i: any) => i.id), ['aif-gate-evidence', 'aif-verify']);
      const writer = view.items[0];
      assert.equal(writer.available, true); assert.equal(writer.command, command);
      assert.equal(writer.label.includes('уточнить файл'), from.startsWith('<')); assert.equal(h.sends, 0);
      const input = suggestionInput(view, 'aif-gate-evidence');
      await Promise.all([h.harness.behavior.callRpc('runSuggestion', input), h.harness.behavior.callRpc('runSuggestion', input)]);
      assert.equal(h.sends, 1);
      assert.deepEqual((h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any).input,
        [{ type: 'text', text: command, mentions: [] }]);
      assert.deepEqual((await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any).items.map((i: any) => i.id), ['aif-verify']);
      assert(h.value.checks.every(c => c.state !== 'reported-pass'));
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('gate writer requires the installed command, exact selected change and a current idle request', async () => {
  const h = await setup(); try {
    h.value.profile = 'aifhub-openspec'; h.value.target!.kind = 'openspec';
    const command = 'ai-factory aifhub-write-gate-evidence --change demo --gate rules --from out.md';
    h.setOutput('`' + command + '`');
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    const missing = await read(); assert.equal(missing.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(missing, 'aif-gate-evidence')));
    h.value.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1', state: 'present', source: 'local', contributions: [], commands: ['aifhub-write-gate-evidence'] }];
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true });
    h.setOutput('`' + command.replace('--change demo', '--change other') + '`');
    const other = await read(); assert.equal(other.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(other, 'aif-gate-evidence')));
    h.setOutput('`' + command + '`'); const ready = await read(); assert.equal(ready.items[0].available, true);
    h.setActive(true);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(ready, 'aif-gate-evidence')));
    h.setActive(false); h.setOutput('Новый ответ без команды.');
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', suggestionInput(ready, 'aif-gate-evidence')) as { stale?: true }).stale, true);
    h.setOutput('`$aif-gate-evidence`'); assert.equal((await read()).items[0].available, false);
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

function improveEvents(seq = 1, text = improveQuestion, launch = '/aif-improve demo') {
  return [{ seq, type: 'client/turn/requested', data: { input: [{ type: 'text', text: launch }] } },
    { seq: seq + 1, type: 'item/completed', data: { item: { type: 'agentMessage', text } } }];
}

test('improve apply-all is explicit confirmation of one proposal, not a rerun or implementation', async () => {
  const h = await setup(); try {
    h.setOutput(improveQuestion); h.setEvents(improveEvents());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const approval = view.items.find((item: any) => item.id === 'apply-improvements');
    assert.equal(approval.label, 'Применить всё'); assert.equal(approval.available, true);
    assert.equal(view.threadState, 'awaiting_input'); assert.equal(h.sends, 0);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-implement')), /подтверждения/);
    const input = suggestionInput(view, 'apply-improvements');
    await Promise.all([h.harness.behavior.callRpc('runSuggestion', input), h.harness.behavior.callRpc('runSuggestion', input)]);
    assert.equal(h.sends, 1);
    const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
    assert.deepEqual(sent.input, [{ type: 'text', text: approval.command, mentions: [] }]);
    assert.match(sent.input[0].text, /выполнение плана не запускать/);
    const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert(!after.items.some((item: any) => item.id === 'apply-improvements'));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('apply-all rejects changed files, answered questions and identical text from a later improve turn', async () => {
  const h = await setup(); try {
    h.setOutput(improveQuestion); h.setEvents(improveEvents());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const input = suggestionInput(view, 'apply-improvements');
    h.value.fingerprint = 'b'.repeat(64);
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', input) as { stale?: true }).stale, true);
    h.value.fingerprint = 'a'.repeat(64);
    h.setEvents(improveEvents(10));
    const newer = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.notEqual(newer.sourceKey, view.sourceKey);
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', input) as { stale?: true }).stale, true);
    h.setEvents([...improveEvents(10), { seq: 12, type: 'client/turn/requested', data: { input: [{ type: 'text', text: 'Не применять' }] } }]);
    const answered = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert(!answered.items.some((item: any) => item.id === 'apply-improvements')); assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('apply-all preserves native questions, busy, missing skill and unknown-history guards', async () => {
  const h = await setup(); try {
    h.setOutput(improveQuestion); h.setEvents(improveEvents());
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    const first = await read();
    h.setPending(1);
    assert.equal((await read()).items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(first, 'apply-improvements')));
    h.setPending(0); h.setActive(true); assert.equal((await read()).items[0].available, false);
    h.setActive(false); h.setQueued(1); assert.equal((await read()).items[0].available, false);
    h.setQueued(0); h.value.skills = h.value.skills.filter(skill => skill !== 'aif-improve');
    const missing = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(missing, 'apply-improvements')));
    h.setEventsFailure(true); assert(!(await read()).items.some((item: any) => item.id === 'apply-improvements'));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
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
test('suggestion check returns the command and dispatch data without sending or hiding the chip', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan full #177; unrelated shell text; $aif-explore');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const input = suggestionInput(view);
    const results = await Promise.all([h.harness.behavior.callRpc('runSuggestion', input), h.harness.behavior.callRpc('runSuggestion', input)]) as any[];
    for (const result of results) {
      assert.equal(result.sent, false); assert.equal(result.command, '$aif-plan full #177');
      assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-plan');
      assert.equal(result.data.sourceKey, view.sourceKey); assert.equal(result.data.fingerprint, view.fingerprint);
      assert.equal(result.data.gate, null);
    }
    assert.equal(h.sends, 0);
    assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
    assert.equal(await h.bb.storage.kv.get('deliveries:thr_test'), undefined);
    const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(after.items.map((i: any) => i.id), ['aif-plan', 'aif-explore']);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('Markdown invocation arguments reach the composer verbatim with no delimiters or hidden prompt', async () => {
  for (const runtime of ['codex-app', 'claude']) {
    const h = await setup(); try {
      h.value.runtime = runtime;
      h.setOutput('Далее `/aif-plan full "@.ai-factory/plans/my plan.md" #177`, затем `/aif-review`.');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      const command = (runtime === 'claude' ? '/' : '$') + 'aif-plan full "@.ai-factory/plans/my plan.md" #177';
      assert.equal(view.items[0].command, command);
      const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)) as any;
      assert.equal(result.sent, false); assert.equal(result.command, command);
      assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-plan');
      assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('a scoped fenced recommendation is offered and drafts only its command after the fix reply', async () => {
  for (const runtime of ['codex-app', 'claude']) {
    const h = await setup(); try {
      h.value.runtime = runtime;
      const command = (runtime === 'claude' ? '/' : '$') + 'aif-implement 71-schedule-templates';
      h.setOutput('Прогресс остаётся 10/15. Теперь можно вернуться к задаче 3.3:\n\n```text\n' + command + '\n```\n\n::aif-chat{phase="fix"}');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      assert.deepEqual(view.items.map((item: any) => item.command), [command]);
      assert.equal(view.items[0].available, true); assert.equal(h.sends, 0);
      const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-implement')) as any;
      assert.equal(result.sent, false); assert.equal(result.command, command);
      assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-implement');
      assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
      assert.deepEqual((await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any).items.map((item: any) => item.command), [command]);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('prefix-free code recommendations become runtime-correct suggestions without extra prompt text', async () => {
  for (const runtime of ['codex-app', 'claude']) {
    const h = await setup(); try {
      h.value.runtime = runtime;
      h.setOutput('Задача заблокирована. Следующий шаг — `aif-fix 71-schedule-templates`. Коммит и push не выполнялись.\n\n::aif-chat{phase="implement"}');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      const command = (runtime === 'claude' ? '/' : '$') + 'aif-fix 71-schedule-templates';
      assert.deepEqual(view.items.map((item: any) => item.command), [command]);
      assert.equal(view.items[0].available, true); assert.equal(h.sends, 0);
      const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')) as any;
      assert.equal(result.sent, false); assert.equal(result.command, command);
      assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-fix');
      assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
      assert.deepEqual((await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any).items.map((item: any) => item.command), [command]);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('slash finalization commands become runtime-correct suggestions and keep the sync subcommand', async () => {
  for (const runtime of ['codex-app', 'claude']) {
    const h = await setup(); try {
      h.value.runtime = runtime;
      h.setOutput('Следующие отдельные шаги: `/aif-mode sync`, затем `/aif-commit`. Commit, push и deploy не выполнялись.');
      const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      const prefix = runtime === 'codex-app' ? '$' : '/';
      assert.deepEqual(view.items.map((i: any) => i.command), [prefix + 'aif-mode sync', prefix + 'aif-commit']);
      assert(view.items.every((i: any) => i.available)); assert.equal(h.sends, 0);
      const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-mode')) as any;
      assert.equal(result.sent, false); assert.equal(result.command, prefix + 'aif-mode sync');
      assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-mode');
      assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
      const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
      assert.deepEqual(after.items.map((i: any) => i.id), ['aif-mode', 'aif-commit']);
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
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)) as { stale?: true }).stale, true);
    h.setOutput('$aif-plan'); h.value = { ...h.value, fingerprint: 'b'.repeat(64) };
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)) as { stale?: true }).stale, true);
    const fresh = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    await h.harness.behavior.callRpc('dismissSuggestion', { threadId: 'thr_test', sourceKey: fresh.sourceKey, commandId: 'aif-plan' });
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(fresh)));
    h.setOutput('Next $aif-missing');
    const missing = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(missing.items, []);
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
test('an uncertain workflow send blocks suggestion checks and workflow retries', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    h.setFailure(true); await assert.rejects(h.harness.behavior.callRpc('run', runInput()));
    h.setFailure(false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)));
    await assert.rejects(h.harness.behavior.callRpc('run', runInput())); assert.equal(h.sends, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('a last answer changing during project inspection cannot dispatch an old command', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-plan');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    let reads = 0;
    h.harness.sdk.stub('threads.output', async () => ({ output: ++reads === 1 ? '$aif-plan' : '$aif-explore' }));
    assert.equal((await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view)) as { stale?: true }).stale, true);
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
    const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')) as any;
    assert.equal(result.sent, false); assert.equal(result.command, '$aif-fix Address advisories separately.');
    assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.gate.gate, 'security');
    assert.equal(result.data.gate.blockers[0].summary, 'Development dependency advisories remain.');
    assert.equal(h.sends, 0);
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
test('structured gate next step becomes a runtime-correct suggestion carrying the gate as data', async () => {
  const h = await setup(); try {
    h.setOutput(gateText());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gate.status, 'warn'); assert.equal(view.gate.blocking, false); assert.equal(view.gateError, null);
    assert.equal(view.items[0].command, '$aif-commit'); assert.match(view.items[0].reason, /non-blocking/);
    const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')) as any;
    assert.equal(result.sent, false); assert.equal(result.command, '$aif-commit');
    assert.equal(result.data.source, 'aif-chat'); assert.equal(result.data.commandId, 'aif-commit');
    assert.deepEqual(result.data.gate.affected_files, ['src/demo.ts']);
    assert.match(result.data.gate.suggested_next.reason, /non-blocking warnings/);
    assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('review string blockers survive RPC and block commit while the explicit fix remains runnable', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-commit\n' + gateText({ gate: 'review', status: 'fail', blocking: true,
      blockers: ['R1: TypeScript worker drops effective read_only restrictions from claim responses.',
        'R2: Deleted review target with preserved head is accepted by worker policy guard.'],
      suggested_next: { command: '$aif-fix', reason: 'Fix R1 and R2.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gateError, null); assert.equal(view.gate.blocking, true);
    assert.deepEqual(view.gate.blockers.map((b: any) => [b.id, b.severity]), [['R1', 'error'], ['R2', 'error']]);
    assert.equal(view.items.find((i: any) => i.id === 'aif-fix').available, true);
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    assert.equal(h.sends, 0);
    const fixed = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')) as any;
    assert.equal(fixed.sent, false); assert.equal(fixed.command, '$aif-fix Fix R1 and R2.');
    assert.equal(fixed.data.gate.blocking, true);
    assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
    assert.equal((await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any).gate.blockers.length, 2);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('blocking gate disables prose commit and carries the actual problems to the fix owner as data', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-commit\n' + gateText({ status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', summary: 'Required implementation is missing.', file: 'src/demo.ts' }], suggested_next: { command: '/aif-fix', reason: 'Fix the blocking finding.' } }));
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    assert.equal(h.sends, 0);
    const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')) as any;
    assert.equal(result.sent, false); assert.equal(result.command, '$aif-fix Fix the blocking finding.');
    assert.equal(result.data.gate.blocking, true);
    assert.equal(result.data.gate.blockers[0].summary, 'Required implementation is missing.');
    const after = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(after.gate.blockers.length, 1); // hiding a command never removes gate findings
  } finally { await h.harness.lifecycle.dispose(); }
});
test('valid nonterminal FAIL exposes a format warning and fix while keeping advancement blocked', async () => {
  const h = await setup(); try {
    h.setOutput('$aif-commit\n' + gateText({ gate: 'review', status: 'fail', blocking: true,
      blockers: [{ id: 'windows-project-path-prefix', severity: 'error', summary: 'Windows path-prefix check fails.' },
        { id: 'worker-failure-aborts-run-burns-attempts', severity: 'error', summary: 'Sibling attempts are consumed.' }],
      suggested_next: { command: '$aif-fix', reason: 'Fix both blockers.' } }) + '\nИтог: две блокирующие находки. `$aif-archive`');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gateError, null); assert(view.gateWarning); assert.equal(view.gate.blockers.length, 2);
    assert.equal(view.items.find((i: any) => i.id === 'aif-fix').available, true);
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').available, false);
    assert(!view.items.some((i: any) => i.id === 'aif-archive'));
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    assert.equal(h.sends, 0);
    const fixed = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-fix')) as any;
    assert.equal(fixed.sent, false); assert.equal(fixed.command, '$aif-fix Fix both blockers.');
    assert.equal(fixed.data.gate.blocking, true);
    assert.equal(h.sends, 0); assert.equal(h.harness.inspection.sdk.callsTo('threads.send').length, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('nonterminal PASS cannot advance through suggestions or workflow, and trailing commands are ignored', async () => {
  const h = await setup(); try {
    h.value.target!.tasks = h.value.target!.tasks.map(task => ({ ...task, done: true }));
    h.value.actions = workflowActions(h.value);
    h.setOutput('$aif-commit\n' + gateText({ status: 'pass', suggested_next: null }) + '\nActually, /aif-implement');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gateError, null); assert(view.gateWarning); assert.equal(view.gate.status, 'pass');
    assert.equal(view.items.length, 1); assert.equal(view.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit')));
    await assert.rejects(h.harness.behavior.callRpc('run', { ...runInput(), actionId: 'commit' }));
    assert.equal(h.sends, 0);
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
test('uninstalled reply commands are hidden while a gate next step stays visible but unavailable', async () => {
  const h = await setup(); try {
    h.setOutput('Сначала /aif-plan, затем /aif-composer-mode.');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(view.items.map((i: any) => i.id), ['aif-plan']);
    h.setOutput(gateText({ suggested_next: { command: '/aif-rules', reason: 'Check the rules gate.' } }));
    const gated = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(gated.items.length, 1);
    assert.equal(gated.items[0].id, 'aif-rules');
    assert.equal(gated.items[0].available, false);
    await assert.rejects(h.harness.behavior.callRpc('runSuggestion', suggestionInput(gated, 'aif-rules')));
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('plugin-shipped /aif-scout <topic> yields an available chip without being in snapshot.skills', async () => {
  const h = await setup(); try {
    assert(!h.value.skills.includes('aif-scout'));
    h.setOutput('Следующий шаг: /aif-scout ограничения stdio.');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const item = view.items.find((i: any) => i.id === 'aif-scout');
    assert(item, 'aif-scout chip offered');
    assert.equal(item.available, true);
    assert.equal(item.command, '$aif-scout ограничения stdio');
    const result = await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-scout')) as any;
    assert.equal(result.sent, false);
    assert.equal(result.command, '$aif-scout ограничения stdio');
    assert.equal(h.sends, 0);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('a broken project AI Factory config keeps the plugin-shipped scout chip available', async () => {
  const h = await setup(); try {
    h.value = { ...h.value, profile: 'invalid', skills: [] };
    h.setOutput('Следующий шаг: /aif-scout "Node.js compatibility on Windows"');
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    const item = view.items.find((i: any) => i.id === 'aif-scout');
    assert(item, 'aif-scout chip offered');
    assert.equal(item.available, true, item.reason);
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

test('a child thread going idle invalidates its own and its parent thread tags', async () => {
  const h = await setup(); try {
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_child', parentThreadId: 'thr_test' }), lastAssistantText: null });
    const tags = h.harness.inspection.experimental_rpcInvalidations.flatMap(entry => entry ?? []);
    assert.ok(tags.includes('thread:thr_child'));
    assert.ok(tags.includes('thread:thr_test'));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('readiness skip marks persist per project, overlay status and reject non-skippable steps', async () => {
  const h = await setup();
  try {
    const value = h.value; value.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} }); h.value = value;
    const ci = async () => ((await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true })) as any).readiness.find((r: any) => r.id === 'ci').state;
    assert.equal(await ci(), 'todo');
    assert.deepEqual(await h.harness.behavior.callRpc('setReadinessSkip', { threadId: 'thr_test', stepId: 'ci', skipped: true }), { ok: true });
    assert.equal(await ci(), 'skipped');
    assert.deepEqual(await h.bb.storage.kv.get('readiness-skip:host_test:/project'), ['ci']);
    await h.harness.behavior.callRpc('setReadinessSkip', { threadId: 'thr_test', stepId: 'ci', skipped: false });
    assert.equal(await ci(), 'todo');
    await assert.rejects(h.harness.behavior.callRpc('setReadinessSkip', { threadId: 'thr_test', stepId: 'context', skipped: true }));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('documentation counts as done only after /aif-docs was launched from the readiness block', async () => {
  const h = await setup();
  try {
    const value = snapshot({ phase: 'unknown', target: null, skills: [...snapshot().skills, 'aif-docs'] });
    value.readiness = readinessSteps({ configured: true, contextSkill: true, files: { 'docs/notes.md': true }, paths: {} }); h.value = value;
    const docs = (view: any) => view.readiness.find((r: any) => r.id === 'docs').state;
    const view = await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true }) as any;
    assert.equal(docs(view), 'todo', 'an existing docs/ folder is not proof of /aif-docs');
    await h.harness.behavior.callRpc('run', { ...runInput(view.fingerprint), phase: 'unknown', target: '', actionId: 'docs-setup' });
    assert.deepEqual(await h.bb.storage.kv.get('readiness-ran:host_test:/project'), ['docs']);
    assert.equal(docs(await h.harness.behavior.callRpc('status', { threadId: 'thr_test', force: true })), 'done');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('setAifMode invalidates the project tag and the thread tag when a thread is given', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('setAifMode', { projectId: 'proj_test', on: true });
    let tags = h.harness.inspection.experimental_rpcInvalidations.flatMap(entry => entry ?? []);
    assert.ok(tags.includes('project:proj_test'));
    await h.harness.behavior.callRpc('setAifMode', { threadId: 'thr_test', on: false });
    tags = h.harness.inspection.experimental_rpcInvalidations.flatMap(entry => entry ?? []);
    assert.ok(tags.includes('project:proj_test'));
    assert.ok(tags.includes('thread:thr_test'));
  } finally { await h.harness.lifecycle.dispose(); }
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const hostCallsOf = <T extends { method: string }>(calls: T[], method: string) => calls.filter(call => call.method === method);

test('watched status reads share one host watch per root and unwatch when the last read ends', async () => {
  const h = await setup(); try {
    const stopA = h.harness.behavior.experimental_watchRpc('status', { input: { threadId: 'thr_test' } });
    const stopB = h.harness.behavior.experimental_watchRpc('status', { input: { threadId: 'thr_test', phase: 'verify' } });
    await tick();
    const watches = hostCallsOf(h.hostCalls, 'watch');
    assert.equal(watches.length, 1);
    assert.deepEqual(watches[0].input, { root: '/project' });
    assert.equal(watches[0].hostId, 'host_test');
    stopA();
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'unwatch').length, 0);
    stopB();
    await tick();
    const unwatches = hostCallsOf(h.hostCalls, 'unwatch');
    assert.equal(unwatches.length, 1);
    assert.deepEqual(unwatches[0].input, { root: '/project' });
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a filesChanged host signal invalidates watching threads and the next status re-collects', async () => {
  const h = await setup(); try {
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan' });
    await tick();
    const collected = h.collections;
    const invalidations = h.harness.inspection.experimental_rpcInvalidations.length;
    await h.harness.behavior.experimental_emitHostSignal('host_test', 'filesChanged', { root: '/project' });
    await tick();
    assert.ok(h.harness.inspection.experimental_rpcInvalidations.slice(invalidations).some(entry => entry?.includes('thread:thr_test')));
    await h.harness.behavior.callRpc('status', { threadId: 'thr_test', phase: 'plan' });
    await tick();
    assert(h.collections > collected);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('watchLost retries the host watch once, then warns and stays unwatched', async () => {
  const h = await setup(); try {
    const stop = h.harness.behavior.experimental_watchRpc('status', { input: { threadId: 'thr_test' } });
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'watch').length, 1);
    await h.harness.behavior.experimental_emitHostSignal('host_test', 'watchLost', { root: '/project', reason: 'fsnotify died' });
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'watch').length, 2);
    await h.harness.behavior.experimental_emitHostSignal('host_test', 'watchLost', { root: '/project', reason: 'still dead' });
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'watch').length, 2);
    assert.ok(h.harness.inspection.logEntries.some(entry => entry.level === 'warn' && entry.message.includes('watch lost')));
    stop();
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a watch loss long after a successful retry gets its own retry', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const h = await setup(); try {
    const stop = h.harness.behavior.experimental_watchRpc('status', { input: { threadId: 'thr_test' } });
    await tick();
    await h.harness.behavior.experimental_emitHostSignal('host_test', 'watchLost', { root: '/project', reason: 'fsnotify died' });
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'watch').length, 2);
    now += 10 * 60_000;
    await h.harness.behavior.experimental_emitHostSignal('host_test', 'watchLost', { root: '/project', reason: 'died again later' });
    await tick();
    assert.equal(hostCallsOf(h.hostCalls, 'watch').length, 3);
    stop();
  } finally { await h.harness.lifecycle.dispose(); }
});
