import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import { childModel } from '../child-model.ts';
import { aifMentionItems } from '../aif-mode.ts';

async function setup() {
  const value = snapshot(); value.actions = workflowActions(value);
  let output: string | null = null;
  let eventRows: any[] = [];
  const thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat', 'aif-scout'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread,
        events: { list: async (args: any) => {
          let rows = eventRows.filter(r => !args.types || args.types.includes(r.type));
          if (args.afterSeq !== undefined) rows = rows.filter(r => r.seq > Number(args.afterSeq));
          if (args.beforeSeq !== undefined) rows = rows.filter(r => r.seq < Number(args.beforeSeq));
          return [...rows].sort((a, b) => args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit));
        } },
        output: async () => ({ output }), send: async () => ({}) as any, interactions: { list: async () => [] as any } },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async () => structuredClone(value),
  });
  await plugin(h.bb);
  return { ...h,
    setOutput(text: string | null) { output = text; }, setEvents(rows: any[]) { eventRows = rows; } };
}
const agentContext = (parentThreadId: string | null = null, projectId = 'proj_test') =>
  makePluginAgentConfigurationContext({ project: { id: projectId }, thread: { parentThreadId } });
const turnRow = (seq: number) => ({ seq, type: 'client/turn/requested', data: { input: [] } });

