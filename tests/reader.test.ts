import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectSnapshot, parseYaml, safeRelative, taskList, lastGate } from '../reader.ts';
import { fixture } from './fixtures.ts';
import { markPlanVerified } from '../plan-document.ts';
import { planVerification } from '../plan-verification.ts';
const input = (root: string, target = '') => ({ root, target, phase: 'plan' as const, runtime: 'codex-app', sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' });

test('preparation uses configured artifact paths and offers only installed setup skills', async () => {
  const f = await fixture();
  try {
    const metaPath = path.join(f.root, '.ai-factory.json');
    const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    metadata.agents[0].installedSkills.push('aif-architecture');
    await f.write('.ai-factory.json', metadata);
    await f.write('.agents/skills/aif-architecture/SKILL.md', '# Architecture');
    await f.write('.ai-factory/config.yaml', 'paths:\n  description: docs/project.md\n');
    await f.write('docs/project.md', '# Project');
    const snapshot = await collectSnapshot(input(f.root));
    assert.equal(snapshot.preparation?.find(step => step.id === 'describe')?.state, 'found');
    assert.equal(snapshot.preparation?.find(step => step.id === 'architecture')?.state, 'missing');
    assert.equal(snapshot.actions.find(action => action.id === 'setup-architecture')?.command, '$aif-architecture');
    assert(!snapshot.actions.some(action => action.id === 'prep-docker'));
  } finally { await f.cleanup(); }
});

test('without AI Factory the reader discovers basic plans and progress without creating setup or QA artifacts', async () => {
  const f = await fixture(); try {
    await fs.unlink(path.join(f.root, '.ai-factory.json'));
    await f.write('.bb/aif-helper/plans/one.md', '# One\n## Tasks\n- [x] One\n- [ ] Two\n## Проверки\n- [x] Not a task');
    await f.write('.bb-aif-helper/plans/two.md', '# Two\n## Tasks\n- [ ] Work');
    await promisify(execFile)('git', ['-C', f.root, 'init', '--quiet', '--initial-branch=one'], { windowsHide: true });
    const ambiguous = await collectSnapshot(input(f.root));
    assert.equal(ambiguous.profile, 'none'); assert.equal(ambiguous.target, null);
    assert(!ambiguous.actions.some(a => a.id === 'basic-implement'));
    assert.deepEqual(ambiguous.candidates.map(v => v.path).sort(), ['.bb-aif-helper/plans/two.md', '.bb/aif-helper/plans/one.md']);
    const selected = await collectSnapshot(input(f.root, '.bb/aif-helper/plans/one.md'));
    assert.equal(selected.target?.kind, 'basic'); assert.equal(selected.target?.tasks.length, 2);
    assert.equal(selected.target?.id, 'one');
    assert.equal(selected.candidates.find(candidate => candidate.path.endsWith('/one.md'))?.title, 'One');
    assert.deepEqual(selected.candidates.find(candidate => candidate.path.endsWith('/one.md'))?.progress, { completed: 1, total: 2, verified: false });
    assert.equal(selected.target?.tasks[0].done, true); assert.equal(selected.checks.length, 0);
    assert.equal(selected.actions.find(a => a.id === 'basic-implement')?.label, 'Продолжить выполнение');
    assert.equal(selected.upstream.checkedAt, null);
    const legacy = await collectSnapshot(input(f.root, '.bb-aif-helper/plans/two.md'));
    assert.equal(legacy.target?.kind, 'basic'); assert.equal(legacy.target?.tasks.length, 1);
    await assert.rejects(fs.stat(path.join(f.root, '.bb-aif-helper/plans/one.md')));
    await assert.rejects(fs.stat(path.join(f.root, '.ai-factory.json')));
    await assert.rejects(fs.stat(path.join(f.root, '.ai-factory/qa')));
    const escaped = await collectSnapshot(input(f.root, '../secret.md'));
    assert.equal(escaped.profile, 'invalid'); assert(!escaped.actions.some(a => a.id.startsWith('basic-')));
  } finally { await f.cleanup(); }
});

test('an absent basic plan resets navigation without hiding exploration or native planning', async () => {
  const f = await fixture(); try {
    await fs.unlink(path.join(f.root, '.ai-factory.json'));
    await f.write('.bb/aif-helper/plans/other.md', '# Other\n## Tasks\n- [ ] Work');
    const missing = await collectSnapshot(input(f.root, '.bb/aif-helper/plans/deleted.md'));
    assert.equal(missing.profile, 'none'); assert.equal(missing.selectionReset, true); assert.equal(missing.target, null);
    assert(missing.actions.some(a => a.id === 'basic-explore')); assert(missing.actions.some(a => a.id === 'basic-plan'));
    const unsafe = await collectSnapshot(input(f.root, '../deleted.md'));
    assert.equal(unsafe.profile, 'invalid'); assert(!unsafe.selectionReset);
    await f.write('.ai-factory.json', '{invalid json');
    const broken = await collectSnapshot(input(f.root, '.bb/aif-helper/plans/deleted.md'));
    assert.equal(broken.profile, 'invalid'); assert(!broken.selectionReset);
    assert(!broken.actions.some(a => a.id.startsWith('basic-')));
  } finally { await f.cleanup(); }
});

test('archived OpenSpec selections release scope without invalidating the project or selecting another change', async () => {
  const f = await fixture(true, true); try {
    const archived = 'openspec/changes/archive/2026-11-14-demo/tasks.md';
    const document = '# Archived\n## Tasks\n- [x] Done\n';
    await f.write(archived, document);
    await f.write('openspec/changes/other/tasks.md', '# Other\n## Tasks\n- [ ] Work\n');
    for (const target of [archived, archived.replace('/tasks.md', ''), 'openspec/changes/demo/tasks.md']) {
      const status = await collectSnapshot(input(f.root, target));
      assert.equal(status.profile, 'aifhub-openspec'); assert.equal(status.selectionReset, true); assert.equal(status.target, null);
      assert(status.diagnostics.some(value => value.includes('найден в архиве')));
      assert(!status.candidates.some(candidate => candidate.path.includes('/archive/')));
    }
    assert.equal(await fs.readFile(path.join(f.root, archived), 'utf8'), document);
    const missing = await collectSnapshot(input(f.root, 'openspec/changes/archive/2026-11-14-missing/tasks.md'));
    assert.equal(missing.profile, 'invalid'); assert(!missing.selectionReset);
    await f.write('openspec/changes/archive/2026-11-15-demo/tasks.md', document);
    const ambiguous = await collectSnapshot(input(f.root, 'openspec/changes/demo/tasks.md'));
    assert.equal(ambiguous.profile, 'invalid'); assert(!ambiguous.selectionReset);
    const unsafe = await collectSnapshot(input(f.root, 'openspec/changes/archive/../demo/tasks.md'));
    assert.equal(unsafe.profile, 'invalid'); assert(!unsafe.selectionReset);
  } finally { await f.cleanup(); }
});

test('completed plans stay on disk and only unfinished plans are auto-selected, independent of verification', async () => {
  const f = await fixture(); try {
    await fs.unlink(path.join(f.root, '.ai-factory.json'));
    await f.write('.bb/aif-helper/plans/active.md', '# Active\n## Tasks\n- [ ] Work');
    const done = '# Finished\n## Tasks\n- [x] Work\n';
    const target = '.bb/aif-helper/plans/finished.md';
    await f.write(target, done);
    const beforeVerification = await collectSnapshot(input(f.root));
    assert.equal(beforeVerification.target?.id, 'active');
    assert.equal(beforeVerification.candidates.find(candidate => candidate.path === target)?.progress?.verified, false);
    await markPlanVerified({ root: f.root, target, expectedHash: planVerification(done).contentHash });
    const view = await collectSnapshot(input(f.root));
    assert.equal(view.target?.id, 'active'); assert.equal(view.candidates.length, 2);
    assert.deepEqual(view.candidates.find(candidate => candidate.path === target)?.progress, { completed: 1, total: 1, verified: true });
    assert.equal((await collectSnapshot(input(f.root, target))).target?.verification?.verified, true);
    const edited = (await fs.readFile(path.join(f.root, target), 'utf8')).replace('- [x]', '- [ ]');
    await f.write(target, edited);
    const changed = await collectSnapshot(input(f.root));
    assert.equal(changed.candidates.find(candidate => candidate.path === target)?.progress?.verified, false);
    assert.equal(changed.target, null); assert(await fs.stat(path.join(f.root, target)));
  } finally { await f.cleanup(); }
});

test('classic done status is read for every candidate and completed checkboxes alone leave plans active', async () => {
  const f = await fixture(true); try {
    const closedPath = '.ai-factory/plans/closed.md';
    const content = '# Closed\n## Tasks\n- [x] Done\n';
    await f.write(closedPath, content);
    await f.write('.ai-factory/plans/closed/status.yaml', 'plan_id: closed\nstatus: done\nartifacts:\n  plan: .ai-factory/plans/closed.md\n');
    await f.write('.ai-factory/plans/open.md', '# Open\n## Tasks\n- [x] Done\n');
    await f.write('.ai-factory/plans/open/status.yaml', 'plan_id: open\nstatus: implemented\n');
    await promisify(execFile)('git', ['-C', f.root, 'init', '--quiet', '--initial-branch=closed'], { windowsHide: true });
    const result = await collectSnapshot(input(f.root));
    assert.equal(result.profile, 'aifhub-classic'); assert.equal(result.target?.id, 'open');
    assert.equal(result.candidates.find(c => c.path === closedPath)?.closed, true);
    assert.equal(result.candidates.find(c => c.path.endsWith('/open.md'))?.closed, undefined);
    assert.equal(result.candidates.find(c => c.path === closedPath)?.progress?.verified, false);
    const explicit = await collectSnapshot(input(f.root, closedPath));
    assert.equal(explicit.target?.id, 'closed'); assert.equal(explicit.target?.tasks.length, 1);
    await f.write('.ai-factory/plans/open/status.yaml', 'plan_id: open\nstatus: done\nplan_file: .ai-factory/plans/open.md\n');
    const allClosed = await collectSnapshot(input(f.root));
    assert.equal(allClosed.target, null); assert(allClosed.candidates.every(c => c.closed));
    assert.equal(await fs.readFile(path.join(f.root, closedPath), 'utf8'), content);
  } finally { await f.cleanup(); }
});

test('invalid or mismatched classic closure metadata keeps candidates visible instead of guessing completion', async () => {
  const f = await fixture(true); try {
    for (const [name, status] of Object.entries({ foreign: 'plan_id: other\nstatus: done\n',
      wrongPath: 'plan_id: wrongPath\nstatus: done\nplan_file: .ai-factory/plans/other.md\n',
      invalid: 'plan_id: invalid\nstatus: done\nstatus: planned\n', missing: '' })) {
      await f.write(`.ai-factory/plans/${name}.md`, '# Work\n## Tasks\n- [x] Done\n');
      if (status) await f.write(`.ai-factory/plans/${name}/status.yaml`, status);
    }
    const result = await collectSnapshot(input(f.root));
    assert.equal(result.profile, 'aifhub-classic'); assert.equal(result.target, null);
    assert(result.candidates.every(c => !c.closed));
    assert(result.diagnostics.some(v => v.includes('не привязан')));
    assert(result.diagnostics.some(v => v.includes('Не удалось прочитать статус закрытия')));
  } finally { await f.cleanup(); }
});

test('cached CLI/source versions are reused while project and extension metadata remain live', async () => {
  const f = await fixture(true); try {
    const cached = { globalCli: '9.0.0', globalSource: '/cached/package.json', installed: null, sourceVersion: '9.0.0', sourceWorktreeVersion: '9.0.0', sourceSha: 'a'.repeat(40), sourceDirty: false };
    const s = await collectSnapshot({ ...input(f.root), sourceRepo: '/does-not-exist', cachedVersions: { versions: cached, checkedAt: '2026-11-03T00:00:00Z' } });
    assert.equal(s.versions.globalCli, '9.0.0'); assert.equal(s.versions.sourceVersion, '9.0.0');
    assert.equal(s.versions.installed, '2.21.0'); assert.equal(s.extensions[0].installedVersion, '1.8.1');
    assert.equal(s.versionsCheckedAt, '2026-11-03T00:00:00Z');
  } finally { await f.cleanup(); }
});

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
    assert.equal(original.worktree.hasUncommitted, false);
    const phase = await collectSnapshot({ ...input(f.root), phase: 'verify' });
    assert.equal(original.inputsFingerprint, phase.inputsFingerprint); assert.notEqual(original.fingerprint, phase.fingerprint);
    await f.write('source.ts', 'two');
    const changed = await collectSnapshot(input(f.root)); assert.notEqual(original.inputsFingerprint, changed.inputsFingerprint);
    assert.equal(changed.worktree.hasUncommitted, true);
    await git(['add', 'source.ts']);
    assert.equal((await collectSnapshot(input(f.root))).worktree.hasUncommitted, true);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'tracked change']);
    assert.equal((await collectSnapshot(input(f.root))).worktree.hasUncommitted, false);
    await fs.writeFile(path.join(f.root, 'new.bin'), Buffer.from([255]));
    const untracked = await collectSnapshot(input(f.root)); assert(untracked.inputsFingerprint);
    assert.equal(untracked.worktree.hasUncommitted, true);
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
  assert.equal(safeRelative('.ai-factory/plans/'), '.ai-factory/plans', 'directory paths from config.yaml end with a slash');
  assert.equal(safeRelative('docs/'), 'docs');
  assert.throws(() => safeRelative('/'));
});
test('duplicate YAML keys fail rather than choosing a hidden mode', () => {
  assert.throws(() => parseYaml('aifhub: true\naifhub: false'));
});
test('scalar YAML and malformed tools mapping cannot enable a workflow', async () => {
  assert.throws(() => parseYaml('true'));
  const f = await fixture(true); try {
    await f.write('.ai-factory/config.yaml', 'aifhub:\n  tools: true\n');
    const s = await collectSnapshot(input(f.root)); assert.equal(s.profile, 'invalid'); assert(s.actions.some(a => a.id === 'update-factory')); assert(s.actions.every(a => a.group === 'maintenance'));
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

test('OpenSpec doctor is an optional unknown check while policy-required rules stay required', async () => {
  const f = await fixture(true, true); try {
    await f.write('openspec/changes/demo/tasks.md', '# Tasks\n- [ ] Implement');
    const s = await collectSnapshot(input(f.root));
    assert.equal(s.profile, 'aifhub-openspec');
    assert.equal(s.checks.find(c => c.id === 'rules')?.required, true);
    const doctor = s.checks.find(c => c.id === 'mode')!;
    assert.equal(doctor.required, false); assert.equal(doctor.state, 'unknown'); assert.equal(doctor.path, null);
    assert.equal(s.actions.find(a => a.id === 'check-mode')?.command, '$aif-mode doctor --change "demo"');
    await f.write('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n  openspec:\n    requireRulesPassForDone: false\n');
    assert.equal((await collectSnapshot(input(f.root))).checks.find(c => c.id === 'rules')?.required, false);
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
    const s = await collectSnapshot(input(f.root)); assert.equal(s.profile, 'invalid'); assert.deepEqual(s.actions.map(a => a.id), ['update-factory', 'update-extensions']);
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

test('readiness reflects project files and config.yaml paths; an invalid profile has no steps', async () => {
  const f = await fixture();
  try {
    const state = (s: Awaited<ReturnType<typeof collectSnapshot>>, id: string) => s.readiness.find(r => r.id === id);
    let s = await collectSnapshot(input(f.root));
    assert.equal(state(s, 'install')?.state, 'done');
    assert.equal(state(s, 'context')?.state, 'todo');
    assert.deepEqual(state(s, 'context')?.missing, ['.ai-factory/DESCRIPTION.md', '.ai-factory/rules/base.md', 'AGENTS.md']);
    assert.equal(state(s, 'ci')?.state, 'todo');
    await f.write('.ai-factory/config.yaml', 'paths:\n  description: docs/about.md\nrules:\n  base: rules/base.md\n');
    for (const rel of ['docs/about.md', 'rules/base.md', 'AGENTS.md', '.github/workflows/ci.yml', '.husky/pre-commit']) await f.write(rel, 'x');
    s = await collectSnapshot(input(f.root));
    assert.equal(state(s, 'context')?.state, 'done');
    assert.equal(state(s, 'ci')?.state, 'done');
    assert.equal(state(s, 'quality')?.state, 'done');
    assert.equal(state(s, 'architecture')?.state, 'todo');
    await f.write('.ai-factory.json', '{');
    assert.deepEqual((await collectSnapshot(input(f.root))).readiness, []);
  } finally { await f.cleanup(); }
});

test('Spec coverage and Done readiness rows exist only with AIFHub; a missing report reads as not run', async () => {
  for (const hub of [false, true]) {
    const f = await fixture(hub);
    try {
      await f.write('.ai-factory/plans/demo.md', '# Demo\n## Tasks\n- [ ] 1 Implement');
      const ids = (await collectSnapshot(input(f.root))).checks.map(c => c.id);
      assert.equal(ids.includes('coverage'), hub); assert.equal(ids.includes('readiness'), hub);
      assert.equal((await collectSnapshot(input(f.root))).checks.find(c => c.id === 'verify')?.detail, 'Отчёт проверки не найден');
    } finally { await f.cleanup(); }
  }
});

test('plan and QA directories from config.yaml may end with a slash', async () => {
  const f = await fixture(); try {
    await f.write('.ai-factory/config.yaml', 'paths:\n  plans: .ai-factory/plans/\n  qa: .ai-factory/qa/\n');
    await f.write('.ai-factory/plans/feature.md', '# Feature\n## Tasks\n- [ ] Task 1: Work\n');
    const s = await collectSnapshot(input(f.root, '.ai-factory/plans/feature.md'));
    assert.notEqual(s.profile, 'invalid'); assert(!s.diagnostics.some(d => /не найден в допустимых|Недопустимый путь/.test(d)));
    assert.equal(s.target?.path, '.ai-factory/plans/feature.md'); assert.equal(s.target?.tasks.length, 1);
    assert(s.candidates.every(c => !c.path.includes('//')));
  } finally { await f.cleanup(); }
});

test('taskList keeps implement-coordinator marks [~] and [!] as open tasks', () => {
  const tasks = taskList('## Tasks\n<!-- parallel: tasks 1, 2 -->\n- [~] Task 1: A <!-- in-progress -->\n- [!] Task 2: B <!-- failed: tests -->\n- [x] Task 3: C\n');
  assert.deepEqual(tasks.map(t => [t.id, t.done]), [['1', false], ['2', false], ['3', true]]);
});
