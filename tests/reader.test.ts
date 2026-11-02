import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectSnapshot, parseYaml, safeRelative, taskList, lastGate } from '../reader.ts';
import { fixture } from './fixtures.ts';
const input = (root: string, target = '') => ({ root, target, phase: 'plan' as const, runtime: 'codex-app', sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' });

test('check input fingerprint ignores phase, detects tracked and untracked byte changes, and fails open on limits', async () => {
  const f = await fixture();
  const exec = promisify(execFile);
  const git = (args: string[]) => exec('git', ['-C', f.root, ...args], { windowsHide: true, timeout: 5000 });
  try {
    await f.write('.ai-factory/plans/demo.md', '# Demo\n- [ ] Work');
    await f.write('source.ts', 'one');
    await git(['init', '--quiet']); await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const original = await collectSnapshot(input(f.root)); assert(original.inputsFingerprint);
    const phase = await collectSnapshot({ ...input(f.root), phase: 'verify' });
    assert.equal(original.inputsFingerprint, phase.inputsFingerprint); assert.notEqual(original.fingerprint, phase.fingerprint);
    await f.write('source.ts', 'two');
    const changed = await collectSnapshot(input(f.root)); assert.notEqual(original.inputsFingerprint, changed.inputsFingerprint);
    await fs.writeFile(path.join(f.root, 'new.bin'), Buffer.from([255]));
    const untracked = await collectSnapshot(input(f.root)); assert(untracked.inputsFingerprint);
    await fs.writeFile(path.join(f.root, 'new.bin'), Buffer.from([254]));
    const changedUntracked = await collectSnapshot(input(f.root)); assert.notEqual(untracked.inputsFingerprint, changedUntracked.inputsFingerprint);
    assert.notEqual(untracked.fingerprint, changedUntracked.fingerprint);
    await fs.writeFile(path.join(f.root, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
    assert.equal((await collectSnapshot(input(f.root))).inputsFingerprint, null);
  } finally { await f.cleanup(); }
});
test('artifact paths reject escapes, drive paths, git administration and null bytes', () => {
  for (const s of ['../secret', 'a/../secret', 'C:/x', '/x', '.git/config', 'a\u0000b', 'x//y']) assert.throws(() => safeRelative(s));
  assert.equal(safeRelative('.ai-factory\\plans\\one.md'), '.ai-factory/plans/one.md');
});
test('duplicate YAML keys fail rather than choosing a hidden mode', () => {
  assert.throws(() => parseYaml('aifhub: true\naifhub: false'));
});
test('scalar YAML and malformed tools mapping cannot enable a workflow', async () => {
  assert.throws(() => parseYaml('true'));
  const f = await fixture(true); try {
    await f.write('.ai-factory/config.yaml', 'aifhub:\n  tools: true\n');
    const s = await collectSnapshot(input(f.root)); assert.equal(s.profile, 'invalid'); assert.equal(s.actions.length, 0);
  } finally { await f.cleanup(); }
});
test('code samples, comments and frontmatter do not manufacture tasks', () => {
  const tasks = taskList('---\n- [x] fake\n---\n# Tasks\n- [x] 1 Real\n```md\n- [x] fake\n```\n<!--\n- [x] fake\n-->\n- [ ] 2 Pending');
  assert.equal(tasks.length, 2); assert.equal(tasks[0].done, true); assert.equal(tasks[1].done, false);
});
test('malformed or contradictory final gate cannot create a PASS', () => {
  const gate = { schema_version: 1, gate: 'verify', status: 'pass', blocking: false, blockers: [], affected_files: [] };
  const block = (v: object) => '```aif-gate-result\n' + JSON.stringify(v) + '\n```';
  assert.equal(lastGate(block(gate), 'verify')?.status, 'pass');
  assert.equal(lastGate(block(gate) + '\n```aif-gate-result\ninvalid\n```', 'verify'), null);
  assert.equal(lastGate(block({ ...gate, blocking: true }), 'verify'), null);
  assert.equal(lastGate(block(gate), 'rules'), null);
});
test('nested canonical tasks count; checkboxes in a later unrelated section do not', () => {
  const tasks = taskList('# Plan\n## Tasks\n- [ ] 1 Parent\n    - [x] 1.1 Nested\n## Notes\n- [x] Example');
  assert.equal(tasks.length, 2); assert.equal(tasks[1].done, true);
});
test('snapshot reads installed extensions and canonical tasks without writes or network', async () => {
  const f = await fixture(true); try {
    await f.write('.ai-factory/plans/demo.md', '# Demo\n## Tasks\n- [x] 1 Implement\n- [ ] 2 Verify');
    const before = await fs.readFile(path.join(f.root, '.ai-factory.json'), 'utf8');
    const s = await collectSnapshot(input(f.root));
    assert.equal(s.profile, 'aifhub-classic'); assert.equal(s.target!.tasks.length, 2);
    assert.equal(s.extensions[0].installedVersion, '1.8.1'); assert(!s.extensions[0].source.includes('secret')); assert(!s.extensions[0].source.includes('private'));
    assert.equal(s.upstream.checkedAt, null); assert.equal(await fs.readFile(path.join(f.root, '.ai-factory.json'), 'utf8'), before);
    await f.write('.ai-factory/plans/demo.md', '# Demo\n- [x] 1 Implement\n- [x] 2 Verify');
    assert.notEqual((await collectSnapshot(input(f.root))).fingerprint, s.fingerprint);
  } finally { await f.cleanup(); }
});
test('missing project version remains unknown, no fallback to global CLI version', async () => {
  const f = await fixture(); try { await f.write('.ai-factory.json', { agents: [] }); assert.equal((await collectSnapshot(input(f.root))).versions.installed, null); }
  finally { await f.cleanup(); }
});
test('extension source modules are never imported during status discovery', async () => {
  const f = await fixture(true); try {
    await f.write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '1.8.1', commands: [{ name: 'evil', module: './evil.mjs' }] });
    await f.write('.ai-factory/extensions/aifhub-extension/evil.mjs', 'throw new Error("module must not execute")');
    const s = await collectSnapshot(input(f.root)); assert.equal(s.extensions[0].state, 'present');
  } finally { await f.cleanup(); }
});
test('mismatched extension metadata disables routing instead of treating it as upstream', async () => {
  const f = await fixture(true); try {
    await f.write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '9.0.0' });
    const s = await collectSnapshot(input(f.root)); assert.equal(s.profile, 'invalid'); assert.equal(s.actions.length, 0);
  } finally { await f.cleanup(); }
});
test('AIFHub analyze is discovered from installed custom skills outside base installedSkills', async () => {
  const f = await fixture(true); try {
    await f.write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '1.8.1', skills: ['skills/aif-analyze'] });
    await f.write('.agents/skills/aif-analyze/SKILL.md', '---\nname: aif-analyze\n---\nAnalyze fixture');
    const s = await collectSnapshot(input(f.root));
    assert(s.skills.includes('aif-analyze'));
    const action = s.actions.find(a => a.id === 'setup-context')!;
    assert.equal(action.command, '$aif-analyze'); assert(action.available);
  } finally { await f.cleanup(); }
});

