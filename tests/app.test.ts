import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import { lockUnchangedChecks } from '../check-actions.ts';
import { parseReplyGate } from '../gate.ts';
import { rpcContract } from '../contract.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { loadPluginApp, renderSlot: baseRenderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const renderSlot: typeof baseRenderSlot = (registration, props, options) => baseRenderSlot(registration, props, {
  ...options, experimental_rpcContract: rpcContract, rpc: { cardVisibility: () => ({ state: 'current' }), ...options?.rpc },
});
const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
const { fireEvent, waitFor, act, within } = await import('@testing-library/react');
const { createElement, useState } = await import('react');
const app = await loadPluginApp(() => import('../app.tsx'));
const cardId = '11111111-1111-4111-8111-111111111111';
const props = { attributes: { phase: 'plan', card: cardId }, source: `::aif-chat{phase="plan" card="${cardId}"}`, message: { id: 'msg_1', threadId: 'thr_test', turnId: 'turn_1', projectId: 'proj_test' }, openWorkspaceFile: null };
function data() { const s = snapshot(); s.actions = workflowActions(s); return s; }

test('a stale action refreshes the card and requires a new click', async () => {
  const initial = data();
  const updated = { ...initial, fingerprint: 'b'.repeat(64) };
  const calls: string[] = [];
  let refreshed = false;
  const message = 'Карточка устарела. Проверьте обновлённую задачу и нажмите ещё раз.';
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: {
    status: input => { if ((input as { force?: boolean }).force) refreshed = true; return refreshed ? updated : initial; },
    run: input => {
      calls.push((input as { fingerprint: string }).fingerprint);
      return calls.length === 1 ? { sent: false, stale: true, message } : { sent: true, message: 'Отправлено' };
    },
  } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Улучшить план' }));
    await slot.findByText(message);
    const action = slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement;
    await waitFor(() => assert(!action.disabled && refreshed));
    assert.equal(slot.queryByRole('alert'), null);
    assert.deepEqual(calls, [initial.fingerprint]);
    fireEvent.click(action);
    await slot.findByText('Отправлено');
    assert.deepEqual(calls, [initial.fingerprint, updated.fingerprint]);
  } finally { slot.lifecycle.unmount(); }
});

