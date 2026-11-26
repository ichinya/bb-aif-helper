import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_PATH, RESEARCH_PATH, mergeContextBlock, parseSpec, readDelegation, researchBlock, writeDelegation } from '../delegation.ts';

const LEGACY_RUNNER = '.ai-factory/bin/bb-aif-run.mjs';

async function project(config: object | null = { version: '2.23.0', agents: [{ id: 'claude' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'aif-delegation-'));
  if (config) await writeFile(join(root, '.ai-factory.json'), JSON.stringify(config));
  return root;
}
const json = async (root: string) => JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
const exists = (path: string) => access(path).then(() => true, () => false);
const managedBlock = async (root: string) => {
  const content = await readFile(join(root, CONTEXT_PATH), 'utf8');
  const start = content.indexOf('delegation:start');
  const end = content.indexOf('delegation:end');
  return content.slice(start, end);
};

test('parseSpec round-trips provider/model?reasoning&tier, including slashes and colons in the model', () => {
  assert.deepEqual(parseSpec('codex/gpt-6.2-sol?reasoning=high&tier=fast'), { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(parseSpec('claude-code/sonnet'), { mode: 'bb', providerId: 'claude-code', model: 'sonnet' });
  assert.deepEqual(parseSpec('opencode2/openrouter/qwen:7b?reasoning=low'), { mode: 'bb', providerId: 'opencode2', model: 'openrouter/qwen:7b', reasoning: 'low' });
  for (const bad of ['sonnet', 'a/b c', '', 42, 'a/b?reasoning=x y', 'a/b?tier=$(x)']) assert.equal(parseSpec(bad), null);
});

test('bb choice writes AI Factory dispatch config and skill-context; self removes only what it added', async () => {
  const root = await project({ version: '2.23.0', agents: [{ id: 'claude' }], phases: { review: { agent: 'gemini-cli' } }, dispatchAgents: { other: { command: 'x {prompt}' } } });
  await mkdir(join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true });
  await writeFile(join(root, CONTEXT_PATH), 'Owner rule: keep commits small.\n');

  const state = await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(state.choice, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  const config = await json(root);
  assert.equal(config.dispatch, undefined);
  assert.deepEqual(config.phases.implement, { agent: 'bb', model: 'codex/gpt-6.2-sol?reasoning=high&tier=fast', timeoutMs: 14400000 });
  assert.deepEqual(config.phases.review, { agent: 'gemini-cli' });
  assert.equal(config.dispatchAgents.bb, undefined);
  assert.ok(config.dispatchAgents.other);
  assert.deepEqual(config.agents, [{ id: 'claude' }]);
  const context = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.match(context, /^Owner rule: keep commits small\.\n\n<!-- bb-aif-helper:delegation:start -->/);
  assert.match(context, /codex\/gpt-6\.2-sol\?reasoning=high&tier=fast/);
  assert.match(context, /bb thread spawn/);
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);

  // Switching model replaces the block instead of stacking a second one.
  await writeDelegation(root, { mode: 'bb', providerId: 'claude-code', model: 'sonnet' });
  const again = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.equal(again.match(/delegation:start/g)?.length, 1);
  assert.match(again, /claude-code\/sonnet/);

  const back = await writeDelegation(root, { mode: 'self' });
  assert.deepEqual(back.choice, { mode: 'self' });
  const restored = await json(root);
  assert.equal(restored.phases.implement, undefined);
  assert.deepEqual(restored.phases.review, { agent: 'gemini-cli' });
  assert.equal(restored.dispatchAgents.bb, undefined);
  assert.equal(await readFile(join(root, CONTEXT_PATH), 'utf8'), 'Owner rule: keep commits small.\n');
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);
});

test('context block spawns workers with native bb thread commands and quoted flags', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  const text = await managedBlock(root);
  for (const flag of ['bb thread spawn', '--parent-self', '--lifecycle-owner-thread "$BB_THREAD_ID"', '--parent-notifications off',
    "--provider 'codex'", "--model 'gpt-6.2-sol'", "--reasoning-level 'high'", "--service-tier 'fast'"])
    assert.ok(text.includes(flag), flag);
  assert.match(text, /bb thread list --parent-thread/);
  assert.match(text, /AIF · /);
  assert.ok(!text.includes('node ')); assert.ok(!text.includes('aif_delegate_task'));

  // Without the flag BB starts the worker on the coordinator's tier: default is always sent explicitly.
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'm', tier: 'default' });
  assert.ok((await managedBlock(root)).includes("--model 'm' --service-tier 'default'"));
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'm' });
  assert.ok((await managedBlock(root)).includes("--model 'm' --service-tier 'default'"));
});

