import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import {
  CONTEXT_PATH, PLAN_CONTEXT_PATH, RESEARCH_PATH, contextBlock, modelSpec, parseResearch, parseSpec, researchBlock,
  readDelegation, serialByRoot, writeDelegation,
} from '../delegation.ts';
import type { DelegationChoice, DelegationRole, DelegationState } from '../delegation.ts';

async function project(config: object | null = { version: '2.23.0', agents: [{ id: 'claude' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'aif-parallel-'));
  if (config) await writeFile(join(root, '.ai-factory.json'), JSON.stringify(config));
  return root;
}
const json = async (root: string) => JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
const exists = (path: string) => access(path).then(() => true, () => false);

test('parallel rides the model spec codec: round-trip and rejection of invalid values', () => {
  const choice: Extract<DelegationChoice, { mode: 'bb' }> = { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 3 };
  assert.equal(modelSpec(choice), 'codex/gpt-6.2-sol?reasoning=high&parallel=3');
  assert.deepEqual(parseSpec('codex/gpt-6.2-sol?reasoning=high&parallel=3'), choice);
  assert.deepEqual(parseSpec('codex/m?parallel=4'), { mode: 'bb', providerId: 'codex', model: 'm', parallel: 4 });
  for (const bad of ['codex/m?parallel=5', 'codex/m?parallel=1', 'codex/m?parallel=0', 'codex/m?parallel=x', 'codex/m?parallel=2.5'])
    assert.equal(parseSpec(bad), null, bad);
});

test('contextBlock without parallel keeps the one-worker text and no parallel section', () => {
  const text = contextBlock({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' });
  assert.ok(text.includes('One worker at a time: workers share this workspace.'));
  assert.ok(!text.includes('Parallel mode'));
  assert.ok(!text.includes('parallel='));
});

test('contextBlock with parallel spawns workers on BB-made copies and keeps provider flags', () => {
  const text = contextBlock({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast', parallel: 3 });
  // The copy comes from the plugin's environment provider, so a section inside a larger repository works too.
  // Every git and spawn step is a plugin command: no path, JSON or `git status` output passes through the shell.
  // The plugin no longer parses plans: the coordinator model reads the plan, as in AI Factory.
  assert.ok(!text.includes('aif-chat groups'));
  // Copies start from the coordinator's workspace: no checkpoint commits, no history rewriting.
  for (const absent of ['aif-chat checkpoint', 'reset --soft', 'plan base']) assert.ok(!text.includes(absent), absent);
  assert.ok(!text.includes("bb thread tell <id> '"), 'no error text inside shell quotes');
  for (const absent of ['git worktree add', 'git worktree remove', 'git apply --check', 'git apply "', 'git status', 'git add', 'git commit', '--environment-inputs', '--3way', 'commit -am', 'git checkout --']) assert.ok(!text.includes(absent), absent);
  for (const part of [
    'Parallel mode', 'up to 3 workers', "AI Factory's `implement-coordinator`", '(depends on X, Y)', 'Tasks of the same phase without explicit dependencies are independent',
    '<!-- parallel: tasks N, M -->', '- [~] Task N: … <!-- in-progress -->', '- [!] Task N: … <!-- failed: <reason> -->', 'handoff_outcome: blocked_external',
    'the list of files you modified', 'same cause three times', 'Status: complete', 'This workspace is your own copy of the repository', 'a path outside it is input you read and never change', 'Untracked ignored files (dependencies, build output) stay in the copy', 'Do not change or add files inside a git submodule', 'Submodules are not checked out in the copy', 'which keep \`$\`, spaces', '`.git/info/exclude` and global excludes all count', 'whose name has only letters, digits', 'no git command that changes the index', 'The copy holds the files git tracks (a force-added one too)', 'give its absolute path in your workspace in the brief',
    // Review of aa0cdb6 and 3377882: resume of [~], old dependency forms, check-only and already-applied tasks,
    // commits only where the plan says, and no error text inside shell quotes.
    'Open tasks are `[ ]` and `[~]`', '`Depends on X`', 'treat it as dependent',
    'a task that only checks something', 'already in this workspace', 'exactly where the plan says', 'single-commit',
    'the last commit plus your uncommitted work', 'Parallel layers need no commits of their own',
    "bb thread tell <id> --message-file '<file>'",
    "bb plugin run aif-chat spawn-worker --target <plan name> --task <task number, e.g. 3 or 1.2> --brief '<absolute brief path>' --json", 'is only a label for the worker', 'so it needs no quotes and is never read as an option', 'leading `-` and `.` dropped',
    'bb plugin run aif-chat bring-back --worker <id> --json', 'nothing was changed', 'there is nothing to undo', '{ applied: false, empty: true }',
    "--provider 'codex'", "--model 'gpt-6.2-sol'", "--reasoning-level 'high'", "--service-tier 'fast'",
    'BB removes its copy',
  ]) assert.ok(text.includes(part), part);
});

test('every wait step uses wait-worker, which sees everything between two calls, and never wakes a worker by itself', () => {
  // Seven review rounds of `bb thread wait` + `bb thread output` polling kept finding gaps between two commands
  // (a worker resuming, finishing or failing unseen); the plugin now waits on the event log with a cursor.
  const bb = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' };
  const research = researchBlock({ research: bb, research2: { mode: 'self' }, research3: { mode: 'self' } })!;
  // The parallel block also carries the one-worker flow, so it has two wait steps.
  for (const [name, text, steps] of [['one worker', contextBlock(bb), 1], ['parallel', contextBlock({ ...bb, parallel: 3 }), 2], ['research', research, 1]] as const) {
    const count = (part: string) => text.split(part).length - 1;
    assert.equal(count('Wait with `bb plugin run aif-chat wait-worker --worker <id> --json`, then call it again with `--after <seq>` from its previous answer'), steps, name);
    assert.equal(count('an empty or interim one ("waiting for the tests") means it still works in the background'), steps, name);
    assert.equal(count('once `quietForMs` passes 480000 and the worker is not done'), steps, name);
    assert.equal(count('`stopped`: someone stopped it; ask the owner. `failed`: its run failed; handle it as a BB failure.'), steps, name);
    assert.equal(count('run `bb thread stop <id>` and archive the old worker, so it never writes into the files later'), steps, name);
    // Review of 26af3e3: `stopped` is never retried as a BB failure.
    if (name === 'parallel') assert.ok(text.includes('`wait-worker` answering `failed`): retry once, then do that task yourself with the one-worker flow. A `stopped` worker is not a failure: someone stopped it, so ask the owner.'));
    assert.ok(!text.includes('a worker that stopped without a report'), name);
    for (const gone of ['bb thread wait <id>', "bb thread tell <id> '", 'handoff_outcome: done', 'repeat your final report']) assert.ok(!text.includes(gone), `${name}: ${gone}`);
  }
});

test('writeDelegation stores parallel in phases.implement.model and manages the aif-plan block', async () => {
  const root = await project();
  const withParallel = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 3 };
  const state = await writeDelegation(root, withParallel);
  assert.equal(state.choice.mode === 'bb' && state.choice.parallel, 3);
  assert.equal((await json(root)).phases.implement.model, 'codex/gpt-6.2-sol?reasoning=high&parallel=3');
  const planContext = await readFile(join(root, PLAN_CONTEXT_PATH), 'utf8');
  assert.ok(planContext.includes('bb-aif-helper:plan'));
  assert.ok(planContext.includes('Files:'));
  assert.ok(planContext.includes('(depends on 1, 2)'), 'plan hints use AI Factory task format');
  const implementContext = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.ok(implementContext.includes('Parallel mode'));

  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' });
  assert.equal((await json(root)).phases.implement.model, 'codex/gpt-6.2-sol?reasoning=high');
  assert.ok(!(await exists(join(root, PLAN_CONTEXT_PATH))), 'the plan block file is removed once empty');
  assert.ok(!(await readFile(join(root, CONTEXT_PATH), 'utf8')).includes('Parallel mode'));
});

test('parallel is implement-only: research choices and the research block never keep it', async () => {
  const root = await project();
  const research: Extract<DelegationChoice, { mode: 'bb' }> = { mode: 'bb', providerId: 'codex', model: 'm', parallel: 3 };
  const state = await writeDelegation(root, research, 'research');
  assert.equal(state.research.mode === 'bb' && 'parallel' in state.research, false);
  const text = await readFile(join(root, RESEARCH_PATH), 'utf8');
  assert.ok(!text.includes('parallel='));
  const parsed = parseResearch(`x\n<!-- bb-aif-helper:research:start -->\n<!-- research-model: codex/m?parallel=3&reasoning=high -->\n<!-- bb-aif-helper:research:end -->`);
  assert.deepEqual(parsed.research, { mode: 'bb', providerId: 'codex', model: 'm', reasoning: 'high' });
});

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

test('delegation defaults keep parallel together with the model', async () => {
  const h = await setup();
  try {
    h.state.choice = { mode: 'bb', providerId: 'devin', model: 'swe-2-flash', parallel: 3 };
    await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'from-project' });
    const stored = await h.bb.storage.kv.get<any>('delegation-defaults');
    assert.equal(stored.implement.parallel, 3);
    h.state.choice = { mode: 'self' };
    await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'apply' });
    const writes = h.hostCalls.filter(c => c.method === 'setDelegation').map(c => c.input as { role?: string; choice: DelegationChoice });
    const implement = writes.filter(c => (c.role ?? 'implement') === 'implement').at(-1)!;
    assert.deepEqual(implement.choice, { mode: 'bb', providerId: 'devin', model: 'swe-2-flash', parallel: 3 });
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a block saved by an older version is rewritten on read; the owner text and an unchanged block stay as they are', async () => {
  const root = await project();
  const choice = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 2 };
  await writeDelegation(root, choice);
  const file = join(root, CONTEXT_PATH);
  const current = await readFile(file, 'utf8');
  // What a project saved before the update holds: the three-way apply that can leave an unmerged index.
  const stale = '\uFEFF    indented owner code\n# Owner notes\n\n' + current.replace('bb plugin run aif-chat bring-back --worker <id> --json', 'git apply --3way <tmp>/task-<taskId>.patch');
  await writeFile(file, stale);
  await readDelegation(root);
  const refreshed = await readFile(file, 'utf8');
  assert.ok(!refreshed.includes('--3way <tmp>'), 'the old command is gone');
  assert.ok(refreshed.includes('bb plugin run aif-chat bring-back --worker <id> --json'));
  assert.ok(refreshed.startsWith('\uFEFF    indented owner code\n# Owner notes\n'), 'text outside the markers is kept byte for byte');
  const again = await readFile(file, 'utf8');
  await readDelegation(root);
  assert.equal(await readFile(file, 'utf8'), again, 'a current block is not rewritten');
});