test('preparation is hidden until requested and its help and visibility never dispatch workflow actions', async () => {
  const status = snapshot({ target: null, candidates: [] });
  status.preparation = [
    { id: 'describe', label: 'Описать проект', optional: false, state: 'missing', paths: ['.ai-factory/DESCRIPTION.md'] },
    { id: 'docker', label: 'Настроить Docker', optional: true, state: 'missing', paths: ['Dockerfile'] },
  ];
  status.checks = [{ id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Отчёт не найден', path: null, required: false }];
  status.actions = workflowActions(status);
  let runs = 0;
  const slot = renderSlot(app.threadContextCardSections[0], { threadId: 'thr_test' } as any, { rpc: {
    status: () => status,
    setPreparationVisibility: (input: any) => {
      assert.equal(input.threadId, 'thr_test');
      status.preparationVisible = input.visible;
      return { visible: input.visible };
    },
    run: () => { runs++; return { sent: true, message: 'Отправлено' }; },
  } });
  try {
    const show = await slot.findByRole('button', { name: 'Показать подготовку проекта' });
    const updates = slot.getByRole('button', { name: 'Версии и обновления' });
    const refreshStatus = slot.getByRole('button', { name: 'Обновить статус AI Factory' });
    assert.deepEqual([show, updates, refreshStatus].map(button => button.querySelector('[data-icon]')?.getAttribute('data-icon')),
      ['ListTodo', 'PackageReceive', 'RotateCcw']);
    assert.equal(show.getAttribute('aria-expanded'), 'false');
    assert.equal(slot.queryByRole('region', { name: 'Подготовка проекта' }), null);
    fireEvent.click(show);
    const preparation = await slot.findByRole('region', { name: 'Подготовка проекта' });
    assert.equal(preparation.hidden, false);
    fireEvent.click(slot.getByText('Дополнительно'));
    const help = slot.getByRole('button', { name: 'Подробнее: Настроить Docker' });
    const description = document.getElementById(help.getAttribute('aria-controls')!)!;
    assert.equal(description.hidden, true);
    fireEvent.click(help);
    assert.equal(help.getAttribute('aria-expanded'), 'true');
    assert.equal(description.hidden, false);
    assert.match(description.textContent!, /Dockerfile/);
    fireEvent.click(slot.getByText('Что проверить'));
    const check = slot.getByRole('button', { name: 'Подробнее: Соответствие плану' });
    fireEvent.click(check);
    assert.equal(check.getAttribute('aria-expanded'), 'true');
    fireEvent.click(slot.getByRole('button', { name: 'Скрыть подготовку проекта' }));
    await waitFor(() => assert.equal(Boolean(slot.queryByRole('region', { name: 'Подготовка проекта' })), false));
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('2.22 plan controls, skipped tasks and version-gated diagnostics remain explicit in the panel', async () => {
  const s = snapshot({ fixDefaults: { mode: 'plan', patch: false } });
  s.versions.installed = '2.22.0'; s.versions.globalCli = '2.21.0';
  s.target!.settings = { commitStrategy: 'incremental-at-end', methodology: 'tdd', tddGranularity: 'feature-based' };
  s.target!.tasks = [{ id: '1', title: 'Docs', done: true, outcome: 'skipped' }];
  s.checks = [{ id: 'worktree', label: 'Ресурсы worktree', state: 'unknown', detail: 'Статическая диагностика', path: null, required: false }];
  s.actions = workflowActions(s);
  const slot = renderSlot(app.threadContextCardSections[0], { threadId: 'thr_test' } as any, { rpc: { status: () => s } });
  try {
    assert.match((await slot.findByLabelText('Настройки плана')).textContent!, /incremental-at-end.*tdd.*feature-based/);
    assert(slot.getByLabelText('Пропущена по плану'));
    assert.equal((slot.getByRole('button', { name: 'Проверить ресурсы worktree · нужен CLI 2.22+', hidden: true }) as HTMLButtonElement).disabled, true);
    assert.match(slot.getByText(/learning patch/).textContent!, /выключен/);
  } finally { slot.lifecycle.unmount(); }
});

test('only the latest inline card stays mounted; superseded cards stop reading workflow status', async () => {
  const nextId = '22222222-2222-4222-8222-222222222222';
  let latest = cardId; let oldReads = 0;
  let reveal!: () => void;
  const Directive = app.messageDirectives[0].component;
  function History() {
    const [fresh, setFresh] = useState(false); reveal = () => setFresh(true);
    return createElement('div', null,
      createElement('div', { 'data-testid': 'old' }, createElement(Directive, props)),
      fresh && createElement('div', { 'data-testid': 'fresh' }, createElement(Directive, { ...props,
        attributes: { ...props.attributes, card: nextId, phase: 'explore' }, message: { ...props.message, id: 'msg_2' } })));
  }
  const slot = renderSlot({ ...app.messageDirectives[0], component: History }, props, { rpc: {
    cardVisibility: (input: any) => ({ state: input.cardId === latest ? 'current' : 'superseded' }),
    status: (input: any) => { if (input.phase === 'plan') oldReads++; return data(); },
  } });
  try {
    const old = within(slot.getByTestId('old'));
    await old.findByRole('button', { name: 'Улучшить план' });
    await act(async () => { latest = nextId; reveal(); });
    const fresh = within(slot.getByTestId('fresh'));
    await fresh.findByRole('button', { name: 'Улучшить план' });
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.ok(old.queryByLabelText('AI Factory workflow') === null, 'element should be absent'));
    const readsAfterHide = oldReads;
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal(oldReads, readsAfterHide);
    assert(fresh.getByRole('button', { name: 'Улучшить план' }));
  } finally { slot.lifecycle.unmount(); }
});

test('legacy cards without an identity render nothing and perform no workflow reads', async () => {
  let reads = 0;
  const legacy = renderSlot(app.messageDirectives[0], { ...props, attributes: { phase: 'plan' } }, { rpc: {
    status: () => { reads++; return data(); }, cardVisibility: () => { reads++; return { state: 'current' }; },
  } });
  try { assert.ok(legacy.queryByLabelText('AI Factory workflow') === null, 'element should be absent'); assert.equal(reads, 0); }
  finally { legacy.lifecycle.unmount(); }
});

test('unavailable visibility never exposes an old card and recovers on a later update', async () => {
  let failed = true; let reads = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: {
    cardVisibility: () => { if (failed) throw new Error('unavailable'); return { state: 'current' }; },
    status: () => { reads++; return data(); },
  } });
  try {
    await waitFor(() => assert(slot.inspection.rpcCalls.some(c => c.method === 'cardVisibility')));
    assert.ok(slot.queryByLabelText('AI Factory workflow') === null, 'element should be absent'); assert.equal(reads, 0);
    failed = false; await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await slot.findByRole('button', { name: 'Улучшить план' });
  } finally { slot.lifecycle.unmount(); }
});

test('matching updater buttons are inside version details, with extension versions in the short line', async () => {
  const s = snapshot({ skills: ['aif', 'aif-analyze'], extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  s.versions.globalCli = s.versions.installed = s.versions.sourceVersion = s.versions.sourceWorktreeVersion = '2.21.0';
  s.upstream = { ...s.upstream, version: '2.21.0', checkedAt: new Date().toISOString() };
  s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    const setup = await slot.findByRole('button', { name: 'Запустить aif-analyze' });
    const card = setup.closest('.aif-card')!;
    assert.match(card.querySelector('.aif-versions')!.textContent!, /aifhub-extension.*1.8.1/);
    const update = slot.getByRole('button', { name: 'Обновить AI Factory', hidden: true });
    assert(update.closest('.aif-details')); assert(!setup.closest('.aif-details'));
    assert(slot.getByRole('button', { name: 'Обновить расширения', hidden: true }).closest('.aif-details'));
    const check = slot.getByRole('button', { name: 'Проверить версию в GitHub', hidden: true }) as HTMLButtonElement;
    assert.equal(check.disabled, true); assert.ok(slot.getByText(/Следующая проверка GitHub/, { selector: 'span' }));
  } finally { slot.lifecycle.unmount(); }
});

test('configuration errors do not hide the installation update button', async () => {
  const s = snapshot({ profile: 'invalid', target: null, diagnostics: ['Выбранный план/change не найден в допустимых артефактах.'] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Версии и обновления' }));
    assert.equal((await slot.findByRole('button', { name: 'Обновить AI Factory' }) as HTMLButtonElement).disabled, false);
    assert.ok(slot.queryByRole('button', { name: 'Выполнить план' }) === null, 'element should be absent');
    assert.ok(slot.queryByRole('button', { name: 'Запустить aif' }) === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('without AI Factory the installer appears only in preparation and the bundled flow remains available', async () => {
  const s = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'unknown' });
  s.preparation = [{ id: 'install', label: 'Установить AI Factory', optional: false, state: 'missing', paths: ['.ai-factory.json'] }];
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: {
    status: () => s,
    setPreparationVisibility: (input: any) => {
      s.preparationVisible = input.visible;
      return { visible: input.visible };
    },
    run: (input: any) => {
      assert.equal(input.actionId, 'basic-explore'); assert.equal(input.researchTask, 'Почему форма не принимает завтрашнюю дату?'); runs++; return { sent: true, message: 'Отправлено' };
    },
  } });
  try {
    const showPreparation = await slot.findByRole('button', { name: 'Показать подготовку проекта' });
    assert.equal(Boolean(slot.queryByRole('button', { name: 'Установить AI Factory' })), false);
    fireEvent.click(showPreparation);
    const preparation = await slot.findByRole('region', { name: 'Подготовка проекта' });
    const install = within(preparation).getByRole('button', { name: 'Установить AI Factory' }) as HTMLButtonElement;
    assert.equal(install.disabled, false);
    assert.equal(slot.getAllByRole('button', { name: 'Установить AI Factory' }).length, 1);
    assert.match(slot.getByLabelText('Базовый workflow').textContent!, /исследование → Plan BB → выполнение → проверка → коммит/);
    const explore = slot.getByRole('button', { name: 'Исследовать задачу' }) as HTMLButtonElement;
    assert.equal(explore.disabled, false); assert.equal(runs, 0);
    assert.ok(slot.queryByRole('button', { name: /Запустить aif/ }) === null, 'element should be absent');
    fireEvent.click(explore);
    const field = await slot.findByRole('textbox', { name: 'Что исследовать?' });
    assert.equal(runs, 0);
    const start = slot.getByRole('button', { name: 'Начать исследование' }) as HTMLButtonElement;
    assert.equal(start.disabled, true);
    fireEvent.change(field, { target: { value: '  Почему форма не принимает завтрашнюю дату?  ' } });
    fireEvent.click(start); fireEvent.click(start); await waitFor(() => assert.equal(runs, 1));
    await waitFor(() => assert.ok(slot.queryByRole('form', { name: 'Описание исследования' }) === null, 'element should be absent'));
  } finally { slot.lifecycle.unmount(); }
});

test('preparation offers an update for a project with AI Factory installed', async () => {
  const s = snapshot({ preparationVisible: true, preparation: [
    { id: 'install', label: 'Установить AI Factory', optional: false, state: 'found', paths: ['.ai-factory.json'] },
  ] });
  s.actions = workflowActions(s);
  const dispatched: string[] = [];
  const slot = renderSlot(app.threadContextCardSections[0], { threadId: 'thr_test' } as any, { rpc: {
    status: () => s,
    run: (input: any) => { dispatched.push(input.actionId); return { sent: true, message: 'Отправлено' }; },
  } });
  try {
    const preparation = within(await slot.findByRole('region', { name: 'Подготовка проекта' }));
    assert(preparation.getByText('AI Factory установлен'));
    assert.equal(Boolean(preparation.queryByRole('button', { name: 'Установить AI Factory' })), false);
    const update = preparation.getByRole('button', { name: 'Обновить AI Factory' });
    assert.deepEqual(dispatched, []);
    fireEvent.click(update);
    await waitFor(() => assert.deepEqual(dispatched, ['update-factory']));
  } finally { slot.lifecycle.unmount(); }
});

test('the document renders before its form and only a completed saved plan exposes workflow actions', async () => {
  const renderer = app.codeFenceRenderers.find(r => r.id === 'plan-document')!;
  const code = '# Ready\n\n## Tasks\n- [ ] 1. Work';
  const s = snapshot({ configured: false, profile: 'none', skills: [], target: {
    path: '.bb/aif-helper/plans/saved.md', id: 'saved', title: 'Ready', kind: 'basic', tasks: [{ id: '1', title: 'Work', done: false }],
  } }); s.actions = workflowActions(s);
  let saves = 0;
  const base = { code, language: 'aif-plan', status: 'streaming' as const, index: 0, message: props.message, Original: () => code };
  const slot = renderSlot(renderer, base, { rpc: {
    planDocument: () => { saves++; return { path: s.target!.path, seq: 20, hash: 'a'.repeat(64), environmentId: 'env_test' }; },
    status: () => s,
  } });
  try {
    assert(slot.getByLabelText('Документ плана'));
    assert.ok(slot.queryByLabelText('Действия после плана') === null, 'element should be absent'); assert.equal(saves, 0);
    slot.rerender(createElement(renderer.component, { ...base, status: 'closed' }));
    const controls = await slot.findByLabelText('Действия после плана');
    const document = slot.getByLabelText('Документ плана');
    assert(document.contains(controls)); assert.equal(saves, 1);
    assert(slot.getByText('Открыть файл плана'));
    await slot.findByRole('button', { name: 'Выполнить план' });
  } finally { slot.lifecycle.unmount(); }
  const interrupted = renderSlot(renderer, { ...base, status: 'unclosed' }, { rpc: { planDocument: () => { throw Error('must not save'); } } });
  try { assert.ok(interrupted.queryByLabelText('Действия после плана') === null, 'element should be absent'); assert(interrupted.getByText(/Неполный план/)); }
  finally { interrupted.lifecycle.unmount(); }
});

test('a stale plan reference is released and research/planning buttons remain usable without AI Factory', async () => {
  const base = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'explore' });
  base.actions = workflowActions(base);
  const requests: any[] = [];
  const deleted = '.bb/aif-helper/plans/deleted.md';
  const slot = renderSlot(app.messageDirectives[0], { ...props, attributes: { ...props.attributes, target: deleted, phase: 'explore' } }, { rpc: {
    status: (input: any) => { requests.push(input); return input.target ? { ...base, selectionReset: true } : base; },
  } });
  try {
    await slot.findByRole('button', { name: 'Составить план' });
    const research = slot.getByRole('button', { name: 'Исследовать задачу' }) as HTMLButtonElement;
    assert.equal(research.disabled, false);
    await waitFor(() => assert(requests.some(input => input.target === '' && input.newTask === true)));
    fireEvent.click(research); await slot.findByRole('textbox', { name: 'Что исследовать?' });
  } finally { slot.lifecycle.unmount(); }
});

test('the selector hides completed plans without requiring verification and restores them with a view-only toggle', async () => {
  const s = snapshot({ configured: false, profile: 'none', skills: [], candidates: [
    { path: '.bb/aif-helper/plans/active.md', title: 'Active task', kind: 'basic', progress: { completed: 1, total: 3, verified: false } },
    { path: '.bb/aif-helper/plans/done.md', title: 'Finished task', kind: 'basic', progress: { completed: 2, total: 2, verified: false } },
  ], target: null }); s.actions = workflowActions(s); let sends = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { sends++; throw Error('must not dispatch'); } } });
  try {
    const select = await slot.findByRole('combobox', { name: 'Выбранный план или change' });
    assert.match(select.textContent!, /Active task · выполнено 1 из 3/); assert(!select.textContent!.includes('Finished task'));
    const toggle = slot.getByRole('checkbox', { name: 'Показать завершённые (1)' });
    fireEvent.click(toggle);
    assert.match(select.textContent!, /Finished task · выполнено 2 из 2/);
    fireEvent.click(toggle); assert(!select.textContent!.includes('Finished task'));
    assert.equal(sends, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('closed classic plans are hidden, restorable and distinct from checkbox-complete active plans', async () => {
  const s = snapshot({ profile: 'aifhub-classic', target: null, candidates: [
    { path: '.ai-factory/plans/closed.md', title: 'Closed classic', kind: 'classic', closed: true, progress: { completed: 12, total: 12, verified: false } },
    { path: '.ai-factory/plans/open.md', title: 'Still open classic', kind: 'classic', progress: { completed: 12, total: 12, verified: false } },
  ] }); s.actions = workflowActions(s); let sends = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { sends++; throw Error('must not dispatch'); } } });
  try {
    const select = await slot.findByRole('combobox', { name: 'Выбранный план или change' });
    assert(select.textContent!.includes('Still open classic')); assert(!select.textContent!.includes('Closed classic'));
    const toggle = slot.getByRole('checkbox', { name: 'Показать завершённые (1)' });
    fireEvent.click(toggle); assert.match(select.textContent!, /Closed classic · выполнено 12 из 12 · закрыт · classic/);
    fireEvent.click(toggle); assert(!select.textContent!.includes('Closed classic')); assert.equal(sends, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('a proposed native plan shows an explicit execution button instead of asking to create another plan', async () => {
  const s = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'plan',
    chatPlan: { seq: 20, hash: 'a'.repeat(64), title: 'Native proposal', accepted: false } });
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: (input: any) => {
    assert.equal(input.actionId, 'basic-implement'); runs++; return { sent: true, message: 'Отправлено' };
  } } });
  try {
    const execute = await slot.findByRole('button', { name: 'Выполнить предложенный план' });
    assert(slot.getByLabelText('План из чата')); assert.ok(slot.queryByRole('progressbar') === null, 'element should be absent');
    assert(slot.getByRole('button', { name: 'Уточнить план' })); assert.ok(slot.queryByRole('button', { name: 'Составить план' }) === null, 'element should be absent');
    assert.equal(runs, 0); fireEvent.click(execute); fireEvent.click(execute); await waitFor(() => assert.equal(runs, 1));
  } finally { slot.lifecycle.unmount(); }
});

