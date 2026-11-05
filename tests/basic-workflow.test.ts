import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from './fixtures.ts';
import { basicActions, basicPrompt, usesBasicWorkflow, BASIC_PLAN_ROOT } from '../basic-workflow.ts';
import { workflowActions, actionPrompt } from '../workflow.ts';

const bare = () => snapshot({ configured: false, profile: 'none', skills: [], candidates: [], target: null, phase: 'unknown' });
const plan = () => ({ path: BASIC_PLAN_ROOT + '/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const,
  tasks: [{ id: '1', title: 'One', done: false }, { id: '2', title: 'Two', done: false }] });

test('basic flow works without CLI or skills, and installation stays separate from next steps', () => {
  const s = bare(); s.versions.globalCli = null;
  assert(usesBasicWorkflow(s));
  const actions = workflowActions(s);
  assert.deepEqual(actions.filter(a => a.group === 'next').map(a => a.id), ['basic-explore', 'basic-plan']);
  assert(actions.every(a => a.available));
  assert.equal(actions.find(a => a.id === 'basic-install')?.group, 'maintenance');
  assert(actions.every(a => !/^[/$]aif/.test(a.command)));
  const prompt = actionPrompt(s, actions[0]);
  assert.match(prompt, /Исследуй текущую задачу/); assert.match(prompt, /не меняй код/);
  assert(!prompt.includes('npm install')); assert(!prompt.includes('https://'));
  s.phase = 'explore'; assert.equal(workflowActions(s)[0].id, 'basic-plan');
});

test('basic plans drive implementation, resume, verification and a separate commit without claiming PASS', () => {
  const s = bare(); s.target = plan(); s.candidates = [{ ...s.target }];
  assert.equal(workflowActions(s)[0].id, 'basic-implement');
  s.target.tasks[0].done = true;
  assert.equal(workflowActions(s)[0].label, 'Продолжить выполнение');
  s.target.tasks[1].done = true;
  assert.equal(workflowActions(s)[0].id, 'basic-verify');
  s.worktree.hasUncommitted = true;
  assert.equal(workflowActions(s)[0].id, 'basic-commit');
  assert.match(actionPrompt(s, workflowActions(s)[0]), /сохрани несвязанные изменения/);
  s.phase = 'verify'; assert(workflowActions(s).some(a => a.id === 'basic-fix'));
  assert.equal(s.checks.length, 0);
  for (const action of basicActions(s)) {
    if (action.id !== 'basic-install') assert.match(actionPrompt(s, action), /Не начинай следующий шаг автоматически/);
  }
});

test('planning uses a separate Markdown file and never enables execution for missing or ambiguous plans', () => {
  const s = bare();
  const action = basicActions(s).find(a => a.id === 'basic-plan')!;
  const prompt = basicPrompt(s, action)!;
  assert(prompt.includes(BASIC_PLAN_ROOT)); assert.match(prompt, /## Tasks/);
  assert.match(prompt, /без реализации/); assert.match(prompt, /не перезаписывая чужой план/);
  s.candidates = [{ path: BASIC_PLAN_ROOT + '/one.md', title: 'one', kind: 'basic' }, { path: BASIC_PLAN_ROOT + '/two.md', title: 'two', kind: 'basic' }];
  assert(!workflowActions(s).some(a => a.id === 'basic-implement'));
  assert(!workflowActions({ ...s, profile: 'invalid' }).some(a => a.id.startsWith('basic-')));
  assert(!workflowActions(snapshot()).some(a => a.id.startsWith('basic-')));
});

test('installation is explicit and binds init to a supported runtime without adding extensions or overriding a linked CLI', () => {
  const s = bare();
  const install = basicActions(s).find(a => a.id === 'basic-install')!;
  const prompt = basicPrompt(s, install)!;
  assert.match(prompt, /npm install -g ai-factory/);
  assert.match(prompt, /ai-factory init --agents codex-app --skills all/);
  assert.match(prompt, /существующий CLI/); assert.match(prompt, /Не заменяй linked/);
  assert.match(prompt, /не добавляй MCP\/расширения/);
  s.runtime = 'unknown-runtime';
  assert(!basicPrompt(s, install)!.includes('init --agents unknown-runtime'));
  assert.match(basicPrompt(s, install)!, /уточни его у пользователя/);
});