test('reads and saves of one project folder run one at a time; other folders do not wait', async () => {
  const log: string[] = [];
  const job = (name: string, ms: number) => () => new Promise<string>(resolve => {
    log.push(`${name}:start`); setTimeout(() => { log.push(`${name}:end`); resolve(name); }, ms);
  });
  await Promise.all([serialByRoot('/p', job('refresh', 30)), serialByRoot('/p', job('save', 1)), serialByRoot('/q', job('other', 1))]);
  assert.deepEqual(log.filter(e => !e.startsWith('other')), ['refresh:start', 'refresh:end', 'save:start', 'save:end']);
  assert.ok(log.indexOf('other:end') < log.indexOf('refresh:end'), 'another folder is not queued behind this one');
  await assert.rejects(serialByRoot('/p', async () => { throw new Error('boom'); }));
  assert.equal(await serialByRoot('/p', async () => 'after a failure'), 'after a failure');
});

test('the refresh keeps CRLF files CRLF, updates the research block, and never fails a read', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'm', parallel: 2 });
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'r' }, 'research');
  const implement = join(root, CONTEXT_PATH), research = join(root, RESEARCH_PATH);
  // A Windows checkout with core.autocrlf: every line ends in CRLF; a current block must stay byte for byte.
  const crlf = (await readFile(implement, 'utf8')).replace(/\n/g, '\r\n');
  await writeFile(implement, crlf);
  await readDelegation(root);
  assert.equal(await readFile(implement, 'utf8'), crlf, 'no change, so git sees none');
  // An old research block with an unquoted prompt path is brought up to date.
  const old = (await readFile(research, 'utf8')).replace("--prompt-file '<prompt>'", '--prompt-file <prompt>');
  await writeFile(research, old);
  await readDelegation(root + '/');
  assert.ok((await readFile(research, 'utf8')).includes("--prompt-file '<prompt>'"));
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await writeFile(research, old);
    await chmod(join(root, '.ai-factory/skill-context'), 0o555);
    try {
      const state = await readDelegation(root);
      assert.equal(state.research.mode, 'bb', 'a folder that cannot be written still answers the read');
    } finally { await chmod(join(root, '.ai-factory/skill-context'), 0o755); }
  }
});

