import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowActions, actionPrompt } from '../workflow.ts';
import { snapshot } from './fixtures.ts';

test('invalid plan/config keeps the installation updater while blocking workflow and setup', () => {
  const actions = workflowActions(snapshot({ profile: 'invalid', target: null }));
  assert.deepEqual(actions.map(a => a.id), ['update-factory']); assert.equal(actions[0].available, true);
  assert.match(actionPrompt(snapshot({ profile: 'invalid' }), actions[0]), /Не запускай реализацию/);
});

test('upstream explore offers plan and direct bug fix; AIFHub does not offer fix without findings', () => {
  const base = snapshot({ target: null, candidates: [], phase: 'explore' });
  assert(workflowActions(base).some(a => a.id === 'fix-new'));
  assert(!workflowActions({ ...base, profile: 'aifhub-openspec' }).some(a => /fix/.test(a.id)));
});
test('AIFHub plan routes through improve; upstream permits immediate implementation', () => {
  assert(workflowActions(snapshot()).some(a => a.id === 'implement'));
  const actions = workflowActions(snapshot({ profile: 'aifhub-classic' }));
  assert.equal(actions[0].id, 'improve');
  assert(!actions.some(a => a.id === 'implement'));
});
test('after fix the next owner is verify, not a new implementation run', () => {
  assert.equal(workflowActions(snapshot({ phase: 'fix', profile: 'aifhub-openspec' }))[0].id, 'verify');
});
test('fix plan is executed by fix owner', () => {
  const s = snapshot(); s.target!.kind = 'fix';
  assert.match(workflowActions(s)[0].command, /^\$aif-fix /);
});
test('reported verify pass offers readiness action without asserting done success', () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'verify', checks: [{ id: 'verify', label: 'Verify', state: 'reported-pass', detail: 'not bound', path: 'verify.md', required: true }] });
  s.target!.tasks[0].done = true;
  const a = workflowActions(s)[0];
  assert.equal(a.id, 'done'); assert.match(a.label, /Проверить готовность/);
});
test('legacy ultra never offers ordinary done finalization or bypasses receipt owner', () => {
  const s = snapshot({ profile: 'aifhub-ultra', phase: 'verify' }); s.target!.kind = 'ultra'; s.target!.tasks[0].done = true;
  const actions = workflowActions(s);
  assert.equal(actions[0].id, 'ultra-receipt'); assert(!actions.some(a => a.id === 'done'));
});
test('non-blocking verify notes do not route AIFHub into an unnecessary fix loop', () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'verify', checks: [{ id: 'verify', label: 'Verify', state: 'warn', detail: 'Non-blocking limitation', path: 'verify.md', required: true }] });
  s.target!.tasks[0].done = true;
  assert.equal(workflowActions(s)[0].id, 'done');
  assert(!workflowActions(s).some(a => a.id === 'fix-findings'));
});
test('OpenSpec rules action stays bound to the selected change rather than resolver default', () => {
  const s = snapshot({ profile: 'aifhub-openspec' }); s.target!.kind = 'openspec'; s.target!.id = 'selected-change';
  assert.match(workflowActions(s).find(a => a.id === 'check-rules')!.command, /selected-change/);
});
test('unavailable skills remain disabled and unknown target is not guessed', () => {
  assert(!workflowActions(snapshot({ skills: [] }))[0].available);
  assert.deepEqual(workflowActions(snapshot({ target: null, candidates: [{ path: 'a', title: 'a', kind: 'full' }, { path: 'b', title: 'b', kind: 'full' }] })).filter(a => a.group !== 'maintenance'), []);
});
test('quality and CI actions do not label configuration as a successful check', () => {
  const a = workflowActions(snapshot());
  assert.match(a.find(v => v.id === 'quality')!.command, /audit$/);
  assert.match(a.find(v => v.id === 'ci')!.command, /aif-chat ci$/);
  assert.match(a.find(v => v.id === 'ci-setup')!.command, /aif-ci$/);
});
test('prompts bind target and scope; Codex and slash runtimes use distinct prefixes', () => {
  const s = snapshot();
  assert.match(actionPrompt(s, workflowActions(s)[0]), /expectedFingerprint/);
  assert.match(workflowActions({ ...s, runtime: 'claude' })[0].command, /^\/aif-improve/);
});
test('update and setup are available without a selected plan and with ambiguous plans', () => {
  const s = snapshot({ target: null, candidates: [] });
  for (const actions of [workflowActions(s), workflowActions({ ...s, candidates: [{ path: 'a', title: 'a', kind: 'full' }, { path: 'b', title: 'b', kind: 'full' }] })]) {
    assert(actions.find(a => a.id === 'update-factory')?.available);
    assert.equal(actions.find(a => a.id === 'setup-context')?.command, '$aif');
  }
});
test('healthy installed AIFHub chooses analyze even when a fast plan delegates upstream', () => {
  const s = snapshot({ profile: 'upstream', skills: ['aif', 'aif-analyze'], extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  const setup = workflowActions(s).find(a => a.id === 'setup-context')!;
  assert.equal(setup.command, '$aif-analyze'); assert(setup.available);
});
test('missing analyze is disabled rather than silently invoking a different setup owner', () => {
  const s = snapshot({ skills: ['aif'], extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  const a = workflowActions(s).find(a => a.id === 'setup-context')!;
  assert.equal(a.command, '$aif-analyze'); assert.equal(a.available, false);
});
test('uninitialized project can update an existing CLI without manufacturing a runnable aif', () => {
  const s = snapshot({ configured: false, profile: 'none', skills: [], target: null, candidates: [] });
  assert(workflowActions(s).find(a => a.id === 'update-factory')?.available);
  assert.equal(workflowActions(s).find(a => a.id === 'setup-context')?.available, false);
  assert(workflowActions(s).every(a => a.group === 'maintenance'));
});
test('update prompt separates package update from project refresh and preserves linked sources', () => {
  const s = snapshot(); const a = workflowActions(s).find(a => a.id === 'update-factory')!;
  const prompt = actionPrompt(s, a);
  assert.match(prompt, /npm install -g ai-factory@latest/);
  assert.match(prompt, /npm link/); assert.match(prompt, /не используй --force/);
  assert.match(prompt, /после обновления CLI заново выполни ai-factory update/i);
});

test('both update actions order core, project, extensions and verification and stop on a core failure', () => {
  const s = snapshot({ profile: 'invalid', extensions: [{ name: 'aifhub-extension', recordedVersion: '1.7.1', installedVersion: '1.7.1', source: 'local', state: 'present', contributions: [] }] });
  const actions = workflowActions(s);
  assert.deepEqual(actions.map(a => a.id), ['update-factory', 'update-extensions']);
  assert.equal(actions[1].command, 'ai-factory extension update');
  for (const action of actions) {
    const prompt = actionPrompt(s, action);
    const stages = ['1. AI Factory CLI.', '2. Установка проекта.', '3. Расширения после AI Factory.', '4. Проверка результата.'].map(stage => prompt.indexOf(stage));
    assert(stages.every((index, i) => index >= 0 && (!i || index > stages[i - 1])));
    assert.match(prompt, /Если обновление CLI или базовой установки не удалось\/не подтверждено, остановись/);
    assert.match(prompt, /выполни ai-factory extension update —/);
    assert.match(prompt, /ai-factory extension list/);
    assert.match(prompt, /extension.json/); assert.match(prompt, /SKILL.md/);
    assert.match(prompt, /skipped\/failed/); assert.match(prompt, /не запускай init или обновление расширений/);
  }
  assert(!workflowActions(snapshot()).some(a => a.id === 'update-extensions'));
});
test('setup action does not pass the selected plan as an aif argument', () => {
  const s = snapshot(); const a = workflowActions(s).find(a => a.id === 'setup-context')!;
  assert.equal(a.command, '$aif'); assert(!actionPrompt(s, a).includes(s.target!.path));
});