test('a completed plan keeps its actions and opens a separate new-task research form before resetting selection', async () => {
  const target = { path: '.bb/aif-helper/plans/finished.md', id: 'finished', title: 'Finished task', kind: 'basic' as const,
    tasks: [{ id: '1', title: 'Done', done: true }] };
  const s = snapshot({ configured: false, profile: 'none', target, candidates: [{ ...target }], skills: [], phase: 'done', worktree: { hasUncommitted: true } });
  s.actions = workflowActions(s);
  const next = snapshot({ ...s, target: null, phase: 'explore' }); next.actions = workflowActions(next);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: (input: any) => input.newTask ? next : s,
    run: (input: any) => { assert.equal(input.actionId, 'basic-explore'); assert.equal(input.researchTask, 'Исследовать #16'); runs++;
      return { sent: true, message: 'Отправлено', newTask: true }; } } });
  try {
    await slot.findByRole('button', { name: 'Исследовать новую задачу' });
    assert(slot.getByRole('button', { name: 'Подготовить коммит' })); assert(slot.getByRole('button', { name: 'Проверить реализацию' }));
    fireEvent.click(slot.getByRole('button', { name: 'Исследовать новую задачу' }));
    await slot.findByRole('textbox', { name: 'Что исследовать?' }); assert.equal(runs, 0);
    fireEvent.click(slot.getByRole('button', { name: 'Отмена' })); assert(slot.getByText('Finished task')); assert.equal(runs, 0);
    fireEvent.click(slot.getByRole('button', { name: 'Исследовать новую задачу' }));
    fireEvent.change(await slot.findByRole('textbox', { name: 'Что исследовать?' }), { target: { value: 'Исследовать #16' } });
    fireEvent.click(slot.getByRole('button', { name: 'Начать исследование' }));
    await waitFor(() => assert.equal(runs, 1));
    await slot.findByRole('button', { name: 'Составить план' });
    assert.ok(slot.queryByRole('progressbar') === null, 'element should be absent'); assert.ok(slot.queryByRole('form', { name: 'Описание исследования' }) === null, 'element should be absent');
    assert.equal((slot.getByRole('combobox', { name: 'Выбранный план или change' }) as HTMLSelectElement).value, '');
  } finally { slot.lifecycle.unmount(); }
});

test('research description can be cancelled and survives refresh and failed dispatch without sending an empty task', async () => {
  const s = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [] });
  s.actions = workflowActions(s); let attempts = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { attempts++; throw new Error('Контекст изменился'); } } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Исследовать задачу' }));
    const field = await slot.findByRole('textbox', { name: 'Что исследовать?' }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '   \n  ' } });
    assert.equal((slot.getByRole('button', { name: 'Начать исследование' }) as HTMLButtonElement).disabled, true);
    fireEvent.click(slot.getByRole('button', { name: 'Отмена' }));
    assert.ok(slot.queryByRole('textbox') === null, 'element should be absent'); assert.equal(attempts, 0);
    fireEvent.click(slot.getByRole('button', { name: 'Исследовать задачу' }));
    const draft = 'Исследовать #213\nПроверить ограничения дат.';
    fireEvent.change(slot.getByRole('textbox'), { target: { value: draft } });
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal((slot.getByRole('textbox') as HTMLTextAreaElement).value, draft);
    s.threadState = 'active'; await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal((slot.getByRole('button', { name: 'Начать исследование' }) as HTMLButtonElement).disabled, true);
    s.threadState = 'idle'; await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.equal((slot.getByRole('button', { name: 'Начать исследование' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(slot.getByRole('button', { name: 'Начать исследование' }));
    await waitFor(() => assert.equal(attempts, 1));
    await slot.findByRole('alert');
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.match(slot.getByRole('alert').textContent!, /Контекст изменился/);
    await waitFor(() => assert.equal((slot.getByRole('textbox') as HTMLTextAreaElement).value, draft));
  } finally { slot.lifecycle.unmount(); }
});

test('a stale SessionBrief displays recovery next to a disabled execution button without dispatch on render', async () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'implement' }); s.target!.kind = 'openspec';
  s.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1', source: 'local', state: 'present', contributions: [], commands: ['aifhub-session-brief'] }];
  s.sessionBrief = { target: s.target!.path, seq: 2, status: 'stale' }; s.actions = workflowActions(s);
  let sends = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { sends++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    assert.match((await slot.findByLabelText('Блокировка SessionBrief')).textContent!, /STALE.*из чата/);
    assert.equal((slot.getByRole('button', { name: 'Продолжить выполнение · контекст неактуален' }) as HTMLButtonElement).disabled, true);
    assert.equal((slot.getByRole('button', { name: 'Синхронизировать change' }) as HTMLButtonElement).disabled, false);
    assert.equal((slot.getByRole('button', { name: 'Пересобрать SessionBrief' }) as HTMLButtonElement).disabled, false);
    assert.equal(sends, 0);
    s.sessionBrief = { ...s.sessionBrief!, seq: 4, status: 'valid' }; s.actions = workflowActions(s);
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.ok(slot.queryByLabelText('Блокировка SessionBrief') === null, 'element should be absent'));
    assert.equal((slot.getByRole('button', { name: 'Продолжить выполнение' }) as HTMLButtonElement).disabled, false);
    assert.ok(slot.queryByRole('button', { name: 'Пересобрать SessionBrief' }) === null, 'element should be absent');
    assert.equal(sends, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('an OpenSpec plan with no checked tasks keeps execution and repeatable improvement side by side', async () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'unknown', worktree: { hasUncommitted: true } });
  s.target!.kind = 'openspec'; s.target!.id = '213-future-work-log-dates';
  s.actions = workflowActions(s);
  const requests: any[] = [];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s,
    run: input => { requests.push(input); return { sent: true, message: 'Отправлено' }; } } });
  try {
    const execute = await slot.findByRole('button', { name: 'Выполнить план' });
    assert.equal((execute as HTMLButtonElement).disabled, false);
    assert.equal(execute.parentElement!.parentElement, slot.getByRole('button', { name: 'Улучшить план' }).parentElement!.parentElement);
    assert.equal(requests.length, 0);
    fireEvent.click(slot.getByRole('button', { name: 'Улучшить план' }));
    await waitFor(() => assert.equal(requests.length, 1));
    s.phase = 'improve'; s.actions = workflowActions(s);
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.equal((slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(slot.getByRole('button', { name: 'Выполнить план' }));
    await waitFor(() => assert.equal(requests.length, 2));
    assert.deepEqual(requests.map(r => r.actionId), ['improve', 'implement']);
    assert(requests.every(r => r.target === s.target!.path));
  } finally { slot.lifecycle.unmount(); }
});

test('a started plan shows resume while context setup is available only under its spoiler', async () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'unknown', skills: ['aif-analyze', 'aif-implement', 'aif-improve'],
    extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  s.target!.tasks = [{ id: '1', title: 'Done', done: true }, { id: '2', title: 'Remaining', done: false }];
  s.actions = workflowActions(s);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    await slot.findByRole('button', { name: 'Продолжить выполнение' });
    const setup = slot.getByRole('button', { name: 'Запустить aif-analyze', hidden: true });
    const details = setup.closest('details')!;
    assert(details.classList.contains('aif-context-setup')); assert.equal(details.open, false);
    assert(!setup.closest('.aif-maintenance'));
    const stage = within(slot.getByRole('region', { name: 'Текущий этап' }));
    assert(stage.getByText('Контекст задачи'));
    assert.match(stage.getByText(/Контекст задачи/).textContent!, /агент свободен/);
    assert.equal(runs, 0);
    fireEvent.click(slot.getByText('Настройка контекста проекта'));
    assert.equal(details.open, true);
    assert.equal((slot.getByRole('button', { name: 'Запустить aif-analyze' }) as HTMLButtonElement).disabled, false);
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('registered extensions have a separate update button even with an invalid selected plan', async () => {
  const s = snapshot({ profile: 'invalid', extensions: [{ name: 'aifhub-extension', recordedVersion: '1.7.1', installedVersion: '1.7.1', source: 'local', state: 'present', contributions: [] }] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Версии и обновления' }));
    assert.equal((await slot.findByRole('button', { name: 'Обновить расширения' }) as HTMLButtonElement).disabled, false);
    assert.ok(slot.queryByRole('button', { name: 'Выполнить план' }) === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('saved-data state is visible and the refresh button explicitly bypasses the cache', async () => {
  const s = data(); s.cache = { source: 'saved', refreshing: true, refreshError: false };
  const requests: any[] = [];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: (input: any) => { requests.push(input); return s; } } });
  try {
    const footer = (await slot.findByText('Сохранённые данные')).closest('footer')!;
    assert.equal(footer.querySelector('time')?.dateTime, s.collectedAt);
    assert(within(footer).getByText('Обновляются в фоне…'));
    fireEvent.click(slot.getByRole('button', { name: 'Обновить статус AI Factory' }));
    await waitFor(() => assert(requests.some(input => input.force === true)));
    assert.notEqual(requests[0].force, true, 'the shared read never forces');
  } finally { slot.lifecycle.unmount(); }
});

test('the card reads status once and re-reads only when its thread tag is invalidated', async () => {
  let reads = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => { reads++; return data(); } } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(reads, 1, 'no polling');
    await slot.behavior.experimental_invalidateRpc(['thread:other']);
    assert.equal(reads, 1, 'another thread does not refresh this card');
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal(reads, 2);
  } finally { slot.lifecycle.unmount(); }
});

test('check buttons belong to their rows and unchanged checks show an accurate disabled reason', async () => {
  const s = data(); s.checks = ['verify', 'security'].map(id => ({ id, label: id === 'verify' ? 'Соответствие плану' : 'Безопасность', state: 'notrun', detail: '', path: null, required: false }));
  s.checks[0].chat = { seq: 1, at: s.collectedAt, target: s.target!.path, freshness: 'unchanged', inputFingerprint: 'a'.repeat(64),
    result: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null } };
  lockUnchangedChecks(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    const verify = await slot.findByRole('button', { name: 'Соответствие плану · без изменений', hidden: true });
    const security = slot.getByRole('button', { name: 'Безопасность', hidden: true });
    assert(verify.closest('li')?.textContent?.includes('Соответствие плану'));
    assert(security.closest('li')?.textContent?.includes('Безопасность'));
    assert.equal((verify as HTMLButtonElement).disabled, true);
    assert.equal((security as HTMLButtonElement).disabled, false);
    assert.match(verify.closest('li')!.textContent!, /не изменились/);
    assert(!verify.textContent?.includes('не установлен'));
    assert.equal(slot.queryAllByRole('button', { name: 'Соответствие плану · без изменений', hidden: true }).length, 1);
  } finally { slot.lifecycle.unmount(); }
});