test('plan tasks go only to BB workers, survive a compaction, and the full suite runs once per layer', () => {
  // thr_ds3i5seh7r: after a compaction the coordinator thought copies miss uncommitted work, built a branch with
  // commit-tree and ran native Claude subagents in its own worktrees; every worker also ran the full suite.
  const bb = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' };
  for (const [name, text] of [['one worker', contextBlock(bb)], ['parallel', contextBlock({ ...bb, parallel: 3 })]] as const) {
    const rules = text.slice(0, text.indexOf('1. Write the task brief'));
    for (const part of ['never your own subagents', '`implement-worker`', 'your own git worktrees', '`commit-tree`', 'Re-read this block before each task']) assert.ok(rules.includes(part), `${name}: ${part}`);
    assert.ok(text.includes('Do not run the full test suite'), `${name}: worker runs narrow checks`);
  }
  const parallel = contextBlock({ ...bb, parallel: 3 });
  const head = parallel.slice(parallel.indexOf('## Parallel mode'), parallel.indexOf('### Layers'));
  assert.ok(head.includes('already holds all your uncommitted work'), 'the copy fact leads the parallel section');
  assert.ok(head.includes('Re-read this section before each layer'));
  assert.ok(parallel.includes("every check its tasks name that the workers skipped: the build, the full test suite, the project's full check script"));
  assert.ok(parallel.includes('a task is verified only when its named checks pass'));
});