test('mode instructions reach only top-level threads of an enabled project', async () => {
  const h = await setup();
  try {
    const provider = h.harness.inspection.registrations.agentConfigurationProvider!;
    assert(provider, 'configure provider registered');
    assert.deepEqual(provider(agentContext()).skills, ['aif-chat', 'aif-scout']);
    assert(!provider(agentContext()).instructions?.includes('## AI Factory mode'));
    await h.harness.behavior.callRpc('setAifMode', { projectId: 'proj_test', on: true });
    const enabled = provider(agentContext());
    assert.deepEqual(enabled.skills, ['aif-chat', 'aif-scout']);
    assert(enabled.instructions?.includes('## AI Factory mode'));
    assert(enabled.instructions?.includes('/aif-scout'));
    assert(enabled.instructions?.includes('offer `/aif-scout "<topic>"` as a next step'));
    assert(!provider(agentContext('thr_parent')).instructions?.includes('/aif-scout "<topic>"'));
    assert(!provider(agentContext('thr_parent')).instructions?.includes('## AI Factory mode'));
    assert(!provider(agentContext(null, 'proj_other')).instructions?.includes('## AI Factory mode'));
    await h.harness.behavior.setSettings({ enabled: false });
    assert.equal(provider(agentContext()).instructions, '');
    assert.deepEqual(provider(agentContext()).skills, []);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('aifMode and setAifMode require exactly one target; the view carries no pill flag', async () => {
  const h = await setup();
  try {
    const rpc = h.harness.behavior.callRpc.bind(h.harness.behavior);
    await assert.rejects(rpc('aifMode', {}));
    await assert.rejects(rpc('aifMode', { threadId: 'thr_test', projectId: 'proj_test' }));
    await assert.rejects(rpc('setAifMode', { on: true }));
    await assert.rejects(rpc('setAifMode', { threadId: 'thr_test', projectId: 'proj_test', on: true }));
    // The owner asked for no «AI Factory» tag in the chat input: turning the mode on in a running chat inserts nothing.
    h.setEvents([turnRow(1)]);
    let view = await rpc('setAifMode', { threadId: 'thr_test', on: true }) as any;
    assert.deepEqual(view, { projectId: 'proj_test', on: true, configured: true });
    view = await rpc('setAifMode', { threadId: 'thr_test', on: false }) as any;
    assert.equal(view.on, false);
    view = await rpc('aifMode', { projectId: 'proj_test' }) as any;
    assert.deepEqual(view, { projectId: 'proj_test', on: false, configured: null });
    view = await rpc('aifMode', { threadId: 'thr_test' }) as any;
    assert.equal(view.configured, true);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('the aif-mode mention provider finds the pill and resolves mode instructions', async () => {
  const h = await setup();
  try {
    const mention = h.harness.inspection.registrations.mentionProviders.find(p => p.id === 'aif-mode')!;
    assert(mention, 'mention provider registered');
    const search = async (query: string) => await Promise.resolve(mention.search({ trigger: '@', query, projectId: 'proj_test', threadId: 'thr_test' }));
    const found = await search('aif');
    assert.equal(found.length, 1); assert.equal(found[0].id, 'aif-mode');
    assert.deepEqual(await search('xyz'), []);
    const resolved = await Promise.resolve(mention.resolve('aif-mode'));
    assert.match(resolved.context, /## AI Factory mode/);
    assert.throws(() => mention.resolve('other'));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('fallback suggestions offer next actions only while the project mode is on', async () => {
  const h = await setup();
  try {
    h.setOutput('');
    let view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.deepEqual(view.items, []);
    await h.harness.behavior.callRpc('setAifMode', { projectId: 'proj_test', on: true });
    view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert(view.items.length > 0);
    assert(view.items.every((i: any) => i.reason === 'Следующий шаг' && i.available));
    assert(view.items.some((i: any) => i.id === 'aif-improve'));
    assert(view.items.some((i: any) => i.id === 'aif-implement'));
    assert.equal(view.origin, 'plan', 'plan-derived chips are labelled as plan steps, not reply commands');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('childModel reports the requested model, a later provider fallback and choice mismatches', () => {
  const bb = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' };
  const state = { choice: bb, research: { mode: 'self' as const }, research2: bb, research3: { mode: 'self' as const } };
  const self = { choice: { mode: 'self' as const }, research: { mode: 'self' as const }, research2: { mode: 'self' as const }, research3: { mode: 'self' as const } };
  const request = (seq: number, model = 'gpt-6.2-sol', reasoningLevel: string | null = 'high') =>
    ({ seq, type: 'client/turn/requested', data: { execution: { model, ...(reasoningLevel ? { reasoningLevel } : {}) } } });
  const fallback = (seq: number) => ({ seq, type: 'provider/modelFallback',
    data: { originalModel: 'gpt-6.2-sol', fallbackModel: 'gpt-6.2-mini', reason: 'refusal' } });

  assert.deepEqual(childModel([request(1)], { title: 'AIF · demo · 1', providerId: 'codex' }, state),
    { execution: { model: 'gpt-6.2-sol', reasoning: 'high' }, fallback: null, mismatch: null });
  assert.deepEqual(childModel([fallback(2), request(1)], { title: 'AIF · demo · 1', providerId: 'codex' }, state).fallback,
    { from: 'gpt-6.2-sol', to: 'gpt-6.2-mini', reason: 'refusal' });
  assert.equal(childModel([request(2), fallback(1)], { title: 'AIF · demo · 1', providerId: 'codex' }, state).fallback, null);
  const wrong = childModel([request(1, 'gpt-6.2-luna')], { title: 'AIF · demo · 1', providerId: 'codex' }, state);
  assert.equal(wrong.mismatch, 'Ожидалась модель codex · gpt-6.2-sol');
  assert.equal(childModel([request(1)], { title: 'AIF research · plan · 2', providerId: 'codex' }, state).mismatch, null);
  assert.equal(childModel([request(1, 'anything')], { title: 'AIF · demo · 1', providerId: 'codex' }, self).mismatch, null);
  assert.equal(childModel([request(1, 'anything')], { title: 'Обычный тред', providerId: 'codex' }, state).mismatch, null);
  assert.equal(childModel([], { title: 'AIF · demo · 1', providerId: 'codex' }, state).execution, null);
});

test('aif mention search matches term prefixes in both languages and nothing else', () => {
  for (const q of ['', ' AIF ', 'fac', 'фаб', 'реж', 'ai f']) assert.equal(aifMentionItems(q).length, 1, q);
  for (const q of ['xyz', 'aifx', 'plan']) assert.deepEqual(aifMentionItems(q), [], q);
});