test('BB codex-app resolves shared codex skills when other runtimes are installed', async () => {
  const f = await fixture(true); try {
    const file = path.join(f.root, '.ai-factory.json');
    const meta = JSON.parse(await fs.readFile(file, 'utf8'));
    meta.agents[0].id = 'codex';
    meta.agents.push({ id: 'copilot', skillsDir: '.github/skills', installedSkills: ['aif-plan'] });
    await f.write('.ai-factory.json', meta);
    await f.write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '1.8.1', skills: ['skills/aif-analyze'] });
    await f.write('.agents/skills/aif-analyze/SKILL.md', '# Analyze fixture');
    const s = await collectSnapshot(input(f.root));
    assert.equal(s.runtime, 'codex-app');
    assert(s.skills.includes('aif-plan')); assert(s.skills.includes('aif-explore')); assert(s.skills.includes('aif-analyze'));
    assert.equal(s.actions.find(a => a.id === 'setup-context')?.available, true);
    assert(!s.diagnostics.some(d => d.includes('установка не найдена')));
    await fs.unlink(path.join(f.root, '.agents/skills/aif-analyze/SKILL.md'));
    const missing = await collectSnapshot(input(f.root));
    assert.equal(missing.actions.find(a => a.id === 'setup-context')?.available, false);
    assert.notEqual(missing.fingerprint, s.fingerprint);
  } finally { await f.cleanup(); }
});