test('only gate JSON gets a collapsed renderer; original code remains available unchanged', () => {
  const renderer = app.codeFenceRenderers.find(r => r.id === 'gate-data')!;
  assert.deepEqual(renderer.languages, ['aif-gate-result']);
  const code = JSON.stringify({ schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null }, null, 2);
  const slot = renderSlot(renderer, { code, language: 'aif-gate-result', status: 'closed', index: 0, message: props.message, Original: () => code });
  try {
    const summary = slot.getByText('Данные gate · verify · WARN');
    const details = summary.closest('details')!;
    assert.equal(details.open, false); assert(details.textContent?.includes(code));
    fireEvent.click(summary); assert.equal(details.open, true);
    assert.ok(slot.queryByRole('alert') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('supplementary rows are optional without downgrading known required gates or launching checks', async () => {
  const s = snapshot({ profile: 'aifhub-openspec' }); s.target!.kind = 'openspec';
  s.checks = ['rules', 'security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode'].map(id => ({
    id, label: id, state: 'notrun', detail: '', path: null, required: id === 'rules',
  }));
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    fireEvent.click(await slot.findByText('Что проверить'));
    const required = slot.getByText('rules').closest('li')!;
    assert.match(required.textContent!, /Обязательно/);
    assert(!required.textContent!.includes('по выбору'));
    for (const label of ['security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode']) {
      assert.match(slot.getByText(label).closest('li')!.textContent!, /по выбору/);
    }
    const doctor = slot.getByRole('button', { name: 'Проверить конфигурацию', hidden: true });
    assert.equal(doctor.closest('li'), slot.getByText('mode').closest('li'));
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('malformed and interrupted gate failures remain visible outside collapsed JSON', () => {
  const renderer = app.codeFenceRenderers.find(r => r.id === 'gate-data')!;
  for (const [code, status, expected] of [['{bad', 'closed', /некорректный JSON/], ['{', 'unclosed', /не закрыт/]] as const) {
    const slot = renderSlot(renderer, { code, status, language: 'aif-gate-result', index: 0, message: props.message, Original: () => code });
    try {
      const alert = slot.getByRole('alert'); assert.match(alert.textContent!, expected); assert(!alert.closest('details'));
      assert.equal(slot.getByText('Данные gate · проверить JSON').closest('details')!.open, false);
    } finally { slot.lifecycle.unmount(); }
  }
});

test('streaming partial gate stays collapsed without a premature JSON error', () => {
  const slot = renderSlot(app.codeFenceRenderers[0], { code: '{', status: 'streaming', language: 'aif-gate-result', index: 0, message: props.message, Original: () => '{' });
  try {
    assert.equal(slot.getByText('Данные gate · формируются…').closest('details')!.open, false);
    assert.ok(slot.queryByRole('alert') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('checks distinguish completed chat WARN from missing file evidence', async () => {
  const s = data(); s.checks = [{ id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Unknown launch', path: null, required: false,
    chat: { seq: 12, at: '2026-11-02T12:00:00Z', target: s.target!.path, freshness: 'unknown',
      result: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null } } }];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    fireEvent.click(await slot.findByText('Что проверить'));
    await slot.findByText('WARN · из чата');
    const details = slot.getByLabelText('Детали проверки «Соответствие плану»');
    assert.equal(details.closest('details')!.open, false);
    fireEvent.click(details);
    assert.equal(details.closest('details')!.open, true);
    assert(slot.getByText('Актуальность для текущих файлов не подтверждена.'));
    assert(slot.getByText('Файловый отчёт: не найден.'));
    assert(!slot.queryByText('Unknown launch'));
  } finally { slot.lifecycle.unmount(); }
});

test('a blocking check opens the section and shows findings before unconfirmed checks', async () => {
  const s = data();
  s.checks = [
    { id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Артефакт не найден', path: null, required: true },
    { id: 'review', label: 'Code review', state: 'notrun', detail: '', path: null, required: false, chat: {
      seq: 12, at: s.collectedAt, target: s.target!.path, freshness: 'unknown',
      result: { schema_version: 1, gate: 'review', status: 'fail', blocking: true,
        blockers: [{ id: 'regression', summary: 'Нужно исправить регрессию', severity: 'error' }],
        affected_files: [], suggested_next: null },
    } },
  ];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    const heading = await slot.findByText('Что проверить');
    const section = heading.closest('details')!;
    assert.equal(section.open, true);
    assert.equal(section.querySelector('.aif-check-row')?.getAttribute('data-blocking'), 'true');
    assert(within(section).getByText('Блокирующие · 1'));
    assert(within(section).getByText(/Нужно исправить регрессию/));
    assert.equal(section.querySelector<HTMLDetailsElement>('.aif-check-report')?.open, false);
  } finally { slot.lifecycle.unmount(); }
});

test('registers chat renderer and thread context card without replacing composer or sidebar', () => {
  assert.equal(app.messageDirectives[0].id, 'aif-chat'); assert.equal(app.threadContextCardSections.length, 1);
  assert.equal(app.navPanels.length, 0);
});
test('persistent header control opens the registered workflow tab without dispatching a command', async () => {
  const header = app.threadActions.find(a => a.id === 'open-workflow')!;
  assert.equal(header.placement, 'header');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  assert.equal(tab.availability, 'fixed'); assert.deepEqual(tab.context, { kind: 'thread' });
  const opened: unknown[] = [];
  const action = header.item({ experimental_panel: experimental_makePanelController({ openTab: options => { opened.push(options); return true; } }) } as any)!;
  assert.equal(action.label, 'AI Factory'); assert.equal(action.disabled, undefined);
  assert.equal(opened.length, 0);
  await action.run({ requestRename() {} });
  assert.deepEqual(opened, [{ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } }]);
});
test('workflow panel reads its owning thread and exposes maintenance without a transcript card', async () => {
  const readThreads: string[] = []; let runs = 0;
  const s = data();
  s.readiness = [
    { id: 'install', label: 'Установить AI Factory', actionId: 'update-factory', state: 'done', skippable: false, anyOf: false, missing: [] },
    { id: 'context', label: 'Описать проект (/aif или aif-analyze)', actionId: 'setup-context', state: 'todo', skippable: false, anyOf: false, missing: [] },
  ];
  const tab = app.tabs.find((t): t is Extract<(typeof app.tabs)[number], { availability: 'fixed'; context: { kind: 'thread' } }> => t.id === 'workflow' && t.availability === 'fixed' && t.context.kind === 'thread')!;
  const slot = renderSlot(tab, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, {
    rpc: { status: (input: any) => { readThreads.push(input.threadId); return s; }, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } },
  });
  try {
    await slot.findByText('Проект не подготовлен к AI Factory');
    await slot.findByText('Основных шагов осталось: 1 из 2');
    assert.equal(slot.queryByRole('button', { name: 'Запустить: Описать проект (/aif или aif-analyze)' }), null, 'navigation shows a prompt, not the step list');
    fireEvent.click(slot.getByRole('button', { name: 'Версии и обновления' }));
    await slot.findByRole('button', { name: 'Обновить AI Factory' });
    fireEvent.click(slot.getByRole('tab', { name: 'Навигация' }));
    fireEvent.click(slot.getByRole('button', { name: 'Подготовить' }));
    assert.equal(slot.getByRole('tab', { name: /Настройки/ }).getAttribute('aria-selected'), 'true');
    await slot.findByRole('button', { name: 'Запустить: Описать проект (/aif или aif-analyze)' });
    assert.deepEqual(readThreads, ['thr_panel']); assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); window.sessionStorage.clear(); }
});
test('panel uses the BB provider/model picker and saves exactly its selection', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const saved: unknown[] = [];
  const view = (choice: unknown, research: unknown = { mode: 'self' }) => ({ choice, research, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null, providers: [{ id: 'codex', name: 'Codex' }],
    defaults: null, appliedDefaults: null,
    children: [{ id: 'thr_child', title: 'Задача 1', status: 'active', providerId: 'codex', updatedAt: '2026-11-17T00:00:00Z', worktree: false, execution: null, fallback: null, mismatch: null }] });
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: {
    status: () => data(),
    delegation: () => view({ mode: 'self' }),
    setDelegation: (input: any) => { saved.push(input); return input.role === 'research' ? view({ mode: 'self' }, input.choice) : view(input.choice); },
  } });
  try {
    await slot.findByText('Задача 1');
    assert.ok(slot.getByText(/Codex · работает/));
    assert.ok(slot.queryByRole('button', { name: 'Сохранить' }) === null, 'element should be absent');
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    for (const title of ['Код', 'Разведчик 1', 'Разведчик 2', 'Разведчик 3'])
      assert.ok(slot.getByRole('button', { name: `Изменить: ${title}` }), `edit button for ${title}`);
    assert.equal(slot.queryAllByRole('radiogroup').length, 0, 'role editors open only on «Изменить»');
    const openEditor = async (title: string) => {
      fireEvent.click(slot.getByRole('button', { name: `Изменить: ${title}` }));
      return slot.findByRole('radiogroup');
    };
    const closeEditor = (group: HTMLElement) => fireEvent.click(within(group.parentElement!).getByRole('button', { name: 'Отменить' }));
    let group = await openEditor('Разведчик 2');
    assert.equal(group.getAttribute('aria-label'), 'Кто ищет шаблоны');
    assert.ok(within(group).getByRole('radio', { name: 'Как разведчик 1' }), 'worker 2 has its own choice');
    closeEditor(group);
    group = await openEditor('Разведчик 3');
    assert.equal(group.getAttribute('aria-label'), 'Кто ищет связи');
    assert.ok(within(group).getByRole('radio', { name: 'Как разведчик 1' }));
    closeEditor(group);
    group = await openEditor('Код');
    assert.equal(group.getAttribute('aria-label'), 'Кто пишет код');
    fireEvent.click(within(group).getByRole('radio', { name: 'Другая модель' }));
    const picker = await slot.findByTestId('bb-provider-model-picker');
    assert.equal(picker.dataset.routingKind, 'environment'); assert.equal(picker.dataset.routingId, 'env_panel');
    fireEvent.change(slot.getByLabelText('Provider ID'), { target: { value: 'codex' } });
    fireEvent.change(slot.getByLabelText('Model'), { target: { value: 'gpt-6.2-sol' } });
    fireEvent.change(slot.getByLabelText('Reasoning level'), { target: { value: 'high' } });
    fireEvent.change(slot.getByLabelText('Service tier'), { target: { value: 'fast' } });
    fireEvent.click(slot.getByRole('button', { name: 'Apply execution selection' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.equal(saved.length, 1));
    assert.deepEqual(saved, [{ threadId: 'thr_panel', role: 'implement', choice: { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' } }]);
    await slot.findByText('Codex · gpt-6.2-sol · high');
    group = await openEditor('Разведчик 1');
    assert.equal(group.getAttribute('aria-label'), 'Кто исследует код');
    fireEvent.click(within(group).getByRole('radio', { name: 'Другая модель' }));
    await waitFor(() => assert.equal(slot.getAllByTestId('bb-provider-model-picker').length, 1));
    const research = within(slot.getAllByTestId('bb-provider-model-picker')[0]);
    fireEvent.change(research.getByLabelText('Provider ID'), { target: { value: 'codex' } });
    fireEvent.change(research.getByLabelText('Model'), { target: { value: 'gpt-6.2-luna' } });
    fireEvent.click(research.getByRole('button', { name: 'Apply execution selection' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.equal(saved.length, 2));
    assert.equal((saved[1] as any).role, 'research'); assert.equal((saved[1] as any).choice.model, 'gpt-6.2-luna');
    await slot.findByText(/Codex · gpt-6\.2-luna/);
  } finally { slot.lifecycle.unmount(); }
});
test('card renders real buttons, read-only progress and sends selected action once', async () => {
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => data(), run: () => { runs++; return { sent: true, message: 'Команда отправлена' }; } } });
  try {
    const button = await slot.findByRole('button', { name: 'Улучшить план' });
    await slot.findByText('0/1 задач');
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => assert.equal(runs, 1));
    assert.equal(slot.queryAllByRole('checkbox').length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('dirty files show commit without an active plan and busy state disables it without sending', async () => {
  for (const busy of [false, true]) {
    const s = snapshot({ profile: 'aifhub-openspec', phase: 'done', target: null, candidates: [],
      worktree: { hasUncommitted: true }, threadState: busy ? 'active' : 'idle' });
    s.actions = workflowActions(s); let runs = 0;
    const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
    try {
      const commit = await slot.findByRole('button', { name: 'Подготовить коммит' }) as HTMLButtonElement;
      assert.equal(commit.disabled, busy); assert.equal(runs, 0);
      assert.equal(slot.queryAllByRole('button', { name: 'Подготовить коммит' }).length, 1);
    } finally { slot.lifecycle.unmount(); }
  }
});
test('persistent panel keeps native questions visible and disables action buttons', async () => {
  const s = data(); s.threadState = 'awaiting_input'; s.pendingQuestions = 2;
  const slot = renderSlot(app.threadContextCardSections[0], { threadId: 'thr_test' } as any, { rpc: { status: () => s } });
  try {
    await slot.findByText(/ожидаю ответы: 2/);
    assert.equal((slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement).disabled, true);
  } finally { slot.lifecycle.unmount(); }
});

test('transcript cards hide while confirmation or native answers are pending and return after a reply', async () => {
  let s = data();
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' });
    s.pendingConfirmation = true; await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.ok(slot.queryByLabelText('AI Factory workflow') === null, 'element should be absent'));
    s = data(); await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await slot.findByRole('button', { name: 'Улучшить план' });
    s.pendingQuestions = 1; await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    await waitFor(() => assert.ok(slot.queryByLabelText('AI Factory workflow') === null, 'element should be absent'));
    assert.equal(slot.inspection.rpcCalls.filter(c => c.method === 'run').length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('persistent panel names a prose confirmation and prevents navigation without hiding progress', async () => {
  const s = data(); s.pendingConfirmation = true;
  const slot = renderSlot(app.threadContextCardSections[0], { threadId: 'thr_test' } as any, { rpc: { status: () => s } });
  try {
    await slot.findByText(/ожидается подтверждение пользователя/);
    await slot.findByText('0/1 задач');
    assert.equal((slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement).disabled, true);
    assert(slot.getByText('Действия доступны после ответа пользователя'));
  } finally { slot.lifecycle.unmount(); }
});
test('metadata failure removes stale actions instead of keeping executable old snapshot', async () => {
  let fails = false;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => { if (fails) throw new Error('metadata unavailable'); return data(); } } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' }); fails = true;
    fireEvent.click(slot.getByRole('button', { name: 'Обновить статус AI Factory' }));
    await slot.findByText('metadata unavailable');
    assert.ok(slot.queryByRole('button', { name: 'Улучшить план' }) === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});
test('the updates shortcut opens version controls and dispatch requires an explicit update click', async () => {
  const s = snapshot({ target: null, candidates: [] }); s.actions = workflowActions(s);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: (v: any) => { assert.equal(v.actionId, 'update-factory'); runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    const updates = await slot.findByRole('button', { name: 'Версии и обновления' });
    const details = document.getElementById(updates.getAttribute('aria-controls')!) as HTMLDetailsElement;
    assert.equal(details.open, false);
    fireEvent.click(updates);
    const update = await slot.findByRole('button', { name: 'Обновить AI Factory' });
    await waitFor(() => assert.equal(updates.getAttribute('aria-expanded'), 'true'));
    await slot.findByRole('button', { name: 'Запустить aif' }); assert.equal(runs, 0);
    fireEvent.click(update); await waitFor(() => assert.equal(runs, 1));
  } finally { slot.lifecycle.unmount(); }
});
test('AIFHub context button is analyze and obeys busy-state disabling', async () => {
  const s = snapshot({ skills: ['aif-analyze'], threadState: 'active', extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', state: 'present', source: 'local', contributions: [] }] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try { assert.equal((await slot.findByRole('button', { name: 'Запустить aif-analyze' }) as HTMLButtonElement).disabled, true); }
  finally { slot.lifecycle.unmount(); }
});

function suggestedData() { return { sourceKey: 'c'.repeat(64), fingerprint: 'a'.repeat(64), threadState: 'idle', items: ['aif-architecture', 'aif-roadmap'].map(id => ({ id, command: `$${id}`, available: true, reason: 'Из последнего ответа' })) }; }
const banner = app.composerCustomizations.find(c => c.id === 'suggested-commands')!.banners![0];

test('apply-all can answer an improve confirmation while ordinary navigation stays disabled and draft remains intact', async () => {
  let dismissed = false; let sends = 0;
  const proposal = { id: 'apply-improvements', label: 'Применить всё', kind: 'improve-approval', command: 'Применить предложенные улучшения плана demo.', available: true, reason: 'Только предложенный diff' };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Мой черновик' }, rpc: {
    suggestions: () => ({ ...suggestedData(), threadState: 'awaiting_input', items: [...(dismissed ? [] : [proposal]), suggestedData().items[0]] }),
    runSuggestion: (input: any) => { assert.equal(input.commandId, 'apply-improvements'); sends++; dismissed = true; return { sent: true, message: 'Подтверждение отправлено' }; },
  } });
  try {
    const apply = await slot.findByRole('button', { name: 'Применить всё' });
    assert.equal((apply as HTMLButtonElement).disabled, false);
    assert.equal((slot.getByRole('button', { name: '$aif-architecture' }) as HTMLButtonElement).disabled, true);
    assert.equal(sends, 0); fireEvent.click(apply); fireEvent.click(apply);
    await waitFor(() => assert.equal(sends, 1));
    await waitFor(() => assert.ok(slot.queryByRole('button', { name: 'Применить всё' }) === null, 'element should be absent'));
    assert.equal(slot.inspection.composer.text, 'Мой черновик');
  } finally { slot.lifecycle.unmount(); }
});

test('PASS with a null command renders without an error and labels its reason as explanation', async () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'pass', blocking: false, blockers: [], affected_files: [],
    suggested_next: { command: null, reason: 'No explicit rule violations or rule updates required.' } };
  const fence = renderSlot(app.codeFenceRenderers[0], { code: JSON.stringify(gate), language: 'aif-gate-result', status: 'closed', index: 0, message: props.message, Original: () => JSON.stringify(gate) });
  try { fence.getByText('Данные gate · rules · PASS'); assert.ok(fence.queryByRole('alert') === null, 'element should be absent'); }
  finally { fence.lifecycle.unmount(); }
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } },
    rpc: { suggestions: () => ({ ...suggestedData(), items: [], gateError: null, gate }) } });
  try {
    await slot.findByText('rules · PASS в ответе'); slot.getByText('Пояснение:');
    assert.ok(slot.queryByText('Следующий шаг:') === null, 'element should be absent'); assert.ok(slot.queryByRole('alert') === null, 'element should be absent');
    assert.ok(slot.queryByText('Из ответа агента') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});
test('composer suggestions have a separate dismiss control and never dispatch during discovery or removal', async () => {
  assert.deepEqual(app.composerCustomizations.find(c => c.id === 'suggested-commands')!.scopes, ['thread']);
  let current = suggestedData(); let sends = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Мой черновик' }, rpc: {
    suggestions: () => current,
    dismissSuggestion: (input: any) => { current = { ...current, items: current.items.filter(i => i.id !== input.commandId) }; return { dismissed: true }; },
    runSuggestion: () => { sends++; return { sent: false, stale: true, message: 'Не должно вызываться' }; },
  } });
  try {
    await slot.findByRole('button', { name: '$aif-architecture + ваш текст из поля' });
    await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' });
    fireEvent.click(slot.getByRole('button', { name: 'Удалить предложение $aif-architecture' }));
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-architecture + ваш текст из поля' })));
    assert(slot.getByRole('button', { name: '$aif-roadmap + ваш текст из поля' })); assert.equal(sends, 0);
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.ok(slot.queryByRole('button', { name: '$aif-architecture + ваш текст из поля' }) === null, 'element should be absent');
    assert.equal(slot.inspection.composer.text, 'Мой черновик');
  } finally { slot.lifecycle.unmount(); }
});
test('suggested command submits the composer draft once and a double click cannot send twice', async () => {
  let calls = 0; let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Keep draft' }, rpc: {
    suggestions: () => suggestedData(),
    runSuggestion: (input: any) => { assert.equal(input.commandId, 'aif-roadmap'); assert.equal(input.threadId, 'thr_test'); calls++;
      return { sent: false, message: 'Команда подставлена в поле ввода.', command: '$aif-roadmap',
        data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-roadmap', fingerprint: 'a'.repeat(64), gate: null } }; },
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' }); assert.equal(calls, 0);
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => assert.equal(calls, 1));
    await waitFor(() => assert.equal(slot.inspection.composer.submits.length, 1));
    const submit = slot.inspection.composer.submits[0];
    assert.equal(submit.experimental_mode, 'queue-if-active');
    assert.equal((submit.experimental_data as any).source, 'aif-chat');
    assert.equal((submit.experimental_data as any).commandId, 'aif-roadmap');
    await waitFor(() => assert.equal(dismissals, 1));
    assert.equal(slot.inspection.composer.text, '');
  } finally { slot.lifecycle.unmount(); }
});
test('empty composer plus a topic chip fills the draft and focuses without submitting', async () => {
  let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), items: [{ id: 'aif-plan', command: '/aif-plan', available: true, reason: 'Из последнего ответа' }] }),
    runSuggestion: () => ({ sent: false, message: 'Команда подставлена в поле ввода.', command: '/aif-plan',
      data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-plan', fingerprint: 'a'.repeat(64), gate: null } }),
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '/aif-plan' });
    const focusBefore = slot.inspection.composer.focusCount;
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.inspection.composer.text, '/aif-plan '));
    await waitFor(() => assert.equal(dismissals, 1));
    assert.equal(slot.inspection.composer.focusCount, focusBefore + 1);
    assert.equal(slot.inspection.composer.submits.length, 0);
    await slot.findByText('Команда подставлена в поле ввода.');
  } finally { slot.lifecycle.unmount(); }
});
test('composer with text plus a chip submits the command with the draft as the topic', async () => {
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'добавь логин' }, rpc: {
    suggestions: () => ({ ...suggestedData(), items: [{ id: 'aif-verify', command: '/aif-verify', available: true, reason: 'Из последнего ответа' }] }),
    runSuggestion: () => ({ sent: false, message: 'Отправлено', command: '/aif-verify',
      data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-verify', fingerprint: 'a'.repeat(64), gate: null } }),
    dismissSuggestion: () => ({ dismissed: true }),
  } });
  try {
    const button = await slot.findByRole('button', { name: '/aif-verify + ваш текст из поля' });
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.inspection.composer.submits.length, 1));
    const submit = slot.inspection.composer.submits[0];
    assert.equal(submit.experimental_mode, 'queue-if-active');
    assert.equal((submit.experimental_data as any).source, 'aif-chat');
    assert.equal((submit.experimental_data as any).commandId, 'aif-verify');
    assert.equal(slot.inspection.composer.text, '');
  } finally { slot.lifecycle.unmount(); }
});
test('stale chip result shows a notice without touching the composer or dismissing', async () => {
  let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Keep draft' }, rpc: {
    suggestions: () => suggestedData(),
    runSuggestion: () => ({ sent: false, stale: true, message: 'Карточка обновилась. Проверьте задачу и нажмите ещё раз.' }),
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' });
    fireEvent.click(button);
    await slot.findByText('Карточка обновилась. Проверьте задачу и нажмите ещё раз.');
    assert.equal(slot.inspection.composer.text, 'Keep draft');
    assert.equal(slot.inspection.composer.submits.length, 0);
    assert.equal(slot.inspection.composer.focusCount, 0);
    assert.equal(dismissals, 0);
  } finally { slot.lifecycle.unmount(); }
});
test('busy composer disables command launch but allows removing a suggestion', async () => {
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, isRunning: true }, rpc: { suggestions: () => suggestedData() } });
  try {
    assert.equal((await slot.findByRole('button', { name: '$aif-roadmap' }) as HTMLButtonElement).disabled, true);
    assert.equal((slot.getByRole('button', { name: 'Удалить предложение $aif-roadmap' }) as HTMLButtonElement).disabled, false);
  } finally { slot.lifecycle.unmount(); }
});
test('suggestion banner follows composer scope and rejects an old thread response arriving late', async () => {
  let finishOld!: (value: ReturnType<typeof suggestedData>) => void;
  const old = new Promise<ReturnType<typeof suggestedData>>(resolve => { finishOld = resolve; });
  const fresh = { ...suggestedData(), items: [{ id: 'aif-plan', command: '$aif-plan', available: true, reason: 'New thread' }] };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_old' } }, rpc: { suggestions: (input: any) => input.threadId === 'thr_old' ? old : fresh } });
  try {
    await slot.behavior.setComposerScope({ kind: 'thread', threadId: 'thr_new' });
    await slot.findByRole('button', { name: '$aif-plan' });
    finishOld(suggestedData());
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-roadmap' })));
    await slot.behavior.setComposerScope({ kind: 'new-thread', projectId: 'proj_test' });
    assert.ok(slot.queryByRole('button', { name: '$aif-plan' }) === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('string blocker gates render valid collapsed JSON and show both blocking findings above the composer', async () => {
  const code = JSON.stringify({ schema_version: 1, gate: 'review', status: 'fail', blocking: true,
    blockers: ['R1: Worker drops read_only restrictions.', 'R2: Deleted review target is accepted.'],
    affected_files: ['worker/src/api/OrkoraApiClient.ts'], suggested_next: { command: '$aif-fix', reason: 'Fix R1 and R2.' } });
  const renderer = app.codeFenceRenderers.find(item => item.id === 'gate-data')!;
  const document = renderSlot(renderer, { code, language: 'aif-gate-result', status: 'closed', index: 0, message: props.message, Original: () => code });
  try {
    assert(document.getByText('Данные gate · review · FAIL'));
    assert.ok(document.queryByRole('alert') === null, 'element should be absent');
  } finally { document.lifecycle.unmount(); }
  const parsed = parseReplyGate('```aif-gate-result\n' + code + '\n```');
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), gate: parsed.gate, gateError: parsed.error,
      items: [{ id: 'aif-fix', command: '$aif-fix', available: true, reason: 'Fix R1 and R2.' }] }),
  } });
  try {
    await slot.findByText('review · FAIL в ответе');
    assert(slot.getByText('Worker drops read_only restrictions.')); assert(slot.getByText('Deleted review target is accepted.'));
    assert(slot.getByText('Блокирующие проблемы · 2')); assert(slot.getByText('Блокирует следующий этап'));
    assert.equal((slot.getByRole('button', { name: '$aif-fix' }) as HTMLButtonElement).disabled, false);
    assert.ok(slot.queryByRole('alert') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('disabled suggestions show the missing skill visibly on mobile while sync remains clickable', async () => {
  const reason = 'Команда aif-commit не установлена для codex. Добавьте этот skill в установку AI Factory проекта.';
  let sends = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), items: [
      { id: 'aif-mode', command: '$aif-mode sync', available: true, reason: 'Из ответа агента' },
      { id: 'aif-commit', command: '$aif-commit', available: false, reason },
    ] }),
    runSuggestion: (input: any) => { assert.equal(input.commandId, 'aif-mode'); sends++; return { sent: true, message: 'Отправлено' }; },
  } });
  try {
    const sync = await slot.findByRole('button', { name: '$aif-mode sync' });
    assert.equal((sync as HTMLButtonElement).disabled, false);
    assert.equal((slot.getByRole('button', { name: '$aif-commit' }) as HTMLButtonElement).disabled, true);
    assert.equal(slot.getByRole('note').textContent, reason); assert.equal(sends, 0);
    fireEvent.click(sync); await waitFor(() => assert.equal(sends, 1));
  } finally { slot.lifecycle.unmount(); }
});