test('a linked SKILL.md: a read keeps the link and the shared text, a save gives this project its own file, other projects keep theirs', async t => {
  const { symlink, lstat: lstatFile, rm: remove } = await import('node:fs/promises');
  const choice = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', parallel: 2 };
  const shared = join(await mkdtemp(join(tmpdir(), 'aif-shared-')), 'SKILL.md');
  const link = async (root: string) => { const file = join(root, CONTEXT_PATH); await remove(file); await symlink(shared, file, 'file'); return file; };
  const a = await project(), b = await project();
  await writeDelegation(a, choice); await writeDelegation(b, choice);
  // The shared file holds an older managed block, as after a plugin update.
  const stale = (await readFile(join(a, CONTEXT_PATH), 'utf8')).replace('bb plugin run aif-chat bring-back --worker <id> --json', 'OLD bring-back');
  await writeFile(shared, stale);
  let fileA: string, fileB: string;
  try { fileA = await link(a); fileB = await link(b); } catch (e: any) {
    if (process.platform === 'win32' && e.code === 'EPERM') return t.skip('symbolic links need Developer Mode on this Windows runner');
    throw e;
  }
  await readDelegation(a);
  assert.ok((await lstatFile(fileA)).isSymbolicLink(), 'the read keeps the link');
  assert.equal(await readFile(shared, 'utf8'), stale, 'a read never rewrites a shared file');
  // Project B saves another model: B gets its own file, A and the shared file keep theirs.
  await writeDelegation(b, { ...choice, model: 'gpt-6.2-terra' });
  assert.ok(!(await lstatFile(fileB)).isSymbolicLink());
  assert.ok((await readFile(fileB, 'utf8')).includes('gpt-6.2-terra'));
  assert.equal(await readFile(shared, 'utf8'), stale, 'B\'s save does not reach the file A follows');
  assert.ok(!(await readFile(fileA, 'utf8')).includes('gpt-6.2-terra'));
  // A switches to self: only its own link goes, the shared file stays.
  await writeDelegation(a, { mode: 'self' });
  assert.equal(await exists(fileA), false);
  assert.equal(await readFile(shared, 'utf8'), stale);
});

test('a linked SKILL.md stays linked while it carries this project\'s settings; any other model, tier or parallel mode gives the project its own file', async t => {
  const { symlink, lstat: lstatFile, rm: remove } = await import('node:fs/promises');
  const base = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol' };
  const cases = [
    { name: 'model', a: { ...base, model: 'gpt-6.2-terra' }, check: "--model 'gpt-6.2-sol'" },
    { name: 'tier', a: { ...base, tier: 'fast' }, check: 'codex/gpt-6.2-sol`' },
    { name: 'parallel', a: { ...base, parallel: 2 }, check: 'codex/gpt-6.2-sol`' },
  ];
  for (const c of cases) {
    const a = await project(), b = await project();
    await writeDelegation(a, c.a); await writeDelegation(b, base);
    const fileA = join(a, CONTEXT_PATH), fileB = join(b, CONTEXT_PATH);
    const sharedText = await readFile(fileA, 'utf8');
    await remove(fileB);
    try { await symlink(fileA, fileB, 'file'); } catch (e: any) {
      if (process.platform === 'win32' && e.code === 'EPERM') return t.skip('symbolic links need Developer Mode on this Windows runner');
      throw e;
    }
    // B's own settings in the shared file, worded by an older version: the link stays.
    if (c.name === 'model') {
      const sameRoot = await project(), same = join(sameRoot, CONTEXT_PATH);
      await writeDelegation(sameRoot, base);
      const stale = (await readFile(same, 'utf8')).replace('You stay the coordinator', 'OLD: you stay the coordinator');
      assert.notEqual(stale, await readFile(same, 'utf8'));
      await writeFile(same, stale); await remove(fileB); await symlink(same, fileB, 'file');
      await readDelegation(b);
      assert.ok((await lstatFile(fileB)).isSymbolicLink(), 'same settings, older wording: the link stays');
      assert.equal(await readFile(same, 'utf8'), stale);
      await remove(fileB); await symlink(fileA, fileB, 'file');
    }
    await readDelegation(b);
    assert.ok(!(await lstatFile(fileB)).isSymbolicLink(), `another ${c.name}: B gets its own file`);
    const own = await readFile(fileB, 'utf8');
    assert.ok(own.includes(c.check), `B's block carries B's ${c.name}`);
    assert.ok(!own.includes('spawn-worker') && !own.includes("--service-tier 'fast'"), 'neither parallel workers nor a fast tier B did not choose');
    assert.equal(await readFile(fileA, 'utf8'), sharedText, 'the shared file is untouched');
  }
});
