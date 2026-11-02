import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
const { fireEvent, waitFor } = await import('@testing-library/react');
const app = await loadPluginApp(() => import('../app.tsx'));
const props = { attributes: { phase: 'plan' }, source: '::aif-chat{phase="plan"}', message: { id: 'msg_1', threadId: 'thr_test', turnId: 'turn_1', projectId: 'proj_test' }, openWorkspaceFile: null };
function data() { const s = snapshot(); s.actions = workflowActions(s); return s; }

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
  const tab = app.tabs.find((t): t is Extract<(typeof app.tabs)[number], { availability: 'fixed'; context: { kind: 'thread' } }> => t.id === 'workflow' && t.availability === 'fixed' && t.context.kind === 'thread')!;
  const slot = renderSlot(tab, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, {
    rpc: { status: (input: any) => { readThreads.push(input.threadId); return data(); }, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } },
  });
  try {
    await slot.findByRole('button', { name: 'Обновить AI Factory' });
    await slot.findByRole('button', { name: 'Запустить aif' });
    assert.deepEqual(readThreads, ['thr_panel']); assert.equal(runs, 0);
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
test('busy thread shows waiting state and disables action buttons', async () => {
  const s = data(); s.threadState = 'awaiting_input'; s.pendingQuestions = 2;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByText(/ожидаю ответы: 2/);
    assert.equal((slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement).disabled, true);
  } finally { slot.lifecycle.unmount(); }
});
test('metadata failure removes stale actions instead of keeping executable old snapshot', async () => {
  let fails = false;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => { if (fails) throw new Error('metadata unavailable'); return data(); } } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' }); fails = true;
    fireEvent.click(slot.getByRole('button', { name: 'Обновить статус AI Factory' }));
    await slot.findByText('metadata unavailable');
    assert.equal(slot.queryByRole('button', { name: 'Улучшить план' }), null);
  } finally { slot.lifecycle.unmount(); }
});
test('maintenance buttons are visible before plan selection and update dispatch is click-only', async () => {
  const s = snapshot({ target: null, candidates: [] }); s.actions = workflowActions(s);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: (v: any) => { assert.equal(v.actionId, 'update-factory'); runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    const update = await slot.findByRole('button', { name: 'Обновить AI Factory' });
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
