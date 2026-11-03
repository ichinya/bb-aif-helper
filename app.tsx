import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useComposer, type PluginMessageDirectiveProps, type ExperimentalThreadContextCardProps, type ExperimentalThreadTabProps, type ExperimentalCodeFenceRendererProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import { phaseSchema, type Snapshot, type Phase, type Action, type Suggestions } from './model.ts';
import { parseReplyGate } from './gate.ts';
import { rowActions } from './check-actions.ts';
import { updateInVersionDetails, VERSION_TTL } from './versions.ts';
import { contextSetupInDetails } from './workflow.ts';
import './aif-chat.css';

const phaseNames: Record<Phase, string> = { unknown: 'Контекст задачи', explore: 'Исследование', plan: 'Планирование', improve: 'Уточнение плана', implement: 'Выполнение плана', verify: 'Проверка', fix: 'Исправление замечаний', done: 'Финализация' };
const profileNames: Record<Snapshot['profile'], string> = { none: 'Нет установки', upstream: 'AI Factory', 'aifhub-classic': 'AIFHub · classic', 'aifhub-openspec': 'AIFHub · OpenSpec', 'aifhub-ultra': 'AIFHub · legacy ultra', invalid: 'Проверьте конфигурацию' };
const checkLabels = { notrun: 'Нет evidence', 'reported-pass': 'PASS в отчёте', warn: 'С замечаниями', fail: 'Ошибка', unknown: 'Не подтверждено' };

function GateData({ code, status, Original }: ExperimentalCodeFenceRendererProps) {
  const parsed = status === 'closed' ? parseReplyGate(`\`\`\`aif-gate-result\n${code}\n\`\`\``) : null;
  const error = status === 'unclosed' ? 'Блок aif-gate-result не закрыт; результат не подтверждён.' : parsed?.error;
  const gate = parsed && !error ? parsed.gate : null;
  return <div className="aif-gate-data">
    {error && <p className="aif-error" role="alert">Некорректный gate: {error}</p>}
    <details><summary>Данные gate{gate ? ` · ${gate.gate} · ${gate.status.toUpperCase()}` : status === 'streaming' ? ' · формируются…' : ' · проверить JSON'}</summary>
      <Original />
    </details>
  </div>;
}