test('research workers get the default tier explicitly too, never the coordinator\'s', () => {
  const text = researchBlock({ research: { mode: 'bb', providerId: 'acp-antigravity', model: 'gemini-4-carbon' }, research2: { mode: 'self' }, research3: { mode: 'self' } })!;
  assert.ok(text.includes("--provider 'acp-antigravity' --model 'gemini-4-carbon' --service-tier 'default'"));
});

test('a model with shell metacharacters reaches the block only single-quoted', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: "a'b;rm" });
  const text = await managedBlock(root);
  assert.ok(text.includes("--model 'a'\\''b;rm'"));
  assert.ok(!text.includes("--model a'b;rm"));
  assert.ok(!text.includes("--model 'a'b;rm'"));
});

test('saving over the legacy runner install removes its script, dispatchAgents.bb and dispatch', async () => {
  const root = await project({ version: '2.23.0', agents: [], dispatch: 'auto',
    dispatchAgents: { bb: { command: 'node .ai-factory/bin/bb-aif-run.mjs run {model} {prompt}' }, other: { command: 'x {prompt}' } },
    phases: { implement: { agent: 'bb', model: 'codex/gpt-6.2-sol', timeoutMs: 14400000 } } });
  await mkdir(join(root, '.ai-factory/bin'), { recursive: true });
  await writeFile(join(root, LEGACY_RUNNER), '#!/usr/bin/env node\n');
  const state = await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  assert.equal(state.removedLegacy, true);
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);
  const config = await json(root);
  assert.equal(config.dispatch, undefined);
  assert.equal(config.dispatchAgents.bb, undefined);
  assert.ok(config.dispatchAgents.other);
});

test('self on a project with nothing else removes dispatch keys and the empty context file', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  await writeDelegation(root, { mode: 'self' });
  const config = await json(root);
  for (const key of ['phases', 'dispatch', 'dispatchAgents']) assert.equal(key in config, false, key);
  assert.equal(await exists(join(root, CONTEXT_PATH)), false);
});

test('a phases.implement owned by another agent is reported and never overwritten', async () => {
  const root = await project({ version: '2.23.0', agents: [], dispatch: 'auto', phases: { implement: { agent: 'gemini-cli', model: 'gemini-2.5-pro' } } });
  const state = await readDelegation(root);
  assert.equal(state.foreign, 'gemini-cli');
  await assert.rejects(writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'x' }), /gemini-cli/);
  assert.equal((await json(root)).phases.implement.agent, 'gemini-cli');
});

test('missing or broken .ai-factory.json', async () => {
  const empty = await project(null);
  assert.equal((await readDelegation(empty)).configured, false);
  await assert.rejects(writeDelegation(empty, { mode: 'self' }), /AI Factory/);
  const broken = await project(null);
  await writeFile(join(broken, '.ai-factory.json'), '{ nope');
  assert.match((await readDelegation(broken)).error ?? '', /\.ai-factory\.json/);
});

test('mergeContextBlock keeps owner text around the managed block', () => {
  const withBlock = mergeContextBlock('A\n', 'B');
  assert.equal(withBlock, 'A\n\n<!-- bb-aif-helper:delegation:start -->\nB\n<!-- bb-aif-helper:delegation:end -->\n');
  assert.equal(mergeContextBlock(withBlock + '\nC\n', null), 'A\n\nC\n');
  assert.equal(mergeContextBlock('', null), '');
});