test('a valid FAIL with trailing summary shows a format note, both blockers and fix without an invalid-gate alert', async () => {
  const gate = { schema_version: 1, gate: 'review', status: 'fail', blocking: true,
    blockers: [{ id: 'windows-project-path-prefix', severity: 'error', summary: 'Windows paths do not match.' },
      { id: 'worker-failure-aborts-run-burns-attempts', severity: 'error', summary: 'Sibling attempts are consumed.' }],
    affected_files: ['src/core/swarm/runtime.ts'], suggested_next: { command: '$aif-fix', reason: 'Fix findings.' } };
  const parsed = parseReplyGate('```aif-gate-result\n' + JSON.stringify(gate) + '\n```\nИтог: обе находки блокирующие.');
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), gate: parsed.gate, gateError: parsed.error, gateWarning: parsed.warning,
      items: [{ id: 'aif-fix', command: '$aif-fix', available: true, reason: 'Fix findings.' }] }),
  } });
  try {
    await slot.findByText('review · FAIL в ответе');
    assert(slot.getByText('Windows paths do not match.')); assert(slot.getByText('Sibling attempts are consumed.'));
    assert.match(slot.getByRole('note').textContent!, /^Формат ответа: После gate/);
    assert.ok(slot.queryByRole('alert') === null, 'element should be absent');
    assert.equal((slot.getByRole('button', { name: '$aif-fix' }) as HTMLButtonElement).disabled, false);
  } finally { slot.lifecycle.unmount(); }
  const pass = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), gate: { ...gate, status: 'pass', blocking: false, blockers: [], suggested_next: null },
      gateError: null, gateWarning: parsed.warning, items: [] }),
  } });
  try { await pass.findByText('Переход не подтверждён'); assert.ok(pass.queryByText('Не блокирует') === null, 'element should be absent'); }
  finally { pass.lifecycle.unmount(); }
});

