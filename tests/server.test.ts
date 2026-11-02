import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { cardDirective } from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';

async function setup() {
  let value = snapshot(); value.actions = workflowActions(value);
  let sends = 0;
  let failSend = false;
  let pending = 0;
  let thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, send: async () => { sends++; if (failSend) throw new Error('lost connection'); return {} as any; }, interactions: { list: async () => Array.from({ length: pending }, () => ({})) as any } },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async () => structuredClone(value),
  });
  await plugin(h.bb);
  return { ...h, get value() { return value; }, set value(v) { value = v; }, get sends() { return sends; },
    setFailure(v: boolean) { failSend = v; }, setPending(v: number) { pending = v; }, setActive(v: boolean) { thread = { ...thread, status: v ? 'active' : 'idle', runtime: { displayStatus: v ? 'active' : 'idle' } }; } };
}
function runInput(fingerprint = 'a'.repeat(64)) { return { threadId: 'thr_test', target: '.ai-factory/plans/demo.md', phase: 'plan', fingerprint, actionId: 'improve', requestId: randomUUID() }; }

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
    assert(!JSON.stringify(calls[0]).includes('permissionMode')); assert(!JSON.stringify(calls[0]).includes('model'));
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