function WorkflowCard({ threadId, initialTarget = '', phase = 'unknown', openFile, compact = false }: {
  threadId: string; initialTarget?: string; phase?: Phase; openFile?: ((path: string) => boolean) | null; compact?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState(initialTarget);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [network, setNetwork] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { setTarget(initialTarget); setSnapshot(null); }, [initialTarget, threadId]);
  const refresh = useCallback(async (checkUpdates = false, force = false) => {
    const id = ++sequence.current;
    try {
      const value = await rpc.call('status', { threadId, target, phase, checkUpdates, force });
      if (mounted.current && id === sequence.current) { setSnapshot(value); setError(''); }
    } catch (e) {
      if (mounted.current && id === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setSnapshot(null); }
    } finally { if (mounted.current && id === sequence.current) setLoading(false); }
  }, [rpc, threadId, target, phase]);
  useEffect(() => {
    setLoading(true); void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  async function run(action: Action) {
    if (!snapshot || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(''); setNotice('');
    try {
      const result = await rpc.call('run', { threadId, target: snapshot.target?.path ?? target, phase: snapshot.phase,
        fingerprint: snapshot.fingerprint, actionId: action.id, requestId: crypto.randomUUID() });
      if (mounted.current) setNotice(result.message);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { sendingRef.current = false; if (mounted.current) { setSending(false); void refresh(); } }
  }
  const busy = !!snapshot && !['idle', 'error'].includes(snapshot.threadState);
  const tasks = snapshot?.target?.tasks ?? [];
  const completed = tasks.filter(t => t.done).length;
  const nextVersionCheck = snapshot?.upstream.checkedAt ? Date.parse(snapshot.upstream.checkedAt) + VERSION_TTL : 0;
  const renderAction = (a: Action) => <button key={a.id} type="button"
    className={a.group === 'next' ? 'aif-action' : 'aif-action aif-secondary'} disabled={sending || busy || !a.available}
    title={`${a.reason}\n${a.command}`} onClick={() => void run(a)}>{a.label}{!a.available && (a.disabledReason === 'unchanged' ? ' · без изменений' : ' · не установлен')}</button>;
  const renderActions = (actions: Action[]) => <div className="aif-actions">{actions.map(renderAction)}</div>;
  return <section className={`aif-card${compact ? ' aif-compact' : ''}`} aria-label="AI Factory workflow">
    <header className="aif-heading"><strong><span aria-hidden="true">◈</span> AI Factory</strong>
      {snapshot && <span className="aif-profile">{profileNames[snapshot.profile]}</span>}
      <button className="aif-refresh" type="button" onClick={() => void refresh(false, true)} aria-label="Обновить статус AI Factory" title="Перечитать задачи и проверки; версии CLI/Git и GitHub кэшируются на сутки">↻</button>
    </header>
    {loading && <p role="status" className="aif-muted">Читаю локальный статус…</p>}
    {error && <p role="alert" className="aif-error">{error}</p>}
    {notice && <p role="status" className="aif-notice">{notice}</p>}
    {snapshot && <>
      <div className="aif-versions"><span>CLI <b>{snapshot.versions.globalCli ?? 'не найден'}</b></span><span>Проект <b>{snapshot.versions.installed ?? 'не указан'}</b></span>
        {snapshot.versions.sourceVersion && <span>Git <b>{snapshot.versions.sourceVersion}</b><small> @{snapshot.versions.sourceSha?.slice(0, 7)}{snapshot.versions.sourceDirty ? ' · изменён' : ''}</small></span>}
        {snapshot.extensions.map(e => <span key={e.name} title={e.installedVersion ? 'Установленная версия расширения' : 'Записанная версия; установленные файлы не подтверждены'}>{e.name} <b>{e.installedVersion ?? e.recordedVersion ?? 'неизвестна'}</b>{!e.installedVersion && <small> · не подтверждена</small>}</span>)}</div>
      <div className="aif-maintenance" role="group" aria-label="Обновление и настройка AI Factory">{renderActions(snapshot.actions.filter(a => a.group === 'maintenance' && !updateInVersionDetails(snapshot, a.id) && !contextSetupInDetails(snapshot, a.id)))}</div>
      <p className="aif-stage" title={snapshot.phaseSource}>{busy ? <span className="aif-live-dot" aria-hidden="true" /> : <span className="aif-idle-dot" aria-hidden="true" />} {phaseNames[snapshot.phase]}
        <span className="aif-muted"> · {snapshot.pendingQuestions ? `ожидаю ответы: ${snapshot.pendingQuestions}` : busy ? 'агент занят' : snapshot.threadState === 'error' ? 'ошибка выполнения BB' : 'агент свободен'}</span></p>
      {!snapshot.configured && <p className="aif-muted">AI Factory в этой рабочей папке не настроен. Обновление доступно для существующего CLI; для запуска aif сначала установите skills проекта.</p>}
      {snapshot.candidates.length > 0 && <label className="aif-target">План / change
        <select aria-label="Выбранный план или change" value={snapshot.target?.path ?? target} onChange={e => { setTarget(e.target.value); setNotice(''); }}>
          {!snapshot.target && <option value="">Выберите задачу</option>}
          {snapshot.candidates.map(t => <option key={t.path} value={t.path}>{t.title} · {t.kind}</option>)}
        </select></label>}
      {snapshot.target && <div className="aif-progress"><div><strong>{snapshot.target.title}</strong><span>{completed}/{tasks.length} задач</span></div>
        <progress aria-label="Выполнение задач плана" value={completed} max={Math.max(tasks.length, 1)} />
        <details><summary>Задачи плана</summary><ul className="aif-tasks">{tasks.map((t, i) => <li key={`${t.id}-${i}`}><span className={t.done ? 'aif-task-done' : 'aif-muted'} aria-label={t.done ? 'Выполнена по плану' : 'Не выполнена'}>{t.done ? '✓' : '□'}</span><span>{t.title}</span></li>)}</ul>
          {!tasks.length && <p className="aif-muted">Чекбоксы задач не найдены; прогресс неизвестен.</p>}</details>
      </div>}
      {renderActions(snapshot.actions.filter(a => a.group === 'next').slice(0, 3))}
      {snapshot.actions.some(a => contextSetupInDetails(snapshot, a.id)) && <details className="aif-context-setup"><summary>Настройка контекста проекта</summary>
        <p className="aif-muted aif-small">Выполнение плана уже начато. Настройка контекста запускается отдельно и не продолжает выбранный план.</p>
        {renderActions(snapshot.actions.filter(a => contextSetupInDetails(snapshot, a.id)))}
      </details>}
      {snapshot.target && <details className="aif-checks"><summary>Что проверить <span className="aif-muted">· из чата: {snapshot.checks.filter(c => c.chat).length} · отчётов PASS: {snapshot.checks.filter(c => c.state === 'reported-pass').length}</span></summary>
        <p className="aif-muted aif-small">Галочки задач и результаты проверок независимы. Актуальность evidence подтверждает владелец workflow.</p>
        <ul>{snapshot.checks.map(c => <li key={c.id}><div><strong>{c.label}</strong>{c.required && <small className="aif-required">нужно для завершения</small>}</div>
          <span className={`aif-check-state aif-${c.chat ? c.chat.result.status === 'pass' ? 'reported-pass' : c.chat.result.status : c.state}`} title={c.detail}>{c.chat ? `${c.chat.result.status.toUpperCase()} · из чата` : checkLabels[c.state]}</span>
          {snapshot.actions.filter(a => a.id === rowActions[c.id]).map(renderAction)}
          {c.path && openFile && <button className="aif-link" onClick={() => { if (!openFile(c.path!)) setError('Просмотр файла недоступен в этой поверхности.'); }}>Отчёт</button>}
          {c.chat && <small className="aif-check-detail">Gate завершён · {new Date(c.chat.at).toLocaleString('ru')} · сообщение #{c.chat.seq}. {c.chat.freshness === 'unchanged'
            ? 'С момента фиксации результата файлы не изменились. Повторная проверка заблокирована.'
            : c.chat.freshness === 'changed' ? 'Файлы изменились после фиксации результата; можно проверить повторно.' : 'Актуальность для текущих файлов не подтверждена.'}
            {c.chat.result.blocking ? ' Есть блокирующие проблемы.' : ' Блокеров нет.'}
            {c.chat.result.blockers.map(b => <span key={b.id}>{` ${b.id}: ${b.summary}${b.file ? ` (${b.file})` : ''}`}</span>)}
            {c.chat.result.suggested_next?.reason && <span>{` ${c.chat.result.suggested_next.reason}`}</span>}</small>}
          <small className="aif-check-detail">{c.chat ? `Файловый отчёт: ${c.path ? checkLabels[c.state] + '. ' + c.detail : 'не найден.'}` : c.detail}</small></li>)}</ul>
        <details className="aif-setup"><summary>Настройка инструментов</summary>{renderActions(snapshot.actions.filter(a => a.group === 'setup'))}</details>
      </details>}
      <details className="aif-details"><summary>Версии и расширения{snapshot.extensions.length ? ` · ${snapshot.extensions.length}` : ''}</summary>
        {renderActions(snapshot.actions.filter(a => a.group === 'maintenance' && updateInVersionDetails(snapshot, a.id)))}
        {snapshot.versionsCheckedAt && <p className="aif-muted aif-small">Версии CLI/Git: снимок от {new Date(snapshot.versionsCheckedAt).toLocaleString('ru')}. Плановая проверка — раз в сутки.</p>}
        <dl><dt>Глобальный CLI</dt><dd>{snapshot.versions.globalCli ?? 'Не найден'}{snapshot.versions.globalSource && <small>{snapshot.versions.globalSource}</small>}</dd>
          <dt>Установка проекта</dt><dd>{snapshot.versions.installed ?? 'Не указана'} · {snapshot.runtime}</dd>
          <dt>Исходники Git</dt><dd>{snapshot.versions.sourceVersion ?? 'Checkout не задан'}{snapshot.versions.sourceSha && <small>{snapshot.versions.sourceSha}</small>}
            {snapshot.versions.sourceWorktreeVersion && snapshot.versions.sourceWorktreeVersion !== snapshot.versions.sourceVersion && <small>Рабочее дерево: {snapshot.versions.sourceWorktreeVersion}</small>}</dd>
          <dt>Git upstream</dt><dd>{snapshot.upstream.version ?? 'Не проверен'}{snapshot.upstream.ref && ` · ${snapshot.upstream.ref} @${snapshot.upstream.sha?.slice(0, 7)}`}
            {snapshot.upstream.checkedAt && <small>Проверено {new Date(snapshot.upstream.checkedAt).toLocaleString()}</small>}{snapshot.upstream.error && <small>{snapshot.upstream.error}</small>}</dd></dl>
        <button type="button" className="aif-action aif-secondary" disabled={network || nextVersionCheck > Date.now()} title={nextVersionCheck > Date.now() ? `Следующая проверка доступна ${new Date(nextVersionCheck).toLocaleString('ru')}` : 'Проверить upstream; результат сохраняется на сутки'} onClick={async () => { setNetwork(true); try { await refresh(true); } finally { if (mounted.current) setNetwork(false); } }}>{network ? 'Проверяю GitHub…' : 'Проверить версию в GitHub'}</button>
        {nextVersionCheck > Date.now() && <p className="aif-muted aif-small">Следующая проверка GitHub — {new Date(nextVersionCheck).toLocaleString('ru')}.</p>}
        {snapshot.extensions.length ? <ul className="aif-extensions">{snapshot.extensions.map(e => <li key={e.name}><strong>{e.name}</strong> {e.installedVersion ?? 'файлы отсутствуют'} <span className="aif-muted">· {e.state}</span>
          <small>Записано: {e.recordedVersion ?? 'не указано'} · {e.source}</small>{e.contributions.length > 0 && <small>Настроенные injections: {e.contributions.join(', ')}. Это не подтверждение загрузки в текущую сессию.</small>}</li>)}</ul> : <p className="aif-muted">Расширения не зарегистрированы в этом проекте.</p>}
      </details>
      {snapshot.diagnostics.length > 0 && <details className="aif-diagnostics"><summary>Примечания · {snapshot.diagnostics.length}</summary><ul>{snapshot.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul></details>}
      <footer className="aif-muted aif-small">{snapshot.cache?.source === 'saved' ? 'Сохранённые данные' : snapshot.cache?.source === 'memory' ? 'Данные из кэша' : 'Локальный статус'} · {new Date(snapshot.collectedAt).toLocaleTimeString()}
        {snapshot.cache?.refreshing && ' · обновляются в фоне…'}{snapshot.cache?.refreshError && ' · обновление не удалось; нажмите ↻ для повторного чтения'} · {busy ? 'действия доступны после завершения работы' : 'кнопки отправляют выбранную команду в этот чат'}</footer>
    </>}
  </section>;
}
function Directive(props: PluginMessageDirectiveProps) {
  const parsed = phaseSchema.safeParse(props.attributes.phase ?? 'unknown');
  if (!parsed.success || (props.attributes.target?.length ?? 0) > 1000) return <p className="aif-error">Некорректная карточка AI Factory.</p>;
  return <WorkflowCard threadId={props.message.threadId} initialTarget={props.attributes.target ?? ''} phase={parsed.data} openFile={props.openWorkspaceFile} />;
}
function ContextCard({ threadId }: ExperimentalThreadContextCardProps) { return <WorkflowCard threadId={threadId} compact />; }
function WorkflowPanel({ threadId }: ExperimentalThreadTabProps) { return <div className="aif-panel"><WorkflowCard key={threadId} threadId={threadId} compact /></div>; }
function SuggestedCommands() {
  const composer = useComposer();
  return composer.scope.kind === 'thread' ? <SuggestionBar key={composer.scope.threadId} threadId={composer.scope.threadId} composerBusy={composer.isRunning || composer.isSubmitting} /> : null;
}
function SuggestionBar({ threadId, composerBusy }: { threadId: string; composerBusy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const operation = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await rpc.call('suggestions', { threadId });
      if (mounted.current && sequence.current === id) setData(next);
    } catch { if (mounted.current && sequence.current === id) setData(null); }
  }, [rpc, threadId]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); };
  }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  async function act(id: string, dismiss: boolean) {
    if (!data || operation.current) return;
    operation.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const input = { threadId, sourceKey: data.sourceKey, commandId: id };
      if (dismiss) await rpc.call('dismissSuggestion', input);
      else {
        const result = await rpc.call('runSuggestion', { ...input, fingerprint: data.fingerprint, requestId: crypto.randomUUID() });
        if (mounted.current) setNotice(result.message);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { await refresh(); operation.current = false; if (mounted.current) setWorking(false); }
  }
  const busy = composerBusy || !!data && !['idle', 'error'].includes(data.threadState);
  if (!data?.items.length && !data?.gate && !data?.gateError && !error && !notice) return null;
  return <section className="aif-suggestions" aria-label="Команды из последнего ответа агента">
    {(data?.gate || data?.gateError) && <div className={`aif-message-gate${data.gate?.blocking || data.gateError ? ' aif-message-gate-blocking' : ''}`} role="group" aria-label="Gate из последнего ответа">
      {data.gate && <><div className="aif-message-gate-heading"><strong>{data.gate.gate} · {data.gate.status.toUpperCase()} в ответе</strong><span>{data.gate.blocking ? 'Блокирует следующий этап' : 'Не блокирует'}</span></div>
        <p className="aif-muted aif-small">Заявленный результат из чата. Актуальность evidence для текущих inputs проверяет владелец workflow.</p>
        {data.gate.blockers.length ? <details open><summary>Блокирующие проблемы · {data.gate.blockers.length}</summary><ul>{data.gate.blockers.map((b, i) => <li key={`${b.id}-${i}`}><strong>{b.id}</strong> <span className="aif-muted">· {b.severity}</span><p>{b.summary}</p>{b.file && <code>{b.file}</code>}</li>)}</ul></details> : <p className="aif-small">Блокирующих проблем нет.</p>}
        {data.gate.suggested_next?.reason && <p className="aif-small"><strong>{data.gate.suggested_next.command ? 'Следующий шаг: ' : 'Пояснение: '}</strong>{data.gate.suggested_next.reason}</p>}
        {!!data.gate.affected_files.length && <details><summary>Затронутые файлы · {data.gate.affected_files.length}</summary><ul>{data.gate.affected_files.map((file, i) => <li key={i}><code>{file}</code></li>)}</ul></details>}
      </>}
      {data.gateError && <p className="aif-error" role="alert">Некорректный gate: {data.gateError}</p>}
    </div>}
    {!!data?.items.length && <><span className="aif-suggestions-label">Из ответа агента</span><div className="aif-suggestion-list">{data.items.map(item => <div className="aif-suggestion" key={item.id}>
      <button type="button" className="aif-suggestion-run" disabled={working || busy || !item.available} title={busy ? 'Дождитесь завершения текущей работы' : item.reason} onClick={() => void act(item.id, false)}>{item.command}</button>
      <button type="button" className="aif-suggestion-dismiss" disabled={working} aria-label={`Удалить предложение ${item.command}`} title="Убрать из предложений этого ответа" onClick={() => void act(item.id, true)}>×</button>
    </div>)}</div></>}
    {error && <p className="aif-error" role="alert">{error}</p>}
    {notice && <p className="aif-muted aif-small" role="status">{notice}</p>}
  </section>;
}
export default definePluginApp(app => {
  app.slots.experimental_codeFenceRenderer({ id: 'gate-data', languages: ['aif-gate-result'], component: GateData });
  app.composer.customize({ id: 'suggested-commands', scopes: ['thread'], banners: [{ id: 'commands', chrome: 'bare', component: SuggestedCommands }] });
  app.slots.messageDirective({ id: 'aif-chat', component: Directive });
  app.slots.experimental_threadContextCardSection({ id: 'workflow', title: 'AI Factory', group: '9_aif', order: 10, component: ContextCard });
  app.slots.experimental_tab({ id: 'workflow', context: { kind: 'thread' }, availability: 'fixed', title: 'AI Factory', icon: 'Workflow', layout: 'flush', component: WorkflowPanel });
  app.slots.experimental_threadAction({
    id: 'open-workflow', title: 'AI Factory', icon: 'Workflow', group: '0_aif', placement: 'header',
    item: ({ experimental_panel }) => ({
      label: 'AI Factory', icon: 'Workflow', detail: 'Версии, workflow и прогресс проверок',
      run: () => { experimental_panel.openTab({ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } }); },
    }),
  });
});