test('exact runtime installation wins over a compatible shared Codex record', async () => {
  const f = await fixture(); try {
    await f.write('.ai-factory.json', { version: '2.21.0', agents: [
      { id: 'codex', skillsDir: '.agents/skills', installedSkills: ['aif-plan'] },
      { id: 'codex-app', skillsDir: '.agents/skills', installedSkills: ['aif-explore'] },
    ] });
    const s = await collectSnapshot(input(f.root));
    assert.deepEqual(s.skills, ['aif-explore']);
  } finally { await f.cleanup(); }
});

test('shared universal profile works for both Codex runtime IDs', async () => {
  const f = await fixture(); try {
    await f.write('.ai-factory.json', { version: '2.21.0', agents: [
      { id: 'universal', skillsDir: '.agents\\skills', installedSkills: ['aif-plan'] },
      { id: 'copilot', skillsDir: '.github/skills', installedSkills: ['aif-explore'] },
    ] });
    for (const runtime of ['codex-app', 'codex']) {
      const s = await collectSnapshot({ ...input(f.root), runtime });
      assert(s.skills.includes('aif-plan'));
    }
  } finally { await f.cleanup(); }
});

test('Codex app does not borrow private codex or copilot paths in a multi-runtime project', async () => {
  const f = await fixture(); try {
    await f.write('.ai-factory.json', { version: '2.21.0', agents: [
      { id: 'codex', skillsDir: '.codex/skills', installedSkills: ['aif-plan'] },
      { id: 'copilot', skillsDir: '.agents/skills', installedSkills: ['aif-explore'] },
    ] });
    await f.write('.codex/skills/aif-plan/SKILL.md', '# Private Codex CLI skill');
    const s = await collectSnapshot(input(f.root));
    assert.deepEqual(s.skills, []); assert(s.diagnostics.some(d => d.includes('установка не найдена')));
  } finally { await f.cleanup(); }
});
test('OpenSpec chooses tasks.md; existing directories alone do not activate native mode', async () => {
  const f = await fixture(true, true); try {
    await f.write('openspec/changes/demo/tasks.md', '# Tasks\n- [ ] 1 Work');
    const s = await collectSnapshot(input(f.root)); assert.equal(s.target?.kind, 'openspec'); assert.equal(s.profile, 'aifhub-openspec');
    await f.write('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n');
    assert.equal((await collectSnapshot(input(f.root))).profile, 'aifhub-classic');
  } finally { await f.cleanup(); }
});
test('legacy ultra uses index ledger and rejects classic collision', async () => {
  const f = await fixture(true); try {
    await f.write('.ai-factory/plans/demo/index.md', '<!-- aif:plan-mode:ultra -->\n# Demo\n- [ ] 1 Work');
    const s = await collectSnapshot(input(f.root)); assert.equal(s.profile, 'aifhub-ultra'); assert.equal(s.target?.path, '.ai-factory/plans/demo/index.md');
    await f.write('.ai-factory/plans/demo.md', '# Classic\n- [ ] Work');
    const conflict = await collectSnapshot(input(f.root, '.ai-factory/plans/demo/index.md')); assert.equal(conflict.profile, 'invalid');
  } finally { await f.cleanup(); }
});
test('gate report remains reported PASS; preparation artifacts never become green QA', async () => {
  const f = await fixture(true, true); try {
    await f.write('openspec/changes/demo/tasks.md', '# Tasks\n- [x] 1 Work');
    await f.write('.ai-factory/qa/demo/verify.md', '```aif-gate-result\n{"schema_version":1,"gate":"verify","status":"pass","blocking":false,"blockers":[],"affected_files":[]}\n```');
    await f.write('.ai-factory/qa/demo/test-cases.md', '# Cases\n- [ ] QA');
    const s = await collectSnapshot(input(f.root));
    assert.equal(s.checks.find(c => c.id === 'verify')?.state, 'reported-pass');
    assert.equal(s.checks.find(c => c.id === 'qa')?.state, 'notrun');
    assert.equal(s.checks.find(c => c.id === 'rules')?.required, true);
  } finally { await f.cleanup(); }
});
