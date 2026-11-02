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
  let output: string | null = null;
  let events: any[] = [];
  let thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, events: { list: async (args: any) => { assert(Number(args.limit) <= 100); return events; } }, output: async () => ({ output }), send: async () => { sends++; if (failSend) throw new Error('lost connection'); return {} as any; }, interactions: { list: async () => Array.from({ length: pending }, () => ({})) as any } },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async () => structuredClone(value),
  });
  await plugin(h.bb);
  return { ...h, get value() { return value; }, set value(v) { value = v; }, get sends() { return sends; },
    setEvents(rows: any[]) { events = rows; }, setOutput(text: string | null) { output = text; }, setQueued(count: number) { thread = { ...thread, queuedMessageCount: count }; },
    setFailure(v: boolean) { failSend = v; }, setPending(v: number) { pending = v; }, setActive(v: boolean) { thread = { ...thread, status: v ? 'active' : 'idle', runtime: { displayStatus: v ? 'active' : 'idle' } }; } };
}
function runInput(fingerprint = 'a'.repeat(64)) { return { threadId: 'thr_test', target: '.ai-factory/plans/demo.md', phase: 'plan', fingerprint, actionId: 'improve', requestId: randomUUID() }; }

test('status restores completed verify from chat, persists across reload and does not invent file evidence', async () => {
  const h = await setup(); let live = h.harness;
  try {
    h.value.checks = [{ id: 'verify', label: 'Verify', state: 'notrun', path: null, detail: 'Missing', required: false }];
    h.setEvents([{ seq: 12, createdAt: Date.now(), type: 'item/completed', data: { item: { type: 'agentMessage', text: gateText({ affected_files: ['.ai-factory/plans/demo.md'] }) } } }]);
    const first = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(first.checks[0].chat.result.status, 'warn'); assert.equal(first.checks[0].state, 'notrun');
    h.setEvents([]); h.setOutput('Later answer without a gate');
    live = (await live.lifecycle.reload(plugin)).harness;
    const restored = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
    assert.equal(restored.checks[0].chat.seq, 12); assert.equal(h.sends, 0);
    h.value = { ...h.value, root: '/different-checkout' };
    live = (await live.lifecycle.reload(plugin)).harness;
    const other = await live.behavior.callRpc('status', { threadId: 'thr_test' }) as any;
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
test('structured gate next step becomes a runtime-correct suggestion, with the reason and gate context', async () => {
  const h = await setup(); try {
    h.setOutput(gateText());
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.gate.status, 'warn'); assert.equal(view.gate.blocking, false); assert.equal(view.gateError, null);
    assert.equal(view.items[0].command, '$aif-commit'); assert.match(view.items[0].reason, /non-blocking/);
    await h.harness.behavior.callRpc('runSuggestion', suggestionInput(view, 'aif-commit'));
    const call = JSON.stringify(h.harness.inspection.sdk.callsTo('threads.send')[0]);
    assert.match(call, /\$aif-commit/); assert.match(call, /affected_files/); assert.match(call, /non-blocking warnings/); assert.equal(h.sends, 1);
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