test('gate problems remain visible even with no suggested command', async () => {
  const data = { ...suggestedData(), items: [], gateError: null, gate: { schema_version: 1, gate: 'verify', status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', file: 'src/demo.ts', summary: 'Required behavior is missing.' }], affected_files: ['src/demo.ts'], suggested_next: null } };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: { suggestions: () => data } });
  try {
    await slot.findByText('verify · FAIL в ответе');
    await slot.findByText('Required behavior is missing.');
    assert(slot.getByText('Блокирует следующий этап')); assert(slot.getByText('Блокирующие проблемы · 1'));
    assert.ok(slot.queryByText('Из ответа агента') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});
test('non-blocking gate reason and command render independently; dismiss does not hide the report', async () => {
  let data = { ...suggestedData(), items: [{ id: 'aif-commit', command: '$aif-commit', available: true, reason: 'Only non-blocking warnings remain.' }], gateError: null, gate: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: ['src/demo.ts'], suggested_next: { command: '/aif-commit', reason: 'Only non-blocking warnings remain.' } } };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => data, dismissSuggestion: () => { data = { ...data, items: [] }; return { dismissed: true }; },
  } });
  try {
    await slot.findByText('verify · WARN в ответе');
    assert(slot.getByText(/Only non-blocking warnings remain/));
    fireEvent.click(slot.getByRole('button', { name: 'Удалить предложение $aif-commit' }));
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-commit' })));
    assert(slot.getByText('verify · WARN в ответе')); assert(slot.getByText('Блокирующих проблем нет.'));
  } finally { slot.lifecycle.unmount(); }
});

