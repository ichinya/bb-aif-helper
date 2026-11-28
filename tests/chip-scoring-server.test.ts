import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { DECISIONS_URL } from '../chip-scoring.ts';

async function setup(options: { variables?: string[]; catalogError?: boolean; settings?: Record<string, string | number | boolean> } = {}) {
  const calls: any[] = [];
  const h = createFakePluginHost({
    pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    settings: options.settings,
    sdk: {
      plugins: {
        callRpc: async (args: any) => {
          calls.push(args);
          if (options.catalogError) throw new Error('env-catalog is not installed');
          if (args.method === 'env_list') return { variables: (options.variables ?? []).map(name => ({ name })) };
          if (args.method === 'env_get_value') return { name: (args.input as any).name, kind: 'secret', value: 'catalog-secret-value' };
          throw new Error(`unexpected rpc ${args.method}`);
        },
      },
    },
  });
  await plugin(h.bb);
  return { h, calls };
}

test('chipScoring returns defaults and reports the catalog as unavailable', async () => {
  const { h } = await setup({ catalogError: true });
  try {
    const view = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.deepEqual(view, { enabled: false, suggestFromContext: false, source: 'catalog', catalogName: null, catalogAvailable: false,
      catalogNames: [], manualKeySet: false, connection: null, lastError: null, lastScoredAt: null, lastRequestAt: null });
    assert(h.harness.inspection.logEntries.some(e => e.level === 'warn' && e.message.includes('env-catalog unavailable')));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('chipScoring lists catalog secret names with GEMINI entries first', async () => {
  const { h, calls } = await setup({ variables: ['B_KEY', 'GEMINI_API_KEY_AISTUDIO', 'A_KEY', 'gemini_secondary'] });
  try {
    const view = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(view.catalogAvailable, true);
    assert.deepEqual(view.catalogNames, ['GEMINI_API_KEY_AISTUDIO', 'gemini_secondary', 'A_KEY', 'B_KEY']);
    const list = calls.find(c => c.method === 'env_list');
    assert.deepEqual(list?.input, { kind: 'secret' });
    assert(list?.signal instanceof AbortSignal);
    assert(list?.pluginId === 'env-catalog');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('setChipScoring stores a manual key without leaking it into output, kv or logs', async () => {
  const secret = 'sk-decisions-test-secret-9f8e7d';
  const { h } = await setup({ catalogError: true });
  try {
    const view = await h.harness.behavior.callRpc('setChipScoring', { source: 'manual', manualKey: secret, enabled: true }) as any;
    assert.equal(view.source, 'manual'); assert.equal(view.enabled, true); assert.equal(view.manualKeySet, true);
    assert(!JSON.stringify(view).includes(secret));
    const stored = await h.bb.storage.kv.get('chip-scoring') as any;
    assert.equal(stored.source, 'manual'); assert(!JSON.stringify(stored).includes(secret));
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes(secret)));
    assert(h.harness.inspection.logEntries.some(e => e.message === 'aif-chat: chip scoring settings enabled=true source=manual'));
    const again = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(again.manualKeySet, true);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('setChipScoring manualKey null clears the stored secret', async () => {
  const { h } = await setup({ settings: { decisionsKey: 'preset-secret' } });
  try {
    const before = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(before.manualKeySet, true);
    const view = await h.harness.behavior.callRpc('setChipScoring', { manualKey: null }) as any;
    assert.equal(view.manualKeySet, false);
    assert(!JSON.stringify(view).includes('preset-secret'));
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes('preset-secret')));
  } finally { await h.harness.lifecycle.dispose(); }
});

test('setChipScoring persists source and catalogName and keeps other fields', async () => {
  const { h } = await setup({ variables: ['GEMINI_API_KEY'] });
  try {
    const view = await h.harness.behavior.callRpc('setChipScoring', { source: 'catalog', catalogName: 'GEMINI_API_KEY', enabled: true }) as any;
    assert.equal(view.source, 'catalog'); assert.equal(view.catalogName, 'GEMINI_API_KEY'); assert.equal(view.enabled, true);
    const again = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(again.catalogName, 'GEMINI_API_KEY'); assert.equal(again.enabled, true);
  } finally { await h.harness.lifecycle.dispose(); }
});

async function setupScoring(options: { history?: import('../check-history.ts').HistoryRow[]; reply?: string; settings?: Record<string, string | number | boolean>; variables?: string[]; catalogError?: boolean } = {}) {
  const rpcCalls: any[] = [];
  const h = createFakePluginHost({
    pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    settings: options.settings,
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } }),
        output: async () => ({ output: options.reply ?? '$aif-plan tighten the gate; then $aif-explore leftovers' }),
        events: { list: async () => options.history ?? [] },
        interactions: { list: async () => [] },
      },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
      plugins: {
        callRpc: async (args: any) => {
          rpcCalls.push(args);
          if (options.catalogError) throw new Error('env-catalog is not installed');
          if (args.method === 'env_list') return { variables: (options.variables ?? []).map(name => ({ name })) };
          if (args.method === 'env_get_value') return { name: (args.input as any).name, kind: 'secret', value: 'catalog-secret' };
          throw new Error(`unexpected rpc ${args.method}`);
        },
      },
    },
    experimental_callHostRpc: async () => structuredClone(snapshot()),
  });
  await plugin(h.bb);
  return { h, rpcCalls };
}
function stubFetch(impl: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: unknown; init: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url, init }); return impl(init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const tick = () => new Promise(r => setTimeout(r, 5));
async function waitFor(check: () => Promise<boolean> | boolean, tries = 200) {
  for (let i = 0; i < tries; i++) { if (await check()) return true; await tick(); }
  return false;
}

test('chip scoring disabled: no fetch, no key read, probabilities stay null', async () => {
  const { h, rpcCalls } = await setupScoring({ reply: '$aif-plan alpha checks; then $aif-explore beta leftovers' });
  const fetch = stubFetch(() => { throw new Error('fetch must not be called'); });
  try {
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.length, 2);
    assert(view.items.every((i: any) => i.probability === null));
    await tick(); await tick();
    assert.equal(fetch.calls.length, 0);
    assert(rpcCalls.every(c => c.method !== 'env_get_value'));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring enabled: async fetch fills probabilities once per sourceKey', async () => {
  const key = 'gemini-decisions-secret-TESTKEY';
  const { h } = await setupScoring({ reply: '$aif-plan tighten the gate; then $aif-explore leftovers' });
  const fetch = stubFetch(() => new Response(JSON.stringify({ answers: { next: { probabilities: { 'aif-plan': 0.8, 'aif-explore': 0.2 } } } }), { status: 200 }));
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'manual', manualKey: key });
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    const first = await read();
    assert(first.items.every((i: any) => i.probability === null));
    const scored = await waitFor(async () => (await read()).items.some((i: any) => i.probability !== null));
    assert(scored, 'probabilities never arrived');
    const view = await read();
    assert.equal(view.items.find((i: any) => i.id === 'aif-plan').probability, 0.8);
    assert.equal(view.items.find((i: any) => i.id === 'aif-explore').probability, 0.2);
    assert.equal(fetch.calls.length, 1);
    await read(); await read();
    assert.equal(fetch.calls.length, 1);
    const call = fetch.calls[0];
    assert.equal(call.url, DECISIONS_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['x-goog-api-key'], key);
    const body = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(body.questions.next.criteria).sort(), ['aif-explore', 'aif-plan']);
    const tags = h.harness.inspection.experimental_rpcInvalidations.flatMap(entry => entry ?? []);
    assert.ok(tags.includes('thread:thr_test'));
    assert(h.harness.inspection.logEntries.some(e => e.level === 'info' && e.message.startsWith('aif-chat: chips scored threadId=thr_test options=2 top=aif-plan')));
    const state = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(state.lastError, null);
    assert(state.lastScoredAt > 0);
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes(key)));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('System One scores on the exact endpoint, isolates credentials and refreshes a changed model', async () => {
  const { h, rpcCalls } = await setupScoring({ settings: { decisionsKey: 'google-only' } });
  const endpoint = 'https://gateway.example/custom/v1/systemone';
  const connection = { endpoint, model: 'openrouter/antdigital/lingdt-decision-fast-1.0:free' };
  const customKey = 'system-one-test-key';
  const fetch = stubFetch(() => Response.json({ answers: { next: { probabilities: { 'aif-explore': 0.3, 'aif-plan': 0.7 } } } }));
  const rpc = h.harness.behavior;
  const read = () => rpc.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
  try {
    const view = await rpc.callRpc('setChipScoring', { enabled: true, connection, customKey }) as any;
    assert.deepEqual(view.connection, connection);
    assert(view.manualKeySet);
    assert(!JSON.stringify(view).includes(customKey));
    assert(!JSON.stringify(await h.bb.storage.kv.get('chip-scoring')).includes(customKey));
    assert(await waitFor(async () => (await read()).items.some((i: any) => i.probability === 0.7)));
    const { url, init } = fetch.calls[0];
    assert.equal(url, endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + customKey);
    assert.equal(init.headers['x-goog-api-key'], undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, connection.model);
    assert.match(body.state, /tighten the gate/);
    assert.equal(body.input, undefined);
    assert.deepEqual(Object.keys(body.questions.next.criteria).sort(), ['aif-explore', 'aif-plan']);
    assert(!rpcCalls.some(c => c.method === 'env_get_value'));
    await assert.rejects(rpc.callRpc('setChipScoring', { connection: { ...connection, endpoint: endpoint + '/other' } }));
    await rpc.callRpc('setChipScoring', { connection: { ...connection, model: 'other' } });
    assert(await waitFor(async () => (await read()).items.some((i: any) => i.probability === 0.7)));
    assert.equal(fetch.calls.length, 2);
    assert.equal(JSON.parse(fetch.calls[1].init.body).model, 'other');
    await rpc.callRpc('setChipScoring', { connection: null, source: 'manual' });
    await read();
    assert(await waitFor(() => fetch.calls.length === 3));
    assert.equal(fetch.calls[2].url, DECISIONS_URL);
    assert.equal(fetch.calls[2].init.headers['x-goog-api-key'], 'google-only');
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes(customKey)));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring HTTP failure: cached empty result, lastError set, fetch once', async () => {
  const { h } = await setupScoring({ reply: '$aif-plan harden checks; then $aif-explore the rest' });
  const fetch = stubFetch(() => new Response('denied', { status: 403 }));
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'manual', manualKey: 'k' });
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    await read();
    const failed = await waitFor(async () => (await h.harness.behavior.callRpc('chipScoring', {}) as any).lastError === 'Gemini ответил HTTP 403 — denied');
    assert(failed, 'lastError never set');
    assert.equal(fetch.calls.length, 1);
    const view = await read();
    assert(view.items.every((i: any) => i.probability === null));
    await read();
    assert.equal(fetch.calls.length, 1);
    assert(h.harness.inspection.logEntries.some(e => e.level === 'warn' && e.message === 'aif-chat: chip scoring failed threadId=thr_test: HTTP 403'));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('manual check uses the saved endpoint while disabled, reports a redacted denial and retries after an invalid response', async () => {
  const { h } = await setup();
  const customKey = 'test-provider-credential';
  const connection = { endpoint: 'https://gateway.example/v1/systemone', model: 'some/model:free' };
  const denied = 'Model is not allowed for this API key';
  const results = [
    Response.json({ error: { message: denied + ': ' + customKey } }, { status: 403 }),
    Response.json({ answers: {} }),
    Response.json({ answers: { next: { probabilities: { 'aif-plan': 0.2, 'aif-verify': 0.8 } } } }),
  ];
  const fetch = stubFetch(() => results.shift()!);
  try {
    const rpc = h.harness.behavior;
    await rpc.callRpc('setChipScoring', { connection, customKey });
    const check = () => rpc.callRpc('checkChipScoring', {}) as Promise<any>;
    const rejected = await check();
    assert.equal(rejected.enabled, false);
    assert.equal(rejected.lastError, 'System One ответил HTTP 403 — ' + denied + ': [скрыто]');
    assert.equal(rejected.lastScoredAt, null);
    assert(rejected.lastRequestAt > 0);
    const enabled = await rpc.callRpc('setChipScoring', { enabled: true }) as any;
    assert.equal(enabled.lastError, rejected.lastError);
    assert.equal(enabled.lastRequestAt, rejected.lastRequestAt);
    assert.equal(fetch.calls[0].url, connection.endpoint);
    assert.equal(JSON.parse(fetch.calls[0].init.body).model, connection.model);
    assert.match((await check()).lastError, /ожидались вероятности/);
    const ok = await check();
    assert.equal(ok.lastError, null);
    assert(ok.lastRequestAt > rejected.lastRequestAt);
    assert(ok.lastScoredAt >= ok.lastRequestAt);
    assert.deepEqual(await rpc.callRpc('chipScoring', {}), ok);
    assert.equal(fetch.calls.length, 3);
    assert(!JSON.stringify(await h.bb.storage.kv.get('chip-scoring')).includes(customKey));
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes(customKey)));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('an older background failure cannot replace a newer manual check', async () => {
  const { h } = await setupScoring();
  let complete!: (response: Response) => void;
  let first = true;
  const fetch = stubFetch(() => {
    if (first) { first = false; return new Promise(resolve => { complete = resolve; }); }
    return Response.json({ answers: { next: { probabilities: { 'aif-plan': 0.1, 'aif-verify': 0.9 } } } });
  });
  try {
    const rpc = h.harness.behavior;
    await rpc.callRpc('setChipScoring', { enabled: true, source: 'manual', manualKey: 'test-key' });
    await rpc.callRpc('suggestions', { threadId: 'thr_test' });
    assert(await waitFor(() => !!complete));
    const success = await rpc.callRpc('checkChipScoring', {});
    complete(Response.json({ error: { message: 'old error' } }, { status: 403 }));
    assert(await waitFor(() => h.harness.inspection.logEntries.some(e => e.message.includes('HTTP 403'))));
    assert.deepEqual(await rpc.callRpc('chipScoring', {}), success);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring from catalog: env_get_value supplies the key and the secret stays out of logs and RPC', async () => {
  const { h, rpcCalls } = await setupScoring({ reply: '$aif-plan score via catalog; then $aif-commit the result', variables: ['GEMINI_API_KEY_AISTUDIO'] });
  const fetch = stubFetch(() => new Response(JSON.stringify({ answers: { next: { probabilities: { 'aif-plan': 0.7, 'aif-commit': 0.3 } } } }), { status: 200 }));
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'catalog', catalogName: 'GEMINI_API_KEY_AISTUDIO' });
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    await read();
    const scored = await waitFor(async () => (await read()).items.some((i: any) => i.probability !== null));
    assert(scored, 'probabilities never arrived');
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].init.headers['x-goog-api-key'], 'catalog-secret');
    const readCall = rpcCalls.find(c => c.method === 'env_get_value');
    assert.equal(readCall?.input.name, 'GEMINI_API_KEY_AISTUDIO');
    const view = await read();
    assert.equal(view.items.find((i: any) => i.id === 'aif-plan').probability, 0.7);
    assert.equal(view.items.find((i: any) => i.id === 'aif-commit').probability, 0.3);
    assert(h.harness.inspection.logEntries.some(e => e.message === 'aif-chat: decisions key read source=catalog name=GEMINI_API_KEY_AISTUDIO'));
    assert(h.harness.inspection.logEntries.every(e => !e.message.includes('catalog-secret')));
    const state = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert(!JSON.stringify(state).includes('catalog-secret'));
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring with an unreadable catalog key: lastError set, fetch never called', async () => {
  const { h } = await setupScoring({ reply: '$aif-plan alpha checks; then $aif-explore beta leftovers', catalogError: true });
  const fetch = stubFetch(() => { throw new Error('fetch must not be called'); });
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'catalog', catalogName: 'GEMINI_API_KEY' });
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    await read();
    const failed = await waitFor(async () => (await h.harness.behavior.callRpc('chipScoring', {}) as any).lastError === 'ключ не найден в каталоге');
    assert(failed, 'lastError never set');
    assert.equal(fetch.calls.length, 0);
    const view = await read();
    assert(view.items.every((i: any) => i.probability === null));
    await read();
    assert.equal(fetch.calls.length, 0);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring manual source without a key: lastError «Ключ не задан», fetch never called', async () => {
  const { h } = await setupScoring({ reply: '$aif-verify needs a key; then $aif-improve the plan' });
  const fetch = stubFetch(() => { throw new Error('fetch must not be called'); });
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'manual' });
    const read = () => h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    await read();
    const failed = await waitFor(async () => (await h.harness.behavior.callRpc('chipScoring', {}) as any).lastError === 'Ключ не задан');
    assert(failed, 'lastError never set');
    assert.equal(fetch.calls.length, 0);
    const view = await read();
    assert(view.items.every((i: any) => i.probability === null));
    await read();
    assert.equal(fetch.calls.length, 0);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('chip scoring skips the request when fewer than two chips are available', async () => {
  const { h, rpcCalls } = await setupScoring({ reply: '$aif-plan only one chip' });
  const fetch = stubFetch(() => { throw new Error('fetch must not be called'); });
  try {
    await h.harness.behavior.callRpc('setChipScoring', { enabled: true, source: 'manual', manualKey: 'k' });
    const view = await h.harness.behavior.callRpc('suggestions', { threadId: 'thr_test' }) as any;
    assert.equal(view.items.length, 1);
    await tick(); await tick();
    assert.equal(fetch.calls.length, 0);
    assert(rpcCalls.every(c => c.method !== 'env_get_value'));
    const state = await h.harness.behavior.callRpc('chipScoring', {}) as any;
    assert.equal(state.lastError, null); assert.equal(state.lastScoredAt, null);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('context discovery precedes combined scoring, excludes offered skills and supports using and hiding the new chips', async () => {
  const reply = '$aif-plan уточнить задачу';
  const history = [{ seq: 4, type: 'client/turn/requested', data: { input: [
    { type: 'text', text: 'Проверить интерфейс' }, { type: 'text', visibility: 'agent-only', text: 'hidden marker' },
  ] } }];
  const { h } = await setupScoring({ reply, history: history as any });
  const fetch = stubFetch(init => {
    const body = JSON.parse(String(init.body));
    const ids = Object.keys(body.questions.next.criteria);
    const choices: Record<string, number> = ids.includes('none')
      ? { 'aif-verify': 0.6, 'aif-review': 0.3, 'aif-qa': 0.09, none: 0.01, 'aif-unknown': 1 }
      : { 'aif-plan': 0.1, 'aif-verify': 0.7, 'aif-review': 0.2 };
    return Response.json({ answers: { next: { probabilities: choices } } });
  });
  try {
    const rpc = h.harness.behavior;
    await rpc.callRpc('setChipScoring', { enabled: true, suggestFromContext: true, source: 'manual', manualKey: 'test-key' });
    const read = () => rpc.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    const first = await read();
    assert.deepEqual(first.items.map((i: any) => i.id), ['aif-plan']);
    assert(await waitFor(() => fetch.calls.length === 2));
    const [discovery, ranking] = fetch.calls.map(call => JSON.parse(call.init.body));
    assert.match(discovery.input, /Проверить интерфейс/);
    assert.match(discovery.input, /Demo/);
    assert(!discovery.input.includes('hidden marker'));
    assert(!('aif-plan' in discovery.questions.next.criteria));
    assert.deepEqual(Object.keys(ranking.questions.next.criteria).sort(), ['aif-plan', 'aif-review', 'aif-verify']);
    const view = await read();
    assert.deepEqual(view.items.map((i: any) => i.probability), [0.1, 0.7, 0.2]);
    assert(view.items[1].fromContext);
    const input = { threadId: 'thr_test', sourceKey: view.sourceKey, commandId: 'aif-verify' };
    const run = await rpc.callRpc('runSuggestion', { ...input, fingerprint: view.fingerprint, requestId: crypto.randomUUID() }) as any;
    assert.equal(run.command, view.items[1].command);
    await rpc.callRpc('dismissSuggestion', input);
    const remaining = await read();
    assert.deepEqual(remaining.items.map((i: any) => i.id), ['aif-plan', 'aif-review']);
    assert.equal(fetch.calls.filter(call => 'none' in JSON.parse(call.init.body).questions.next.criteria).length, 1);
    await rpc.callRpc('setChipScoring', { suggestFromContext: false });
    assert.deepEqual((await read()).items.map((i: any) => i.id), ['aif-plan']);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});

test('System One can decline all context additions and still rank the original chips', async () => {
  const { h } = await setupScoring();
  const endpoint = 'https://gateway.example/v1/systemone';
  const fetch = stubFetch(init => {
    const { questions, state, input } = JSON.parse(String(init.body));
    assert(state && !input);
    const scores = Object.fromEntries(Object.keys(questions.next.criteria).map(id => [id, id === 'none' ? 1 : 0.1]));
    return Response.json({ answers: { next: { probabilities: scores } } });
  });
  try {
    const rpc = h.harness.behavior;
    await rpc.callRpc('setChipScoring', { enabled: true, suggestFromContext: true, connection: { endpoint, model: 'test' }, customKey: 'test-key' });
    const read = () => rpc.callRpc('suggestions', { threadId: 'thr_test' }) as Promise<any>;
    await Promise.all([read(), read()]);
    assert(await waitFor(async () => (await read()).items.every((item: any) => item.probability === 0.1)));
    assert.equal(fetch.calls.length, 2);
    assert(fetch.calls.every(c => c.url === endpoint));
    assert.equal((await read()).items.length, 2);
  } finally { fetch.restore(); await h.harness.lifecycle.dispose(); }
});