test('choosing self removes the managed block and leaves only owner text', async () => {
  const root = await project();
  await mkdir(join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true });
  await writeFile(join(root, CONTEXT_PATH), 'Owner notes.\n');
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  assert.match(await managedBlock(root), /bb thread spawn/);
  await writeDelegation(root, { mode: 'self' });
  const content = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.ok(!content.includes('delegation:start'));
  assert.ok(!content.includes('delegation:end'));
  assert.equal(content, 'Owner notes.\n');
});

test('research choice lives in a managed block of the global skill-context and leaves .ai-factory.json alone', async () => {
  const root = await project();
  const before = await json(root);
  await mkdir(join(root, '.ai-factory/skill-context'), { recursive: true });
  await writeFile(join(root, RESEARCH_PATH), '# Owner notes\nKeep answers short.\n');
  assert.deepEqual((await readDelegation(root)).research, { mode: 'self' });
  const choice = { mode: 'bb' as const, providerId: 'codex', model: "gpt-6.2-luna'x", reasoning: 'medium' };
  const state = await writeDelegation(root, choice, 'research');
  assert.deepEqual(state.research, choice);
  assert.deepEqual(state.choice, { mode: 'self' }, 'code delegation is untouched');
  assert.deepEqual(await json(root), before);
  const text = await readFile(join(root, RESEARCH_PATH), 'utf8');
  assert.match(text, /^# Owner notes\nKeep answers short\.\n\n<!-- bb-aif-helper:research:start -->/);
  assert.match(text, /Task\(subagent_type: Explore/);
  assert.match(text, /--parent-self --lifecycle-owner-thread "\$BB_THREAD_ID"/);
  assert.match(text, /--model 'gpt-6\.2-luna'\\''x'/, 'model id is single-quoted for the shell');
  assert.ok(!(await exists(join(root, CONTEXT_PATH))), 'research does not create the aif-implement context');
  const back = await writeDelegation(root, { mode: 'self' }, 'research');
  assert.deepEqual(back.research, { mode: 'self' });
  assert.equal(await readFile(join(root, RESEARCH_PATH), 'utf8'), '# Owner notes\nKeep answers short.\n');
  const bare = await project();
  await writeDelegation(bare, choice, 'research');
  await writeDelegation(bare, { mode: 'self' }, 'research');
  assert.ok(!(await exists(join(bare, RESEARCH_PATH))), 'an otherwise empty context file is removed');
});

test('each of the three research workers keeps its own model; workers 2 and 3 fall back to worker 1', async () => {
  const root = await project();
  const one = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-luna', reasoning: 'medium' };
  const two = { mode: 'bb' as const, providerId: 'acp-antigravity', model: 'gemini-4-hydrogen', reasoning: 'high' };
  await writeDelegation(root, two, 'research2');
  let text = await readFile(join(root, RESEARCH_PATH), 'utf8');
  assert.match(text, /Research worker 1 [^\n]*: your own native subagent/, 'worker 1 stays native while only worker 2 is set');
  assert.match(text, /Research worker 2 [^\n]*--provider 'acp-antigravity' --model 'gemini-4-hydrogen'/);
  assert.match(text, /Research worker 3 [^\n]*: your own native subagent/, 'worker 3 follows worker 1');
  await writeDelegation(root, one, 'research');
  const state = await readDelegation(root);
  assert.deepEqual([state.research, state.research2, state.research3], [one, two, { mode: 'self' }]);
  text = await readFile(join(root, RESEARCH_PATH), 'utf8');
  assert.match(text, /Research worker 3 [^\n]*--model 'gpt-6\.2-luna'/, 'worker 3 falls back to worker 1');
  const back = await writeDelegation(root, { mode: 'self' }, 'research2');
  assert.deepEqual(back.research, one, 'clearing worker 2 keeps worker 1');
  assert.doesNotMatch(await readFile(join(root, RESEARCH_PATH), 'utf8'), /gemini-4-hydrogen/);
  await writeDelegation(root, { mode: 'self' }, 'research');
  assert.ok(!(await exists(join(root, RESEARCH_PATH))), 'no block once every worker is native');
});