test('readiness block in the tab: one run button on the first todo step, skip RPC, collapsed when ready, absent from chat cards', async () => {
  const { applyRan, readinessSteps } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  let runs: string[] = []; const skips: unknown[] = [];
  const rpc = { status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; },
    setReadinessSkip: (input: any) => { skips.push(input); return { ok: true }; } };
  let slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc });
  try {
    await slot.findByText('Подготовка проекта', { selector: '*' });
    await slot.findByText('Выполнено · 1', { exact: false });
    const run = await slot.findByRole('button', { name: /^Запустить: Описать проект/ });
    assert.equal(slot.getAllByRole('button', { name: /^Запустить: / }).length, s.readiness.filter(step => step.state === 'todo').length, 'every unfinished step can be run');
    await slot.findByRole('button', { name: 'Запустить: Настроить CI' });
    assert.ok(slot.queryByText('Настройка контекста проекта') === null, 'element should be absent');
    assert.ok(slot.queryByText('Дополнительно') === null, 'element should be absent');
    assert.equal(slot.queryByText(/^Не найдено:/), null, 'missing files stay behind «?» to keep rows one line high');
    fireEvent.click(await slot.findByRole('button', { name: 'Что делает шаг «Описать проект (/aif или aif-analyze)»' }));
    await slot.findByText('Не найдено: .ai-factory/DESCRIPTION.md, .ai-factory/config.yaml, .ai-factory/rules/base.md, AGENTS.md');
    assert.equal(slot.queryByText(/^любой из:/), null, "any-of file lists live behind «?» to keep phone rows short");
    fireEvent.click(run);
    await waitFor(() => assert.deepEqual(runs, ['setup-context']));
    fireEvent.click(slot.getByRole('button', { name: 'Пропустить: Настроить CI' }));
    await waitFor(() => assert.deepEqual(skips, [{ threadId: 'thr_panel', stepId: 'ci', skipped: true }]));
  } finally { slot.lifecycle.unmount(); }
  const files = Object.fromEntries(['.ai-factory/DESCRIPTION.md', '.ai-factory/config.yaml', '.ai-factory/rules/base.md', 'AGENTS.md', '.ai-factory/ARCHITECTURE.md', 'lefthook.yml', 'Jenkinsfile', 'docs/index.md', '.ai-factory/RULES.md', 'Makefile', 'Dockerfile'].map(f => [f, true]));
  s.readiness = applyRan(readinessSteps({ configured: true, contextSkill: true, files, paths: {} }), ['docs']);
  slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByText('Проект готов к работе через AI Factory');
    assert.ok(slot.queryByText('Выполните шаги по порядку, чтобы AI Factory работал полностью') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
  const card = renderSlot(app.messageDirectives[0] as any, props as any, { rpc });
  try {
    await card.findByRole('button', { name: 'Улучшить план' });
    assert.ok(card.queryByText('Подготовка проекта') === null, 'element should be absent');
    assert.ok(card.queryByText('Проект готов к работе через AI Factory') === null, 'element should be absent');
  } finally { card.lifecycle.unmount(); }
});

