import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import type { DelegationChoice, DelegationDefaults, DelegationRole, DelegationState } from '../delegation.ts';

const pick = (providerId: string, model: string): DelegationChoice => ({ mode: 'bb', providerId, model });
const DEFAULTS: DelegationDefaults = { implement: pick('devin', 'swe-2-flash'), research: pick('codex', 'gpt-6.2-luna'), research2: { mode: 'self' }, research3: { mode: 'self' } };
const APPLIED_KEY = 'delegation-defaults-applied:host_test:/project';
const writes = (h: { hostCalls: { method: string; input: any }[] }) =>
  h.hostCalls.filter(c => c.method === 'setDelegation').map(c => c.input as { role?: DelegationRole; choice: DelegationChoice });

async function setup() {
  const state: DelegationState = { choice: { mode: 'self' }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null };
  const hostCalls: { method: string; input: any }[] = [];
  const value = snapshot(); value.actions = workflowActions(value);
  const thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat', 'aif-scout'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, list: async () => [] },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
      providers: { list: async () => [] },
    },
    experimental_callHostRpc: async call => {
      hostCalls.push({ method: call.method, input: structuredClone(call.input) });
      if (call.method === 'collect') return structuredClone(value);
      if (call.method === 'delegation') return structuredClone(state);
      if (call.method === 'setDelegation') {
        const input = call.input as { choice: DelegationChoice; role?: DelegationRole };
        const role = input.role ?? 'implement';
        if (role === 'implement') state.choice = input.choice; else state[role] = input.choice;
        return structuredClone(state);
      }
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { ...h, state, hostCalls };
}

test('from-project stores the four project roles as plugin-wide defaults; an all-self project has nothing to take', async () => {
  const h = await setup();
  try {
    h.state.choice = pick('devin', 'swe-2-flash');
    h.state.research = pick('codex', 'gpt-6.2-luna');
    await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'from-project' });
    assert.deepEqual(await h.bb.storage.kv.get('delegation-defaults'), DEFAULTS);
    h.state.choice = { mode: 'self' }; h.state.research = { mode: 'self' };
    await assert.rejects(h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'from-project' }), /брать нечего/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('defaults auto-apply once to a configured all-self project and name what was written', async () => {
  const h = await setup();
  try {
    await h.bb.storage.kv.set('delegation-defaults', DEFAULTS);
    const first = await h.harness.behavior.callRpc('delegation', { threadId: 'thr_test' }) as any;
    assert.ok(first.appliedDefaults.startsWith('Применены модели по умолчанию'));
    assert.match(first.appliedDefaults, /Код — devin\/swe-2-flash/);
    assert.deepEqual(writes(h).map(c => c.role ?? 'implement'), ['implement', 'research', 'research2', 'research3']);
    assert.ok(await h.bb.storage.kv.get(APPLIED_KEY));
    const count = writes(h).length;
    const second = await h.harness.behavior.callRpc('delegation', { threadId: 'thr_test' }) as any;
    assert.equal(second.appliedDefaults, null);
    assert.equal(writes(h).length, count);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('auto-apply stays off for a configured role, an existing mark, missing defaults or an unconfigured project', async () => {
  const scenarios: Array<(h: Awaited<ReturnType<typeof setup>>) => Promise<void>> = [
    async h => { await h.bb.storage.kv.set('delegation-defaults', DEFAULTS); h.state.choice = pick('devin', 'swe-2-flash'); },
    async h => { await h.bb.storage.kv.set('delegation-defaults', DEFAULTS); await h.bb.storage.kv.set(APPLIED_KEY, new Date().toISOString()); },
    async () => {},
    async h => { await h.bb.storage.kv.set('delegation-defaults', DEFAULTS); h.state.configured = false; },
  ];
  for (const prepare of scenarios) {
    const h = await setup();
    try {
      await prepare(h);
      const view = await h.harness.behavior.callRpc('delegation', { threadId: 'thr_test' }) as any;
      assert.equal(view.appliedDefaults, null);
      assert.equal(writes(h).length, 0);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});

test('a foreign phases.implement is skipped while the research defaults still apply', async () => {
  const h = await setup();
  try {
    await h.bb.storage.kv.set('delegation-defaults', DEFAULTS);
    h.state.foreign = 'other';
    const view = await h.harness.behavior.callRpc('delegation', { threadId: 'thr_test' }) as any;
    assert.deepEqual(writes(h).map(c => c.role ?? 'implement'), ['research', 'research2', 'research3']);
    assert.equal(h.state.choice.mode, 'self');
    assert.equal(h.state.research.mode, 'bb');
    assert.match(view.appliedDefaults, /Разведчик 1 — codex\/gpt-6\.2-luna/);
    assert(!view.appliedDefaults.includes('Код —'));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a manual role save marks the project so stored defaults never auto-apply', async () => {
  const h = await setup();
  try {
    await h.bb.storage.kv.set('delegation-defaults', DEFAULTS);
    await h.harness.behavior.callRpc('setDelegation', { threadId: 'thr_test', role: 'implement', choice: { mode: 'self' } });
    assert.ok(await h.bb.storage.kv.get(APPLIED_KEY));
    const count = writes(h).length;
    const view = await h.harness.behavior.callRpc('delegation', { threadId: 'thr_test' }) as any;
    assert.equal(view.appliedDefaults, null);
    assert.equal(writes(h).length, count);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('apply writes every default role and clear removes the stored defaults from the view', async () => {
  const h = await setup();
  try {
    await h.bb.storage.kv.set('delegation-defaults', DEFAULTS);
    const applied = await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'apply' }) as any;
    assert.equal(writes(h).length, 4);
    assert.deepEqual(writes(h).map(c => c.role ?? 'implement'), ['implement', 'research', 'research2', 'research3']);
    assert.deepEqual(applied.defaults, DEFAULTS);
    const cleared = await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'clear' }) as any;
    assert.equal(await h.bb.storage.kv.get('delegation-defaults'), undefined);
    assert.equal(cleared.defaults, null);
  } finally { await h.harness.lifecycle.dispose(); }
});