test('each check row has a «?» button that toggles a plain explanation without launching the check', async () => {
  const { checkHelp } = await import('../check-actions.ts');
  const s = data();
  s.checks = [{ id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Отчёт проверки не найден', path: null, required: false }];
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    fireEvent.click(await slot.findByText('Что проверить'));
    const button = slot.getByRole('button', { name: 'Подробнее: Соответствие плану' });
    const explanation = document.getElementById(button.getAttribute('aria-controls')!)!;
    assert.equal(explanation.hidden, true);
    fireEvent.click(button);
    assert.equal(explanation.textContent, checkHelp.verify);
    assert.equal(explanation.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    fireEvent.click(button);
    assert.equal(explanation.hidden, true);
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('each readiness step has a «?» button that explains the step without running it', async () => {
  const { readinessSteps, readinessHelp } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  let runs = 0;
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    for (const step of s.readiness) assert.ok(readinessHelp[step.id], `help for ${step.id}`);
    const button = await slot.findByRole('button', { name: 'Что делает шаг «Настроить CI»' });
    assert.ok(slot.queryByText(readinessHelp.ci) === null, 'element should be absent');
    fireEvent.click(button);
    await slot.findByText(readinessHelp.ci);
    fireEvent.click(button);
    await waitFor(() => assert.ok(slot.queryByText(readinessHelp.ci) === null, 'element should be absent'));
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('«Другие команды» in the tab offers roadmap and archive with a «?» each', async () => {
  const { toolHelp } = await import('../check-actions.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.skills = [...s.skills, 'aif-docs', 'aif-roadmap', 'aif-rules', 'aif-build-automation', 'aif-dockerize', 'aif-archive'];
  s.actions = workflowActions(s);
  const tools = s.actions.filter(a => toolHelp[a.id]);
  assert.deepEqual(tools.map(a => a.id), Object.keys(toolHelp));
  assert.ok(tools.every(a => a.available && a.group === 'setup'));
  assert.match(tools.find(a => a.id === 'roadmap-setup')!.command, /^[/$]aif-roadmap$/);
  const runs: string[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: { status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; } } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    fireEvent.click(await slot.findByText('Другие команды', { selector: '*' }));
    const help = await slot.findByRole('button', { name: 'Что делает «Roadmap»' });
    fireEvent.click(help);
    await slot.findByText(toolHelp['roadmap-setup']);
    assert.deepEqual(runs, []);
    fireEvent.click(await slot.findByRole('button', { name: 'Roadmap' }));
    await waitFor(() => assert.deepEqual(runs, ['roadmap-setup']));
  } finally { slot.lifecycle.unmount(); }
});

function delegView(patch: { children?: any[]; defaults?: any; appliedDefaults?: string | null } = {}) {
  return { choice: { mode: 'self' }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' },
    configured: true, foreign: null, error: null, providers: [{ id: 'codex', name: 'Codex' }],
    children: [], defaults: null, appliedDefaults: null, ...patch };
}

test('the panel tab splits navigation and settings between current work and one-time configuration', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const slot = renderSlot(tab as any, { threadId: 'thr_split', environment: { id: 'env_split' } }, { rpc: { status: () => s, delegation: () => delegView() } });
  try {
    slot.getByRole('tablist', { name: 'Раздел панели' });
    await slot.findByText('Сейчас');
    assert.ok(slot.queryByText('Исполнители') === null, 'element should be absent');
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    await slot.findByText('Модели по умолчанию для новых проектов');
    slot.getByText(/Версии и расширения/);
    assert.ok(slot.queryByText('Сейчас') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('a message card has no navigation/settings switcher', async () => {
  const s = data();
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByText('Сейчас');
    assert.ok(slot.queryByRole('tablist') === null, 'element should be absent');
    assert.ok(slot.queryByRole('tab') === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('«В работе» lists child threads on navigation and hides when there are none', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const child = { id: 'thr_child', title: 'Задача 1', status: 'active', providerId: 'codex', updatedAt: '2026-11-17T00:00:00Z', worktree: false, execution: null, fallback: null, mismatch: null };
  const busy = renderSlot(tab as any, { threadId: 'thr_working', environment: { id: 'env_working' } }, { rpc: { status: () => s, delegation: () => delegView({ children: [child] }) } });
  try {
    await busy.findByText('Задача 1');
    busy.getByText('В работе');
  } finally { busy.lifecycle.unmount(); }
  const idle = renderSlot(tab as any, { threadId: 'thr_idle', environment: { id: 'env_idle' } }, { rpc: { status: () => s, delegation: () => delegView({ children: [] }) } });
  try {
    await idle.findByRole('tab', { name: /Навигация/ });
    await waitFor(() => assert(idle.inspection.rpcCalls.some(c => c.method === 'delegation')));
    assert.ok(idle.queryByText('В работе') === null, 'element should be absent');
    assert.ok(idle.queryByText('Задача 1') === null, 'element should be absent');
  } finally { idle.lifecycle.unmount(); }
});

test('defaults block disables apply without defaults and takes roles from this project', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const calls: any[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_defaults', environment: { id: 'env_defaults' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    setDelegationDefaults: (input: any) => { calls.push(input); return delegView(); },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    fireEvent.click(await slot.findByText('Модели по умолчанию для новых проектов'));
    assert.equal((await slot.findByRole('button', { name: 'Применить к этому проекту' }) as HTMLButtonElement).disabled, true);
    fireEvent.click(slot.getByRole('button', { name: 'Взять из этого проекта' }));
    await waitFor(() => assert.deepEqual(calls, [{ threadId: 'thr_defaults', action: 'from-project' }]));
  } finally { slot.lifecycle.unmount(); }
});

test('auto-applied defaults appear as a status callout inside settings', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const applied = 'Применены модели по умолчанию: Код — devin/swe-2-flash';
  const slot = renderSlot(tab as any, { threadId: 'thr_applied', environment: { id: 'env_applied' } }, { rpc: {
    status: () => s, delegation: () => delegView({ appliedDefaults: applied }),
  } });
  try {
    await slot.findByText('Сейчас');
    assert.ok(slot.queryByText(/Применены модели по умолчанию/) === null, 'element should be absent');
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    const found = await slot.findAllByText(applied);
    assert(found.some(el => el.closest('[role="status"]')));
  } finally { slot.lifecycle.unmount(); }
});

function scoringView(patch: Record<string, unknown> = {}) {
  return { enabled: false, source: 'catalog', catalogName: null, catalogAvailable: true, connection: null,
    catalogNames: ['GEMINI_API_KEY_AISTUDIO'], manualKeySet: false, lastError: null, lastScoredAt: null, ...patch };
}

test('readiness rows show «Пропустить» and «Запустить» as buttons right in the row', async () => {
  const { readinessSteps } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  const runs: string[] = []; const skips: unknown[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_expand', environment: { id: 'env_expand' } }, { rpc: {
    status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; },
    setReadinessSkip: (input: any) => { skips.push(input); return { ok: true }; },
  } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Подготовить' }));
    await slot.findByText('Подготовка проекта', { selector: 'h3' });
    const skip = await slot.findByRole('button', { name: 'Пропустить: Настроить CI' });
    assert.equal(skip.textContent, 'Пропустить');
    assert.equal(slot.queryByRole('button', { name: /^Пропустить: Описать проект/ }), null, 'core steps cannot be skipped');
    fireEvent.click(skip);
    await waitFor(() => assert.deepEqual(skips, [{ threadId: 'thr_expand', stepId: 'ci', skipped: true }]));
    assert.equal(runs.length, 0);
    const run = slot.getByRole('button', { name: 'Запустить: Настроить CI' });
    assert.equal(run.textContent, 'Запустить');
    fireEvent.click(run);
    await waitFor(() => assert.deepEqual(runs, ['ci-setup']));
  } finally { slot.lifecycle.unmount(); }
});

test('an executor row is a single button that toggles aria-expanded and reveals the model picker', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const view = { ...delegView(), choice: { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' } };
  const slot = renderSlot(tab as any, { threadId: 'thr_roles', environment: { id: 'env_roles' } }, { rpc: { status: () => s, delegation: () => view } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    const row = await slot.findByRole('button', { name: 'Изменить: Код' });
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.match(row.parentElement!.textContent!, /Код/);
    assert.match(row.parentElement!.textContent!, /Codex · gpt-6\.2-sol · high/);
    fireEvent.click(row);
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    await slot.findByRole('radiogroup', { name: 'Кто пишет код' });
    await slot.findByTestId('bb-provider-model-picker');
    fireEvent.click(row);
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    await waitFor(() => assert.ok(slot.queryByRole('radiogroup') === null, 'element should be absent'));
  } finally { slot.lifecycle.unmount(); }
});

test('scored chips sort by probability with percent badges; the top chip is highlighted and unscored ones have no badge', async () => {
  const items = [
    { id: 'aif-commit', command: '/aif-commit', available: true, reason: 'Ответ', probability: null },
    { id: 'aif-plan', command: '/aif-plan full #1', available: true, reason: 'Ответ', probability: 0.03 },
    { id: 'aif-verify', command: '/aif-verify @plan.md', available: true, reason: 'Ответ', probability: 0.96 },
    { id: 'aif-fix', command: '/aif-fix refresh x so y', available: true, reason: 'Ответ', probability: 0.004 },
  ];
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: { suggestions: () => ({ ...suggestedData(), items }) } });
  try {
    await slot.findByRole('button', { name: '96% /aif-verify @plan.md' });
    const chips = [...slot.container.querySelectorAll('.aif-suggestion')];
    assert.equal(chips.length, 4);
    assert(chips[0].classList.contains('aif-suggestion-top'));
    assert(!chips[1].classList.contains('aif-suggestion-top'));
    assert(!chips[2].classList.contains('aif-suggestion-top'));
    assert(!chips[3].classList.contains('aif-suggestion-top'));
    assert.deepEqual([...slot.container.querySelectorAll('.aif-suggestion-score')].map(el => el.textContent), ['96%', '3%', '<1%']);
    assert.match(chips[0].textContent!, /\/aif-verify/);
    assert.match(chips[1].textContent!, /\/aif-plan/);
    assert.match(chips[2].textContent!, /\/aif-fix/);
    assert.match(chips[3].textContent!, /\/aif-commit/);
    assert.equal(chips[3].querySelector('.aif-suggestion-score'), null);
    assert.ok(slot.getByRole('button', { name: '/aif-commit' }));
  } finally { slot.lifecycle.unmount(); }
});

test('«Оценка кнопок» toggles scoring, hides the catalog without env-catalog and clears the manual key input', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const saved: any[] = [];
  let view = scoringView({ catalogAvailable: false, source: 'manual', catalogNames: [] });
  const slot = renderSlot(tab as any, { threadId: 'thr_score1', environment: { id: 'env_score1' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    chipScoring: () => view,
    setChipScoring: (input: any) => {
      saved.push(input);
      view = { ...view, ...input,
        manualKeySet: input.manualKey === null ? false : input.manualKey ? true : view.manualKeySet,
        lastError: input.manualKey ? 'Gemini ответил HTTP 403' : view.lastError };
      return view;
    },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('heading', { name: 'Оценка кнопок' });
    fireEvent.click(await slot.findByRole('button', { name: 'Выкл' }));
    await waitFor(() => assert.deepEqual(saved, [{ enabled: true }]));
    const toggle = await slot.findByRole('button', { name: 'Вкл' });
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    await slot.findByLabelText('Ключ Gemini API');
    assert.ok(slot.queryByRole('radiogroup', { name: 'Источник ключа' }) === null, 'element should be absent');
    fireEvent.change(slot.getByLabelText('Ключ Gemini API'), { target: { value: 'decisions-test-key' } });
    fireEvent.click(slot.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.deepEqual(saved[1], { manualKey: 'decisions-test-key' }));
    await waitFor(() => assert.equal((slot.getByLabelText('Ключ Gemini API') as HTMLInputElement).value, ''));
    await slot.findByText('Ключ задан');
    await slot.findByText('Gemini ответил HTTP 403');
    fireEvent.click(slot.getByRole('button', { name: 'Удалить ключ' }));
    await waitFor(() => assert.deepEqual(saved[2], { manualKey: null }));
  } finally { slot.lifecycle.unmount(); }
});

test('custom scoring can be configured from off with a full URL, model and secret in one save', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const connection = { endpoint: 'https://gateway.example/v1/systemone', model: 'some/model:free' };
  const saved: any[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_custom_score', environment: { id: 'env_score' } }, { rpc: {
    status: () => data(), delegation: () => delegView(), chipScoring: () => scoringView(),
    setChipScoring: (input: any) => { saved.push(input); return scoringView({ enabled: true, connection, manualKeySet: true }); },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    fireEvent.click(await slot.findByRole('button', { name: 'Свой API (System One)' }));
    fireEvent.change(slot.getByLabelText('Полный URL System One'), { target: { value: connection.endpoint } });
    fireEvent.change(slot.getByLabelText('ID модели'), { target: { value: connection.model } });
    fireEvent.change(slot.getByLabelText('Ключ API System One'), { target: { value: 'test-key' } });
    fireEvent.click(slot.getByRole('button', { name: 'Сохранить и включить' }));
    await waitFor(() => assert.deepEqual(saved, [{ enabled: true, connection, customKey: 'test-key' }]));
    fireEvent.click(await slot.findByRole('button', { name: 'Изменить подключение' }));
    assert.equal((slot.getByLabelText('Полный URL System One') as HTMLInputElement).value, connection.endpoint);
    assert.equal((slot.getByLabelText('Ключ API System One') as HTMLInputElement).value, '');
  } finally { slot.lifecycle.unmount(); }
});

test('«Оценка кнопок» with env-catalog offers the key source radio and the name select', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const saved: any[] = [];
  let view = scoringView({ enabled: true, source: 'catalog', catalogName: 'GEMINI_API_KEY_AISTUDIO', catalogNames: ['GEMINI_API_KEY_AISTUDIO', 'OTHER_KEY'] });
  const slot = renderSlot(tab as any, { threadId: 'thr_score2', environment: { id: 'env_score2' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    chipScoring: () => view,
    setChipScoring: (input: any) => { saved.push(input); view = { ...view, ...input }; return view; },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    const group = await slot.findByRole('radiogroup', { name: 'Источник ключа' });
    assert.equal(within(group).getByRole('radio', { name: 'Из Env Catalog' }).getAttribute('aria-checked'), 'true');
    assert.equal((slot.getByLabelText('Ключ из Env Catalog') as HTMLSelectElement).value, 'GEMINI_API_KEY_AISTUDIO');
    fireEvent.change(slot.getByLabelText('Ключ из Env Catalog'), { target: { value: 'OTHER_KEY' } });
    await waitFor(() => assert.deepEqual(saved.at(-1), { catalogName: 'OTHER_KEY' }));
    fireEvent.click(within(group).getByRole('radio', { name: 'Ввести вручную' }));
    await waitFor(() => assert.deepEqual(saved.at(-1), { source: 'manual' }));
    await slot.findByLabelText('Ключ Gemini API');
  } finally { slot.lifecycle.unmount(); }
});

test('the message card keeps bordered sections while the panel groups sections without borders', async () => {
  const s = data();
  const card = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await card.findByText('Сейчас');
    const cardSection = card.container.querySelector('section[aria-label="Текущий этап"]') as HTMLElement;
    assert(cardSection?.classList.contains('border'));
    assert(cardSection.classList.contains('rounded-lg'));
  } finally { card.lifecycle.unmount(); }
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const panel = renderSlot(tab as any, { threadId: 'thr_surface', environment: { id: 'env_surface' } }, { rpc: { status: () => s, delegation: () => delegView() } });
  try {
    await panel.findByText('Сейчас');
    const panelSection = panel.container.querySelector('section[aria-label="Текущий этап"]') as HTMLElement;
    assert(panelSection && !panelSection.classList.contains('border'));
    const panelBlock = [...panelSection.children].find(el => el.classList.contains('rounded-xl')) as HTMLElement;
    assert(panelBlock?.classList.contains('bg-card'));
    assert(!panelBlock.classList.contains('border'));
  } finally { panel.lifecycle.unmount(); }
});
