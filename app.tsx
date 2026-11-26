import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useRpc, experimental_useRpcQuery, Markdown, experimental_FileLink as FileLink, useComposer, useBbNavigate, experimental_useAppPanel, experimental_ProviderModelPicker as ProviderModelPicker, type ExperimentalProviderModelPickerValue as PickerValue, type PluginMessageDirectiveProps, type ExperimentalThreadContextCardProps, type ExperimentalThreadTabProps, type ExperimentalCodeFenceRendererProps, type PluginComposerApi } from '@get-bb/plugin-sdk/app';
import { rpcContract, type ChipScoringView, type DelegationView } from './contract.ts';
import type { DelegationChoice, DelegationRole } from './delegation.ts';
import { phaseSchema, cardIdSchema, RESEARCH_TASK_MAX_LENGTH, type Snapshot, type Phase, type Action, type ReadinessStep, type Suggestions } from './model.ts';
import { readinessComplete, readinessCoreComplete, nextReadinessStep, readinessHelp, type SkippableStepId } from './readiness.ts';
import { parseReplyGate } from './gate.ts';
import { checkHelp, rowActions, supplementaryChecks, toolHelp } from './check-actions.ts';
import { updateInVersionDetails, VERSION_TTL } from './versions.ts';
import { contextSetupInDetails } from './workflow.ts';
import { chipDraft, isCommandDraft } from './suggestions.ts';
import { AIF_MENTION } from './aif-mode.ts';
import { isBasicPlanPath, usesBasicWorkflow, isCompletedPlan } from './basic-workflow.ts';
import { mountPlanPresentation } from './plan-presentation.ts';
import { sessionBriefBlocked } from './session-brief.ts';
import { preparationCommands, preparationHelp } from './project-preparation.ts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Callout, Disclosure, Hint, Section, StatusDot, SurfaceProvider, useSurface, type Tone } from '@/components/aif/layout';
import './aif-chat.css';

const phaseNames: Record<Phase, string> = { unknown: 'Контекст задачи', explore: 'Исследование', plan: 'Планирование', improve: 'Уточнение плана', implement: 'Выполнение плана', verify: 'Проверка', fix: 'Исправление замечаний', done: 'Финализация' };
const profileNames: Record<Snapshot['profile'], string> = { none: 'Нет установки', upstream: 'AI Factory', 'aifhub-classic': 'AIFHub · classic', 'aifhub-openspec': 'AIFHub · OpenSpec', 'aifhub-ultra': 'AIFHub · legacy ultra', invalid: 'Проверьте конфигурацию' };
const checkLabels = { notrun: 'Нет отчёта', 'reported-pass': 'PASS в отчёте', warn: 'С замечаниями', fail: 'Ошибка', unknown: 'Не подтверждено' };
const checkIcons = { notrun: 'Minus', 'reported-pass': 'CircleCheck', warn: 'AlertTriangle', fail: 'CircleX', unknown: 'CircleQuestion' };

const actionIcons: Record<string, string> = {
  commit: 'GitBranch', fix: 'ToolCase', 'fix-new': 'ToolCase', 'fix-findings': 'ToolCase', 'execute-fix': 'ToolCase',
  verify: 'CircleCheck', 'check-verify': 'ListTodo', implement: 'Play', 'implement-proposed': 'Play',
  explore: 'Search', plan: 'ListTodo', improve: 'Edit', 'apply-improvements': 'Check',
  done: 'Archive', 'ultra-receipt': 'FileText', sync: 'FolderSync', 'context-sync': 'FolderSync', 'rules-sync': 'FolderSync',
  'context-compile': 'FileText', 'setup-context': 'Settings', analyze: 'Search', init: 'Download',
  install: 'Download', 'install-factory': 'Download', 'update-factory': 'PackageReceive', 'update-extensions': 'Puzzle',
  'check-rules': 'FileText', 'rules-check': 'FileText', 'check-security': 'SecurityCheck', 'security-checklist': 'SecurityCheck',
  'check-review': 'GitPullRequest', review: 'GitPullRequest', 'check-mode': 'Settings', mode: 'Settings',
  'check-worktree': 'FolderGit', 'check-coupling': 'Workflow', 'qa-prepare': 'ListView', qa: 'ListView',
  'qa-run': 'ListTodo', 'qa-check': 'ListTodo', quality: 'CircleCheck', 'quality-setup': 'Settings',
  ci: 'Workflow', 'ci-setup': 'Settings',
};
function ActionIcon({ id, command = '' }: { id: string; command?: string }) {
  const skill = command.match(/(?:^|[\s$/])aif-([a-z][a-z0-9-]*)\b/)?.[1];
  if (id.startsWith('prep-')) return <Icon name={preparationCommands[id.slice(5)]?.icon ?? 'Settings'} className="aif-button-icon" aria-hidden="true" />;
  return <Icon name={actionIcons[id.replace(/^basic-/, '')] ?? actionIcons[skill ?? ''] ?? 'ArrowRight'} className="aif-button-icon" aria-hidden="true" />;
}

function ExplainedLabel({ label, help, prefix, detail }: { label: string; help?: string; prefix?: ReactNode; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="aif-explained-label">
    <span className="aif-help-heading">
      {prefix}<strong>{label}</strong>
      {help && <button type="button" className="aif-help-toggle" aria-label={`Подробнее: ${label}`}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <span aria-hidden="true">?</span>
      </button>}
    </span>
    {help && <div className="aif-help-text" id={id} hidden={!open}>{help}{detail}</div>}
  </div>;
}

function CheckPanel({ checks, actions, renderAction, openReport }: {
  checks: Snapshot['checks']; actions: Action[]; renderAction: (action: Action) => ReactNode; openReport?: (path: string) => void;
}) {
  const blocking = checks.filter(check => check.chat?.result.blocking).length;
  const fromChat = checks.filter(check => check.chat).length;
  const filePasses = checks.filter(check => check.state === 'reported-pass').length;
  const setup = actions.filter(action => action.group === 'setup' && !action.id.startsWith('prep-'));
  const orderedChecks = [...checks].sort((a, b) => Number(!!b.chat?.result.blocking) - Number(!!a.chat?.result.blocking) || Number(b.required) - Number(a.required));

  return <details className="aif-checks aif-disclosure" open={blocking > 0 || undefined}>
    <summary>
      <span className="aif-check-summary">
        <span>Что проверить</span>
        {blocking > 0 && <span className="aif-check-state" data-state="fail">Блокирующие · {blocking}</span>}
        {fromChat > 0 && <span className="aif-check-summary-count">Из чата · {fromChat}</span>}
        {filePasses > 0 && <span className="aif-check-summary-count">PASS в отчётах · {filePasses}</span>}
      </span>
    </summary>
    <div className="aif-disclosure-body">
      <ul className="aif-check-list">
        {orderedChecks.map(check => {
          const { chat } = check;
          const state = chat ? chat.result.status === 'pass' ? 'reported-pass' : chat.result.status : check.state;
          const label = chat ? `${chat.result.status.toUpperCase()} · из чата` : checkLabels[state];
          const action = actions.find(item => item.id === rowActions[check.id]);
          const reportPath = check.path;
          const hasDetails = chat || reportPath || (check.state !== 'notrun' && check.detail);

          return <li key={check.id} className="aif-check-row" data-blocking={chat?.result.blocking || undefined}>
            <div className="aif-check-head">
              <div className="aif-check-label">
                <ExplainedLabel label={check.label} help={checkHelp[check.id]} />
                {check.required ? <small className="aif-check-required" title="Нужно для завершения">Обязательно</small>
                  : supplementaryChecks.has(check.id) && <small className="aif-check-optional">по выбору</small>}
              </div>
              <div className="aif-check-controls">
                <span className="aif-check-state" data-state={state}>
                  <Icon name={checkIcons[state]} aria-hidden="true" />{label}
                </span>
                {action && renderAction(action)}
                {reportPath && openReport && <button type="button" className="aif-action aif-secondary" onClick={() => openReport(reportPath)}>
                  <Icon name="FileText" className="aif-button-icon" aria-hidden="true" />Отчёт
                </button>}
              </div>
            </div>
            {chat && (chat.result.blocking || chat.result.blockers.length > 0) && <div className="aif-check-findings">
              {chat.result.blocking && <strong>Блокирует следующий этап</strong>}
              {chat.result.blockers.length > 0 && <ul>{chat.result.blockers.map(item =>
                <li key={item.id}><strong>{item.id}</strong> {item.summary}{item.file && <> <code>{item.file}</code></>}</li>,
              )}</ul>}
            </div>}
            {hasDetails && <details className="aif-check-report">
              <summary aria-label={`Детали проверки «${check.label}»`}>Детали</summary>
              {chat && <>
                <p><time dateTime={chat.at}>{new Date(chat.at).toLocaleString('ru')}</time> · сообщение #{chat.seq}</p>
                <p>{chat.freshness === 'unchanged' ? 'Файлы не изменились. Повторная проверка заблокирована.'
                  : chat.freshness === 'changed' ? 'Файлы изменились после фиксации результата. Можно проверить повторно.'
                  : 'Актуальность для текущих файлов не подтверждена.'}</p>
                {chat.result.suggested_next?.reason && <p>{chat.result.suggested_next.reason}</p>}
              </>}
              <p>{chat ? `Файловый отчёт: ${reportPath ? checkLabels[check.state] + '. ' + check.detail : 'не найден.'}` : check.detail}</p>
            </details>}
          </li>;
        })}
      </ul>
      {setup.length > 0 && <details className="aif-setup">
        <summary>Настройка инструментов</summary>
        <div className="aif-actions">{setup.map(renderAction)}</div>
      </details>}
    </div>
  </details>;
}

const unavailableSuffix = (a: Action) => a.disabledReason === 'unchanged' ? ' · без изменений' : a.disabledReason === 'requires-cli222' ? ' · нужен CLI 2.22+'
  : a.disabledReason === 'context-blocked' ? ' · контекст неактуален' : ' · не установлен';
const chipPercent = (p: number) => p > 0 && Math.round(p * 100) === 0 ? '<1%' : `${Math.round(p * 100)}%`;

/** Info mark: "?" in a circle, drawn inline so it never falls back to a host glyph. */
const InfoIcon = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
  <circle cx="8" cy="8" r="6.75" /><path d="M6.2 6.1a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.6-1.9 2.8" /><circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
</svg>;

/** Superscript «?» that toggles a plain-language description below its row. */
const HelpMark = ({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) =>
  <button type="button" className="ml-0.5 inline-flex -translate-y-1.5 cursor-pointer rounded-full border-0 bg-transparent p-0.5 align-top text-muted-foreground hover:text-foreground"
    aria-label={label} aria-expanded={open} onClick={onToggle}><InfoIcon /></button>;

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

function PlanDocument({ code, status, message }: ExperimentalCodeFenceRendererProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<{ path: string; seq: number; hash: string; environmentId: string } | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  // A finished plan is saved once per text; a failed save is retried only by the button.
  const save = useCallback(async () => {
    const id = ++generation.current;
    if (status !== 'closed' || !code.trim()) { setSaved(null); return; }
    try {
      const value = await rpc.call('planDocument', { threadId: message.threadId, text: code.trim() });
      if (generation.current === id) { setSaved(value); setError(''); }
    } catch (e) { if (generation.current === id) { setSaved(null); setError(e instanceof Error ? e.message : String(e)); } }
  }, [rpc, message.threadId, code, status]);
  useEffect(() => { void save(); return () => { generation.current++; }; }, [save]);
  const state = status === 'streaming' ? 'Генерируется' : status === 'unclosed' ? 'Не завершён' : saved ? 'Сохранён' : 'Ожидает сохранения';
  return <section aria-label="Документ плана" data-aif-plan-document="true" className="aif-plan-document my-3 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-sm text-foreground [overflow-wrap:anywhere]">
    <header className="flex flex-wrap items-center gap-2"><strong className="text-base font-semibold tracking-tight">План реализации</strong>
      <Badge variant={saved ? 'default' : 'secondary'} className="ml-auto">{state}</Badge></header>
    <Markdown content={code} className="aif-plan-markdown" />
    {saved && <p className="m-0 flex flex-wrap items-baseline gap-2 text-xs"><FileLink target={{ kind: 'workspace', environmentId: saved.environmentId, path: saved.path }}>Открыть файл плана</FileLink>
      <span className="text-muted-foreground">{saved.path}</span></p>}
    {status === 'unclosed' && <Callout tone="error">Генерация прервана. Неполный план не сохранён и не запускается.</Callout>}
    {error && <div className="flex flex-col gap-2"><Callout tone="error" role="alert">Не удалось сохранить план: {error}</Callout>
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => void save()}><ActionIcon id="verify" />Повторить сохранение</Button></div>}
    {status === 'closed' && !saved && !error && <p className="m-0 text-xs text-muted-foreground">Действия появятся после завершения генерации и сохранения файла.</p>}
    {saved && <div aria-label="Действия после плана"><WorkflowCard key={`${message.threadId}:${saved.path}`} threadId={message.threadId} initialTarget={saved.path} phase="plan" compact /></div>}
  </section>;
}

function WorkflowCard({ threadId, initialTarget = '', phase = 'unknown', openFile, compact = false, delegation = false, environmentId = null, inline = false }: {
  threadId: string; initialTarget?: string; phase?: Phase; openFile?: ((path: string) => boolean) | null; compact?: boolean; delegation?: boolean; environmentId?: string | null; inline?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState(initialTarget);
  const [newTask, setNewTask] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchTask, setResearchTask] = useState('');
  const [researchError, setResearchError] = useState('');
  const [actionError, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [savingPreparation, setSavingPreparation] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const preparationId = useId();
  const updatesId = useId();
  const updatesDetails = useRef<HTMLDetailsElement>(null);
  const [network, setNetwork] = useState(false);
  const [view, setViewState] = useState<'nav' | 'settings'>(() => {
    if (!delegation) return 'nav';
    try { return window.sessionStorage.getItem(`aif-view:${threadId}`) === 'settings' ? 'settings' : 'nav'; } catch { return 'nav'; }
  });
  const setView = (v: 'nav' | 'settings') => {
    setViewState(v);
    try { window.sessionStorage.setItem(`aif-view:${threadId}`, v); } catch {}
  };
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setTarget(initialTarget); setNewTask(false); setShowCompleted(false); setResearchOpen(false); setResearchTask(''); setResearchError(''); }, [initialTarget, threadId]);
  // BB's shared query cache: cards with the same input share one read; tag invalidation refreshes it, nothing polls.
  // A new task reads without the finished plan and phase; the server answers selectionReset for a plan that is gone.
  const statusInput = newTask ? { threadId, target: '', phase: 'unknown' as Phase, newTask: true } : { threadId, target, phase };
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'status', input: statusInput });
  // A failed read must not leave stale, still-clickable actions on screen.
  const [readFailed, setReadFailed] = useState('');
  useEffect(() => { setReadFailed(''); }, [query.data]);
  const failure = readFailed || (query.error ? query.error.message : '');
  const snapshot = failure ? null : query.data ?? null;
  const loading = query.isLoading;
  const error = actionError || failure;
  useEffect(() => {
    if (snapshot?.selectionReset) { setTarget(''); setNewTask(true); }
    else if (snapshot?.configured && isBasicPlanPath(target)) setTarget('');
  }, [snapshot, target]);
  // Explicit re-read past the server cache; the shared query then picks the fresh snapshot up.
  const refresh = useCallback(async (checkUpdates = false, force = false) => {
    try {
      if (checkUpdates || force) await rpc.call('status', { ...statusInput, checkUpdates, force });
      await query.refetch();
      if (mounted.current) { setError(''); setReadFailed(''); }
    } catch (e) { if (mounted.current) setReadFailed(e instanceof Error ? e.message : String(e)); }
  }, [rpc, query, threadId, target, phase, newTask]);
  async function togglePreparation(visible: boolean) {
    setSavingPreparation(true);
    setError('');
    try {
      await rpc.call('setPreparationVisibility', { threadId, visible });
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setSavingPreparation(false);
    }
  }
  async function run(action: Action, task?: string) {
    if (!snapshot || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(''); setNotice('');
    if (action.id === 'basic-explore') setResearchError('');
    let stale = false;
    try {
      const result = await rpc.call('run', { threadId, target: snapshot.target?.path ?? target, phase: snapshot.phase,
        fingerprint: snapshot.fingerprint, actionId: action.id, requestId: crypto.randomUUID(),
        ...(newTask ? { newTask: true } : {}), ...(task === undefined ? {} : { researchTask: task }) });
      stale = result.stale === true;
      if (mounted.current) {
        setNotice(result.message);
        if (result.sent && action.id === 'basic-explore') { setResearchOpen(false); setResearchTask(''); }
        if (result.sent && result.newTask) { setTarget(''); setNewTask(true); }
      }
    } catch (e) { if (mounted.current) {
      const message = e instanceof Error ? e.message : String(e);
      // A failed research dispatch keeps the form and its draft; the error stays next to it.
      if (action.id === 'basic-explore') setResearchError(message); else setError(message);
    } }
    finally {
      if (stale && mounted.current) await refresh(false, true);
      sendingRef.current = false;
      if (mounted.current) { setSending(false); if (!stale) void refresh(); }
    }
  }
  const setReadinessSkip = async (stepId: SkippableStepId, skipped: boolean) => {
    try { await rpc.call('setReadinessSkip', { threadId, stepId, skipped }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    await refresh();
  };
  const busy = !!snapshot && (!['idle', 'error'].includes(snapshot.threadState) || !!snapshot.pendingQuestions || snapshot.pendingConfirmation !== false);
  const tasks = snapshot?.target?.tasks ?? [];
  const completed = tasks.filter(t => t.done).length;
  const hiddenPlans = snapshot?.candidates.filter(isCompletedPlan) ?? [];
  const visiblePlans = snapshot?.candidates.filter(c => showCompleted || !isCompletedPlan(c)) ?? [];
  const researchAction = snapshot?.actions.find(a => a.id === 'basic-explore');
  // After a finished plan the research button stands apart: it starts a new task instead of continuing this one.
  const newResearch = !!researchAction && (snapshot?.target?.kind === 'basic' && tasks.length > 0 && completed === tasks.length
    || !!snapshot?.chatPlan?.accepted && snapshot.phase === 'done');
  const nextVersionCheck = snapshot?.upstream.checkedAt ? Date.parse(snapshot.upstream.checkedAt) + VERSION_TTL : 0;
  // One primary action per card: the first "next" step. Everything else is outline.
  // In the tab the readiness block owns its steps' actions, so they never take primary styling there.
  const readinessActionIds = new Set(snapshot?.readiness.map(s => s.actionId) ?? []);
  const primaryId = snapshot && (snapshot.actions.find(a => a.group === 'next' && a.available)
    ?? snapshot.actions.find(a => a.group === 'maintenance' && a.available && a.id !== 'update-factory' && a.id !== 'update-extensions' && !contextSetupInDetails(snapshot, a.id) && !(delegation && readinessActionIds.has(a.id))))?.id;
  const renderAction = (a: Action) => <Hint key={a.id} text={`${a.reason}\n${a.command}`}><Button type="button" size="sm" variant={a.id === primaryId ? 'default' : 'outline'}
    className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left" disabled={sending || busy || !a.available} onClick={() => {
      if (a.id === 'basic-explore') { setResearchOpen(true); setError(''); setNotice(''); } else void run(a);
    }}>
    <ActionIcon id={a.id} command={a.command} />{a.label}{!a.available && unavailableSuffix(a)}</Button></Hint>;
  const renderActions = (actions: Action[]) => actions.length ? <div className="flex flex-wrap gap-2">{actions.map(renderAction)}</div> : null;
  const stateText = snapshot ? snapshot.pendingQuestions ? `ожидаю ответы: ${snapshot.pendingQuestions}` : snapshot.pendingConfirmation ? 'ожидается подтверждение пользователя' : snapshot.pendingConfirmation === null ? 'ожидание подтверждения не проверено' : busy ? 'агент занят' : snapshot.threadState === 'error' ? 'ошибка выполнения BB' : 'агент свободен' : '';
  const preparation = snapshot?.preparation;
  const hasPreparation = !!preparation?.length;
  const preparationVisible = snapshot?.preparationVisible === true;
  const updates = snapshot?.actions.filter(a => a.id === 'update-factory' || a.id === 'update-extensions') ?? [];
  const showUpdateIndicator = snapshot && updates.some(a => a.available && !updateInVersionDetails(snapshot, a.id));
  const required = preparation?.filter(step => !step.optional) ?? [];
  const optional = preparation?.filter(step => step.optional) ?? [];
  const nextSetupStep = required.find(step => step.state === 'missing')?.id;
  const renderSetupStep = (step: NonNullable<Snapshot['preparation']>[number], number?: number) => {
    const installed = step.id === 'install' && step.state === 'found';
    const actionId = step.id === 'install' ? installed ? 'update-factory' : 'basic-install'
      : step.id === 'describe' ? 'setup-context' : `prep-${step.id}`;
    const action = snapshot?.actions.find(item => item.id === actionId);
    const current = step.id === nextSetupStep;
    const showAction = !!action && (installed || step.optional || current || step.id === 'describe' && step.state === 'found');
    return <li key={step.id} className="aif-prep-step" data-state={step.state} aria-current={current ? 'step' : undefined}>
      <span className="aif-prep-mark" role="img" aria-label={step.state === 'found' ? 'Файлы найдены' : step.state === 'unknown' ? 'Не удалось проверить файлы' : 'Файлы не найдены'}>
        <Icon name={step.state === 'found' ? 'CircleCheck' : step.state === 'unknown' ? 'CircleQuestion' : 'Circle'} className="aif-button-icon" aria-hidden="true" />
      </span>
      <div>
        <ExplainedLabel label={installed ? 'AI Factory установлен' : step.label} help={preparationHelp[installed ? 'update' : step.id]}
          prefix={number !== undefined && <span className="aif-muted" aria-hidden="true">{number}.</span>}
          detail={<div className="aif-prep-paths">{step.paths.map(file => <code key={file}>{file}</code>)}</div>} />
        {showAction && <div className={current ? 'aif-prep-action aif-prep-current' : 'aif-prep-action'}>{renderAction(action)}</div>}
      </div>
    </li>;
  };
  const setupContent = preparation && <>
    <ol className="aif-prep-list">{required.map((step, index) => renderSetupStep(step, index + 1))}</ol>
    <details className="aif-prep-optional"><summary>Дополнительно</summary>
      <ul className="aif-prep-list">{optional.map(step => renderSetupStep(step))}</ul>
    </details>
  </>;
  const coreReady = !snapshot || !snapshot.readiness.length || readinessCoreComplete(snapshot.readiness);
  const openReadiness = () => {
    setView('settings');
    // Wait for the settings view to render, then bring the highlighted block into view.
    requestAnimationFrame(() => document.getElementById('aif-readiness')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };
  const settingsAttention = !!snapshot && (snapshot.profile === 'invalid' || !coreReady ||
    snapshot.actions.some(a => a.group === 'maintenance' && a.available && updateInVersionDetails(snapshot, a.id)));
  const versionsLine = snapshot && <dl className="aif-versions" aria-label="Версии AI Factory">
        <div><dt>CLI</dt><dd>{snapshot.versions.globalCli ?? 'не найден'}</dd></div>
        <div><dt>Проект</dt><dd>{snapshot.versions.installed ?? 'не указан'}</dd></div>
        {snapshot.versions.sourceVersion && <div><dt>Git</dt><dd>{snapshot.versions.sourceVersion}
          {snapshot.versions.sourceSha && <small>@{snapshot.versions.sourceSha.slice(0, 7)}</small>}
          {snapshot.versions.sourceDirty && <small>изменён</small>}</dd></div>}
        {snapshot.extensions.map(e => <div key={e.name} title={e.installedVersion ? 'Установленная версия расширения' : 'Записанная версия; установленные файлы не подтверждены'}>
          <dt>{e.name}</dt><dd>{e.installedVersion ?? e.recordedVersion ?? 'неизвестна'}{!e.installedVersion && <small>не подтверждена</small>}</dd>
        </div>)}
      </dl>;
  // The transcript card hides while the agent waits for the user; the tab and context card keep their state visible.
  if (inline && (loading && !snapshot || snapshot && (snapshot.pendingConfirmation || snapshot.pendingQuestions))) return null;
  return <section aria-label="AI Factory workflow" className={cn('aif-card flex min-w-0 flex-col gap-4 text-sm text-foreground [overflow-wrap:anywhere]',
    compact ? '' : 'my-3 rounded-xl border border-border bg-card p-4')}>
    <header className={cn('flex min-h-8 flex-wrap items-center gap-2', delegation && 'sticky -top-3 z-10 -mx-3 -mt-3 border-b border-border bg-background/90 px-3 py-3 backdrop-blur')}>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><FactoryIcon className="size-3.5" /></span>
      <strong className="text-base font-semibold tracking-tight whitespace-nowrap">AI Factory</strong>
      {snapshot && snapshot.profile !== 'upstream' && <Badge variant="secondary" className="min-w-0 truncate font-medium">{profileNames[snapshot.profile]}</Badge>}
      {delegation && <div role="tablist" aria-label="Раздел панели" className="gap-0.5 rounded-lg bg-muted p-0.5 @max-md/aif:order-last @max-md/aif:basis-full @max-md/aif:grid @max-md/aif:grid-cols-2 @md/aif:ml-auto @md/aif:flex">
        {(['nav', 'settings'] as const).map(v => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
          className={cn('h-8 cursor-pointer whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
            view === v ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>
          {v === 'nav' ? 'Навигация' : 'Настройки'}{v === 'settings' && settingsAttention && <><span aria-hidden="true" className="ml-1 inline-block size-1.5 rounded-full bg-primary" /><span className="sr-only">, есть что проверить</span></>}
        </button>)}
      </div>}
      <span className={cn('flex items-center gap-2', delegation ? '@max-md/aif:ml-auto' : 'ml-auto')}>
        {hasPreparation && (!delegation || view === 'nav') && <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground"
          disabled={savingPreparation} aria-label={preparationVisible ? 'Скрыть подготовку проекта' : 'Показать подготовку проекта'}
          aria-expanded={preparationVisible} aria-controls={preparationId} onClick={() => void togglePreparation(!preparationVisible)}>
          <Icon name="ListTodo" className="size-4" aria-hidden="true" />
        </Button>}
        {snapshot && <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground data-[update=true]:text-primary"
          aria-label="Версии и обновления" aria-expanded={updatesOpen} aria-controls={updatesId} data-update={showUpdateIndicator || undefined}
          onClick={() => {
            const details = updatesDetails.current;
            if (!details) {
              setView('settings');
              requestAnimationFrame(() => { if (updatesDetails.current) updatesDetails.current.open = true; });
              return;
            }
            details.open = !details.open;
            if (details.open) details.querySelector('summary')?.focus();
          }}><Icon name="PackageReceive" className="size-4" aria-hidden="true" /></Button>}
        <Hint text="Перечитать задачи и проверки; версии CLI/Git и GitHub кэшируются на сутки"><Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => void refresh(false, true)}
          aria-label="Обновить статус AI Factory"><Icon name="RotateCcw" className="size-4" /></Button></Hint>
      </span>
    </header>
    {loading && <div role="status" aria-label="Читаю локальный статус…" className="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />}
    {error && <Callout tone="error" role="alert">{error}</Callout>}
    {notice && <Callout role="status">{notice}</Callout>}
    {snapshot && <>
      {!delegation && versionsLine}
      {hasPreparation && (!delegation || view === 'nav') && <section id={preparationId} className="aif-preparation" aria-label="Подготовка проекта" hidden={!preparationVisible}>
        {preparationVisible && <><h3>Подготовка проекта</h3>{setupContent}</>}
      </section>}


      {delegation && view === 'nav' && !hasPreparation && !coreReady && <Section label="Подготовка проекта" highlight>
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="m-0 text-sm font-medium">Проект не подготовлен к AI Factory</p>
            <p className="m-0 text-xs text-muted-foreground">Основных шагов осталось: {snapshot.readiness.filter(s => !s.skippable && s.state !== 'done').length} из {snapshot.readiness.filter(s => !s.skippable).length}</p>
          </div>
          <Button type="button" size="sm" onClick={openReadiness}>Подготовить</Button>
        </div>
      </Section>}

      {(!delegation || view === 'nav') && <Section label="Текущий этап" title="Сейчас">
        <p className="m-0 flex flex-wrap items-center gap-2" title={snapshot.phaseSource}>
          <StatusDot tone={busy ? 'live' : snapshot.threadState === 'error' ? 'error' : 'idle'} />
          <span className="font-medium">{phaseNames[snapshot.phase]} <span className="font-normal text-muted-foreground">· {stateText}</span></span>
        </p>
        {usesBasicWorkflow(snapshot) && <p aria-label="Базовый workflow" className="m-0 text-xs text-muted-foreground">Без AI Factory доступен встроенный flow: исследование → Plan BB → выполнение → проверка → коммит. «Составить план» включает штатный режим Plan. Установка — отдельная кнопка.</p>}
        {sessionBriefBlocked(snapshot) && <div aria-label="Блокировка SessionBrief"><Callout tone="error" role="status">SessionBrief: {snapshot.sessionBrief!.status.toUpperCase()} · из чата. Выполнение остановлено. Синхронизируйте выбранный change, затем пересоберите SessionBrief. Актуальность контекста проверяет владелец workflow.</Callout></div>}
        {snapshot.fixDefaults && <p className="m-0 text-xs text-muted-foreground">Fix: <code>{snapshot.fixDefaults.mode}</code> · learning patch: {snapshot.fixDefaults.patch ? 'включён' : 'выключен'} · настройки применяет aif-fix</p>}
        {snapshot.candidates.length > 0 && <label className="flex flex-col gap-1 text-xs text-muted-foreground">План / change
          <select aria-label="Выбранный план или change" value={snapshot.target?.path ?? target} onChange={e => { setTarget(e.target.value); setNewTask(false); setNotice(''); }}
            className="h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {!snapshot.target && <option value="">Выберите задачу</option>}
            {!showCompleted && snapshot.target && hiddenPlans.some(t => t.path === snapshot.target!.path) && <option value={snapshot.target.path} hidden>{snapshot.target.title} · завершён</option>}
            {visiblePlans.map(t => <option key={t.path} value={t.path} title={t.path}>{t.title}{t.progress ? ` · выполнено ${t.progress.completed} из ${t.progress.total}` : ''}{t.closed ? ' · закрыт' : ''} · {t.kind}</option>)}
          </select></label>}
        {hiddenPlans.length > 0 && <label htmlFor={`aif-show-completed-${threadId}`} className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox id={`aif-show-completed-${threadId}`} checked={showCompleted} onCheckedChange={v => setShowCompleted(v === true)} />Показать завершённые ({hiddenPlans.length})</label>}
        {snapshot.target && <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3"><strong className="font-medium">{snapshot.target.title}</strong>
            <span className="text-xs text-muted-foreground tabular-nums">{completed}/{tasks.length} задач</span></div>
          {snapshot.target.verification?.verified && <p className="m-0 text-xs text-muted-foreground" title="Отметка владельца проверки в файле плана">План отмечен проверенным</p>}
          <Progress aria-label="Выполнение задач плана" value={tasks.length ? completed / tasks.length * 100 : 0} className="h-1.5 bg-muted" />
          {snapshot.target.settings && Object.values(snapshot.target.settings).some(Boolean) && <p aria-label="Настройки плана" className="m-0 text-xs text-muted-foreground">Коммиты: <code>{snapshot.target.settings.commitStrategy ?? 'не указано'}</code> · Метод: <code>{snapshot.target.settings.methodology ?? 'не указан'}</code>{snapshot.target.settings.tddGranularity && <> · TDD: <code>{snapshot.target.settings.tddGranularity}</code></>}</p>}
          <Disclosure summary="Задачи плана">
            {tasks.length ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{tasks.map((t, i) => <li key={`${t.id}-${i}`} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-xs">
              <span role="img" aria-label={t.outcome === 'skipped' ? 'Пропущена по плану' : t.done ? 'Выполнена по плану' : 'Не выполнена'} className="mt-px">
                <Icon name={t.outcome === 'skipped' ? 'Minus' : t.done ? 'CircleCheck' : 'Circle'} aria-hidden="true" className={cn('size-4', t.done ? 'text-primary' : 'text-muted-foreground')} /></span>
              <span className={t.done ? 'text-muted-foreground' : ''}>{t.title}{t.kind === 'commit' && <span className="text-muted-foreground"> · коммит</span>}{t.outcome === 'skipped' && <span className="text-muted-foreground"> · пропущено по плану</span>}</span></li>)}</ul>
              : <p className="m-0 text-xs text-muted-foreground">Чекбоксы задач не найдены; прогресс неизвестен.</p>}
          </Disclosure>
        </div>}
        {snapshot.chatPlan && !snapshot.target && <div aria-label="План из чата" className="flex flex-col gap-1">
          <strong className="font-medium">{snapshot.chatPlan.title}</strong>
          <p className="m-0 text-xs text-muted-foreground">{snapshot.chatPlan.accepted ? 'Выполнение плана запрошено' : 'План предложен · ожидает запуска'} · сообщение #{snapshot.chatPlan.seq}. Прогресс задач и результаты проверок не подтверждены.</p>
        </div>}
        {renderActions(snapshot.actions.filter(a => a.group === 'next' && !(newResearch && a.id === 'basic-explore')).slice(0, 3))}
        {newResearch && <div role="group" aria-label="Новая задача">{renderActions([researchAction!])}</div>}
        {researchOpen && researchAction && <form aria-label="Описание исследования" className="flex flex-col gap-2" onSubmit={event => {
          event.preventDefault();
          if (!researchTask.trim() || busy || sending || !researchAction.available) return;
          void run(researchAction, researchTask.trim());
        }}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Что исследовать?
            <textarea autoFocus required maxLength={RESEARCH_TASK_MAX_LENGTH} rows={4} value={researchTask} disabled={sending || busy}
              placeholder="Опишите вопрос, проблему или укажите ссылку на задачу" onChange={event => setResearchTask(event.target.value)}
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" />
          </label>
          <p className="m-0 text-xs text-muted-foreground">До {RESEARCH_TASK_MAX_LENGTH} символов. Исследование изучает задачу и код, не меняя файлы.</p>
          {researchError && <Callout tone="error" role="alert">{researchError}</Callout>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!researchTask.trim() || sending || busy || !researchAction.available}><ActionIcon id="explore" />Начать исследование</Button>
            <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => { setResearchOpen(false); setResearchTask(''); setResearchError(''); }}>Отмена</Button>
          </div>
        </form>}
        {(() => { const items = snapshot.actions.filter(a => a.group === 'maintenance' && !updates.includes(a) && !contextSetupInDetails(snapshot, a.id) && !(hasPreparation && (a.id === 'setup-context' || a.id === 'basic-install')) && !(delegation && a.id === 'setup-context'));
          return items.length ? <div className="aif-maintenance" role="group" aria-label="Обновление и настройка AI Factory">{renderActions(items)}</div> : null; })()}
        {!delegation && !hasPreparation && snapshot.actions.some(a => contextSetupInDetails(snapshot, a.id)) && <Disclosure className="aif-context-setup" summary="Настройка контекста проекта">
          <p className="m-0 text-xs text-muted-foreground">Выполнение плана уже начато. Настройка контекста запускается отдельно и не продолжает выбранный план.</p>
          {renderActions(snapshot.actions.filter(a => contextSetupInDetails(snapshot, a.id)))}
        </Disclosure>}
      </Section>}

      {delegation && view === 'nav' && snapshot.configured && <WorkingSection threadId={threadId} />}

      {(!delegation || view === 'nav') && snapshot.checks.length > 0 &&
        <CheckPanel checks={snapshot.checks} actions={snapshot.actions} renderAction={renderAction}
          openReport={openFile ? path => { if (!openFile(path)) setError('???????? ????? ?????????? ? ???? ???????????.'); } : undefined} />}

      {delegation && view === 'settings' && <>
        {snapshot.readiness.length > 0 && <ReadinessSection snapshot={snapshot} run={run} busy={busy} sending={sending} setReadinessSkip={setReadinessSkip} />}
        {snapshot.configured && <DelegationSection threadId={threadId} environmentId={environmentId} busy={busy} />}
        <ChipScoringSection threadId={threadId} />
        <Disclosure summary="Настройка инструментов">{renderActions(snapshot.actions.filter(a => a.group === 'setup' && (a.id === 'quality-setup' || a.id === 'ci-setup')))}</Disclosure>
        <ToolsSection actions={snapshot.actions.filter(a => a.group === 'setup' && toolHelp[a.id])} renderAction={renderAction} />
      </>}

      {(!delegation || view === 'settings') && <details id={updatesId} ref={updatesDetails} className="aif-details aif-disclosure" onToggle={event => setUpdatesOpen(event.currentTarget.open)}>
        <summary>Версии и расширения{snapshot.extensions.length ? ` · ${snapshot.extensions.length}` : ''}</summary>
        <div className="aif-disclosure-body">
        {delegation && versionsLine}
        {renderActions(updates)}
        {snapshot.versionsCheckedAt && <p className="m-0 text-xs text-muted-foreground">Версии CLI/Git: снимок от {new Date(snapshot.versionsCheckedAt).toLocaleString('ru')}. Плановая проверка — раз в сутки.</p>}
        <dl className="m-0 grid grid-cols-[minmax(96px,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-xs [&_dd]:m-0 [&_dt]:text-muted-foreground [&_small]:block [&_small]:text-muted-foreground">
          <dt>Глобальный CLI</dt><dd>{snapshot.versions.globalCli ?? 'Не найден'}{snapshot.versions.globalSource && <small>{snapshot.versions.globalSource}</small>}</dd>
          <dt>Установка проекта</dt><dd>{snapshot.versions.installed ?? 'Не указана'} · {snapshot.runtime}</dd>
          <dt>Исходники Git</dt><dd>{snapshot.versions.sourceVersion ?? 'Checkout не задан'}{snapshot.versions.sourceSha && <small>{snapshot.versions.sourceSha}</small>}
            {snapshot.versions.sourceWorktreeVersion && snapshot.versions.sourceWorktreeVersion !== snapshot.versions.sourceVersion && <small>Рабочее дерево: {snapshot.versions.sourceWorktreeVersion}</small>}</dd>
          <dt>Git upstream</dt><dd>{snapshot.upstream.version ?? 'Не проверен'}{snapshot.upstream.ref && ` · ${snapshot.upstream.ref} @${snapshot.upstream.sha?.slice(0, 7)}`}
            {snapshot.upstream.checkedAt && <small>Проверено {new Date(snapshot.upstream.checkedAt).toLocaleString()}</small>}{snapshot.upstream.error && <small>{snapshot.upstream.error}</small>}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Hint text={nextVersionCheck > Date.now() ? `Следующая проверка доступна ${new Date(nextVersionCheck).toLocaleString('ru')}` : 'Проверить upstream; результат сохраняется на сутки'}><Button type="button" variant="outline" size="sm" disabled={network || nextVersionCheck > Date.now()}
            onClick={async () => { setNetwork(true); try { await refresh(true); } finally { if (mounted.current) setNetwork(false); } }}><Icon name="RefreshCw" className="size-3.5" aria-hidden="true" />{network ? 'Проверяю GitHub…' : 'Проверить версию в GitHub'}</Button></Hint>
          {nextVersionCheck > Date.now() && <span className="text-xs text-muted-foreground">Следующая проверка GitHub — {new Date(nextVersionCheck).toLocaleString('ru')}.</span>}
        </div>
        {snapshot.extensions.length ? <ul className="m-0 flex list-none flex-col gap-3 p-0 text-xs">{snapshot.extensions.map(e => <li key={e.name}><strong className="font-medium">{e.name}</strong> {e.installedVersion ?? 'файлы отсутствуют'} <span className="text-muted-foreground">· {e.state}</span>
          <small className="block text-muted-foreground">Записано: {e.recordedVersion ?? 'не указано'} · {e.source}</small>{e.contributions.length > 0 && <small className="block text-muted-foreground">Настроенные injections: {e.contributions.join(', ')}. Это не подтверждение загрузки в текущую сессию.</small>}</li>)}</ul>
          : <p className="m-0 text-xs text-muted-foreground">Расширения не зарегистрированы в этом проекте.</p>}
        </div>
      </details>}
      {snapshot.diagnostics.length > 0 && <Disclosure className="aif-disclosure" summary={`Примечания · ${snapshot.diagnostics.length}`}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs text-muted-foreground">{snapshot.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </Disclosure>}
      <footer className="aif-footer">
        <span className="aif-footer-source">
          <Icon name="Clock" className="aif-button-icon" aria-hidden="true" />
          <span>{snapshot.cache?.source === 'saved' ? 'Сохранённые данные' : snapshot.cache?.source === 'memory' ? 'Данные из кэша' : 'Локальный статус'}</span>
          <time dateTime={snapshot.collectedAt}>{new Date(snapshot.collectedAt).toLocaleTimeString()}</time>
        </span>
        {snapshot.cache?.refreshing && <span>Обновляются в фоне…</span>}
        {snapshot.cache?.refreshError && <span>Обновление не удалось. Нажмите ↻ для повторного чтения.</span>}
        {busy && <span>{snapshot.pendingConfirmation || snapshot.pendingQuestions ? 'Действия доступны после ответа пользователя' : 'Действия доступны после завершения работы'}</span>}
      </footer>
    </>}
  </section>;
}

const childStatus: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'в очереди', tone: 'idle' }, starting: { label: 'запускается', tone: 'live' }, active: { label: 'работает', tone: 'live' },
  stopping: { label: 'останавливается', tone: 'live' }, idle: { label: 'готово', tone: 'done' }, error: { label: 'ошибка', tone: 'error' },
};
const toPicker = (c: Extract<DelegationChoice, { mode: 'bb' }>): PickerValue =>
  ({ providerId: c.providerId, model: c.model, reasoningLevel: (c.reasoning ?? 'medium') as PickerValue['reasoningLevel'], ...(c.tier ? { serviceTier: c.tier as PickerValue['serviceTier'] } : {}) });
const fromPicker = (v: PickerValue): DelegationChoice =>
  ({ mode: 'bb', providerId: v.providerId, model: v.model, ...(v.reasoningLevel ? { reasoning: v.reasoningLevel } : {}), ...(v.serviceTier && v.serviceTier !== 'default' ? { tier: v.serviceTier } : {}) });
// Starting point for the picker; it immediately reconciles to a real model from the live catalog.
const pickerSeed: PickerValue = { providerId: 'codex', model: '', reasoningLevel: 'high' as PickerValue['reasoningLevel'] };

const roleText = {
  implement: { title: 'Код', group: 'Кто пишет код',
    saved: '/aif-implement будет передавать задачи выбранной модели.', self: 'Код снова пишет агент этого чата.',
    note: 'Хранится в .ai-factory.json → phases.implement. /aif-implement отдаёт каждую задачу дочернему треду на этой модели, затем сам проверяет diff и отмечает задачу в плане.' },
  research: { title: 'Разведчик 1', group: 'Кто исследует код',
    saved: 'Разведчики AI Factory будут запускаться дочерними тредами на выбранной модели.', self: 'Разведку снова делают встроенные помощники агента.',
    note: 'Работает в /aif-plan, /aif-fix, /aif-qa. Разведчик 1 — архитектура и затронутые модули; если навык просит одного разведчика, это он. Хранится в .ai-factory/skill-context/global-skill-context.md. Разведчики идут дочерними тредами параллельно, агент собирает их отчёты.' },
  research2: { title: 'Разведчик 2', group: 'Кто ищет шаблоны',
    saved: 'Разведчик 2 будет работать на выбранной модели.', self: 'Разведчик 2 снова работает как разведчик 1.',
    selfLabel: 'Как разведчик 1', selfBadge: 'как разведчик 1', note: 'Ищет шаблоны и соглашения в коде.' },
  research3: { title: 'Разведчик 3', group: 'Кто ищет связи',
    saved: 'Разведчик 3 будет работать на выбранной модели.', self: 'Разведчик 3 снова работает как разведчик 1.',
    selfLabel: 'Как разведчик 1', selfBadge: 'как разведчик 1', note: 'Ищет зависимости и связи. Разведчик 3 берёт и всех следующих, если навык просит больше трёх.' },
} as const satisfies Record<DelegationRole, { title: string; group: string; saved: string; self: string; note: string; selfLabel?: string; selfBadge?: string }>;

const PARALLEL_HELP = 'Независимые задачи плана идут одновременно, каждая в своей копии проекта на этой модели. Между группами координатор делает локальный коммит без push. Задачи, которые правят один и тот же файл, всё равно идут по очереди, поэтому план ускоряется не всегда.';

/** One-line role row; the «Этот агент / Другая модель» editor opens on «Изменить» and saves through setDelegation. */
function ModelChoice({ role, saved, providerName, environmentId, busy, locked: lockedOuter, onSave }: {
  role: DelegationRole; saved: DelegationChoice; providerName: (id: string | null) => string | null; environmentId: string | null; busy: boolean; locked: boolean;
  onSave: (choice: DelegationChoice) => Promise<void>;
}) {
  const text: { title: string; group: string; saved: string; self: string; note: string; selfLabel?: string; selfBadge?: string } = roleText[role];
  const [editing, setEditing] = useState(false);
  const [help, setHelp] = useState(false);
  const [parallelHelp, setParallelHelp] = useState(false);
  const [mode, setMode] = useState<'self' | 'bb'>(saved.mode);
  const [pick, setPick] = useState<PickerValue | null>(saved.mode === 'bb' ? toPicker(saved) : null);
  const [saving, setSaving] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => { setMode(saved.mode); setPick(saved.mode === 'bb' ? toPicker(saved) : null); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked: DelegationChoice | null = mode === 'self' ? { mode: 'self' } : pick?.model ? fromPicker(pick) : null;
  const choice: DelegationChoice | null = picked?.mode === 'bb' && role === 'implement' && saved.mode === 'bb' && saved.parallel ? { ...picked, parallel: saved.parallel } : picked;
  const dirty = !!choice && JSON.stringify(choice) !== savedKey;
  const locked = saving || lockedOuter;
  const savedLabel = saved.mode === 'bb' ? [providerName(saved.providerId), saved.model, saved.reasoning].filter(Boolean).join(' · ') : text.selfBadge ?? 'агент этого чата';
  const parallel = saved.mode === 'bb' ? saved.parallel ?? null : null;
  async function save() {
    if (!choice) return;
    setSaving(true);
    try { await onSave(choice); toast.success(choice.mode === 'bb' ? text.saved : text.self); setEditing(false); }
    finally { setSaving(false); }
  }
  function cancel() {
    setMode(saved.mode); setPick(saved.mode === 'bb' ? toPicker(saved) : null); setEditing(false);
  }
  function setParallel(n: number | null) {
    if (saved.mode !== 'bb' || role !== 'implement' || locked || busy || (saved.parallel ?? null) === n) return;
    if (n === null) { const { parallel: _p, ...rest } = saved; void onSave(rest); return; }
    void onSave({ ...saved, parallel: n });
  }
  return <div className="flex min-w-0 flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
    {/* Stretched button: the whole row opens the editor, while «?» sits right after the title without nesting buttons. */}
    <div className={cn('relative flex min-h-11 min-w-0 items-center gap-2', locked && 'opacity-60')}>
      <button type="button" aria-label={`Изменить: ${text.title}`} aria-expanded={editing} disabled={locked}
        onClick={() => (editing ? cancel() : setEditing(true))}
        className="absolute -inset-x-1 inset-y-0 cursor-pointer rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default" />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{text.title}{text.note && <span className="pointer-events-auto relative z-10">
          <HelpMark label={`Подробнее: ${text.title}`} open={help} onToggle={() => setHelp(!help)} /></span>}</span>
        <span className="block truncate text-xs text-muted-foreground">{savedLabel}</span>
      </span>
      <Icon name="ChevronRight" className={cn('pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform', editing && 'rotate-90')} />
    </div>
    {role === 'implement' && saved.mode === 'bb' && !editing && <div className="flex min-h-11 flex-col justify-center gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">Параллельно<HelpMark label="Подробнее: Параллельно" open={parallelHelp} onToggle={() => setParallelHelp(!parallelHelp)} /></span>
        <div className="flex gap-1" role="group" aria-label="Параллельность">
          {([['Выкл', null], ['2', 2], ['3', 3], ['4', 4]] as const).map(([label, n]) =>
            <Button key={label} type="button" size="sm" variant={parallel === n ? 'secondary' : 'outline'} aria-pressed={parallel === n} disabled={locked || busy} onClick={() => setParallel(n)}>{label}</Button>)}
        </div>
      </div>
      {parallelHelp && <p className="m-0 text-xs text-muted-foreground">{PARALLEL_HELP}</p>}
    </div>}
    {help && text.note && <p className="m-0 text-xs text-muted-foreground">{text.note}</p>}
    {editing && <>
      <div role="radiogroup" aria-label={text.group} className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
        {(['self', 'bb'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={locked}
          onClick={() => { setMode(m); if (m === 'bb' && !pick) setPick(pickerSeed); }}
          className={cn('h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
            mode === m ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{m === 'self' ? text.selfLabel ?? 'Этот агент' : 'Другая модель'}</button>)}
      </div>
      {mode === 'bb' && pick && <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Провайдер и модель</span>
        <ProviderModelPicker value={pick} onChange={setPick} disabled={locked} align="start"
          routing={environmentId ? { kind: 'environment', environmentId } : undefined} className="max-w-full" />
      </div>}
      <div className="flex flex-wrap gap-2">
        <Hint text={busy ? 'Дождитесь, пока агент закончит текущую работу' : 'Сохранить выбор в проекте'}><Button type="button" size="sm" disabled={locked || busy || !dirty} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</Button></Hint>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={cancel}>Отменить</Button>
      </div>
    </>}
  </div>;
}

function useDelegationView(threadId: string) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'delegation', input: { threadId } });
  // A write answers with the new view at once; the tagged read replaces it when it lands.
  const [written, setView] = useState<DelegationView | null>(null);
  const [actionError, setError] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const appliedRef = useRef<string | null>(null);
  useEffect(() => { setView(null); }, [query.data]);
  useEffect(() => {
    const next = query.data?.appliedDefaults;
    if (!next || appliedRef.current === next) return;
    appliedRef.current = next;
    setApplied(next);
    toast.success(next);
  }, [query.data?.appliedDefaults]);
  const view = written ?? query.data ?? null;
  const error = actionError || (query.error ? query.error.message : '');
  return { view, setView, error, setError, load: query.refetch, applied };
}

function DelegationSection({ threadId, environmentId, busy }: { threadId: string; environmentId: string | null; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const { view, setView, error, setError, applied } = useDelegationView(threadId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!view) return <Section label="Исполнители" title="Исполнители">
    {error ? <p className="m-0 text-xs text-muted-foreground">Настройка недоступна: {error}</p> : <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" />}
  </Section>;
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  const save = (role: DelegationRole) => async (choice: DelegationChoice) => {
    setError('');
    try {
      const next = await rpc.call('setDelegation', { threadId, choice, role });
      if (mounted.current) setView(next);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); throw e; }
  };
  const changeDefaults = async (action: 'from-project' | 'apply' | 'clear') => {
    setError('');
    try {
      const next = await rpc.call('setDelegationDefaults', { threadId, action });
      if (mounted.current) setView(next);
      toast.success(action === 'from-project' ? 'Умолчания взяты из этого проекта' : action === 'apply' ? 'Умолчания применены к этому проекту' : 'Умолчания очищены');
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  return <Section label="Исполнители" title="Исполнители">
    {applied && <Callout role="status">{applied}</Callout>}
    {view.foreign && <Callout>phases.implement в .ai-factory.json настроен на агента «{view.foreign}». Панель его не меняет.</Callout>}
    {view.error && <Callout tone="error">{view.error}</Callout>}
    <div className="flex min-w-0 flex-col divide-y divide-border">
      <ModelChoice role="implement" saved={view.choice} providerName={providerName} environmentId={environmentId} busy={busy} locked={!!view.foreign} onSave={save('implement')} />
      <ModelChoice role="research" saved={view.research} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research')} />
      <ModelChoice role="research2" saved={view.research2} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research2')} />
      <ModelChoice role="research3" saved={view.research3} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research3')} />
    </div>
    <DefaultsSection view={view} busy={busy} onChange={changeDefaults} />
    {error && <Callout tone="error" role="status">{error}</Callout>}
  </Section>;
}

type DefaultsAction = 'from-project' | 'apply' | 'clear';

/** Plugin-wide default executor models for new AI Factory projects; the owner picks them from a real project's settings. */
function DefaultsSection({ view, busy, onChange }: { view: DelegationView; busy: boolean; onChange: (action: DefaultsAction) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  const label = (role: DelegationRole) => {
    const choice = view.defaults?.[role];
    if (!choice) return '';
    return choice.mode === 'bb' ? [providerName(choice.providerId), choice.model, choice.reasoning].filter(Boolean).join(' · ') : (roleText[role] as { selfBadge?: string }).selfBadge ?? 'агент этого чата';
  };
  async function act(action: DefaultsAction) {
    if (pending || busy) return;
    setPending(true);
    try { await onChange(action); } finally { setPending(false); }
  }
  return <Disclosure summary={<>Модели по умолчанию для новых проектов <span className="font-normal text-muted-foreground"> · {view.defaults ? 'заданы' : 'не заданы'}</span></>}>
    <p className="m-0 text-xs text-muted-foreground">Применяются один раз в проекте с AI Factory, где у всех ролей «Этот агент». Дальше проект живёт своей настройкой.</p>
    {view.defaults && <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {(Object.keys(roleText) as DelegationRole[]).map(role => <li key={role}>{roleText[role].title} — {label(role)}</li>)}
    </ul>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={() => void act('from-project')}>Взять из этого проекта</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || busy || !view.defaults} onClick={() => void act('apply')}>Применить к этому проекту</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || busy || !view.defaults} onClick={() => void act('clear')}>Очистить</Button>
    </div>
  </Disclosure>;
}

function useChipScoringView(threadId: string) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'chipScoring', input: {} });
  const [written, setView] = useState<ChipScoringView | null>(null);
  const [actionError, setError] = useState('');
  useEffect(() => { setView(null); }, [query.data]);
  const view = written ?? query.data ?? null;
  const error = actionError || (query.error ? query.error.message : '');
  return { view, setView, error, setError };
}

const CHIP_SCORING_HELP = 'Плагин отправляет последний ответ агента и список кнопок в Google Gemini Decisions и показывает вероятность каждой кнопки. Ответ может содержать пути и код проекта. Ключ API берётся из Env Catalog или вводится вручную; значение ключа во вкладку не попадает.';

/** Plugin-wide Gemini Decisions scoring: toggle, key source and status. The key value never reaches the tab. */
function ChipScoringSection({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { view, setView, error, setError } = useChipScoringView(threadId);
  const [help, setHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualKey, setManualKey] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!view) return <Section label="Оценка кнопок" title="Оценка кнопок">
    {error ? <p className="m-0 text-xs text-muted-foreground">Настройка недоступна: {error}</p> : <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" />}
  </Section>;
  const source = view.catalogAvailable ? view.source : 'manual';
  const save = async (input: { enabled?: boolean; source?: 'catalog' | 'manual'; catalogName?: string | null; manualKey?: string | null }) => {
    if (saving) return false;
    setSaving(true); setError('');
    try {
      const next = await rpc.call('setChipScoring', input);
      if (mounted.current) setView(next);
      return true;
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { if (mounted.current) setSaving(false); }
  };
  const radioClass = (on: boolean) => cn('h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
    on ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground');
  return <Section label="Оценка кнопок" title="Оценка кнопок">
    <div className="flex min-w-0 flex-col divide-y divide-border">
      <div className="flex min-h-11 flex-col justify-center gap-1 py-2.5 first:pt-0">
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Gemini Decisions<HelpMark label="Что отправляется в Google" open={help} onToggle={() => setHelp(!help)} /></span>
            <span className="text-xs text-muted-foreground">Проценты вероятности на кнопках-подсказках</span>
          </span>
          <Button type="button" size="sm" variant={view.enabled ? 'default' : 'outline'} aria-pressed={view.enabled} disabled={saving}
            onClick={() => void save({ enabled: !view.enabled })}>{view.enabled ? 'Вкл' : 'Выкл'}</Button>
        </div>
        {help && <p className="m-0 text-xs text-muted-foreground">{CHIP_SCORING_HELP}</p>}
      </div>
      {view.enabled && <>
        {view.catalogAvailable && <div className="py-2.5">
          <div role="radiogroup" aria-label="Источник ключа" className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
            {(['catalog', 'manual'] as const).map(s => <button key={s} type="button" role="radio" aria-checked={source === s} disabled={saving}
              onClick={() => void save({ source: s })} className={radioClass(source === s)}>{s === 'catalog' ? 'Из Env Catalog' : 'Ввести вручную'}</button>)}
          </div>
        </div>}
        {source === 'catalog' ? <div className="py-2.5">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Ключ из Env Catalog
            <select aria-label="Ключ из Env Catalog" value={view.catalogName ?? ''} disabled={saving}
              onChange={e => void save({ catalogName: e.target.value || null })}
              className="h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <option value="">Выберите ключ</option>
              {view.catalogNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
        </div> : <div className="flex flex-col gap-2 py-2.5">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Ключ Gemini API
            <input type="password" autoComplete="off" value={manualKey} disabled={saving}
              onChange={e => setManualKey(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" /></label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={saving || !manualKey.trim()}
              onClick={async () => { if (await save({ manualKey })) setManualKey(''); }}>Сохранить</Button>
            {view.manualKeySet && <Button type="button" size="sm" variant="outline" disabled={saving}
              onClick={() => void save({ manualKey: null })}>Удалить ключ</Button>}
          </div>
        </div>}
        {(source === 'manual' && view.manualKeySet) || typeof view.lastScoredAt === 'number' ? <div className="flex flex-col gap-1 py-2.5 text-xs text-muted-foreground">
          {source === 'manual' && view.manualKeySet && <span>Ключ задан</span>}
          {typeof view.lastScoredAt === 'number' && <span>Последняя оценка: {new Date(view.lastScoredAt).toLocaleTimeString('ru-RU')}</span>}
        </div> : null}
      </>}
    </div>
    {view.lastError && <Callout>{view.lastError}</Callout>}
    {error && <Callout tone="error" role="status">{error}</Callout>}
  </Section>;
}

function WorkingSection({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { view } = useDelegationView(threadId);
  const surface = useSurface();
  if (!view || view.children.length === 0) return null;
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  return <Section label="В работе" title="В работе">
    <ul className={cn('m-0 flex list-none flex-col divide-y divide-border p-0', surface === 'card' && 'rounded-md border border-border')}>{view.children.map(c => {
      const st = childStatus[c.status] ?? { label: c.status, tone: 'idle' as const };
      return <li key={c.id} className={cn('grid min-h-11 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 py-2', surface === 'card' && 'px-3')}>
        <StatusDot tone={st.tone} />
        <span className="min-w-0"><span className="block truncate">{c.title || 'Без названия'}</span>
          <span className="block truncate text-xs text-muted-foreground" title="Модель, с которой BB запустил ход. Подмену провайдером BB видит только у Claude Code">
            {[providerName(c.providerId), c.execution && [c.execution.model, c.execution.reasoning].filter(Boolean).join(' · '), st.label].filter(Boolean).join(' · ')}</span>
          {c.worktree && <Badge variant="secondary" className="mt-0.5 w-fit px-1.5 py-0 text-[10px] font-normal">отдельная копия</Badge>}
          {c.fallback && <span className="block text-xs text-amber-600 dark:text-amber-400">⚠ Подмена: {c.fallback.from} → {c.fallback.to} ({c.fallback.reason === 'refusal' ? 'отказ модели' : 'провайдер'})</span>}
          {c.mismatch && <span className="block text-xs text-amber-600 dark:text-amber-400">⚠ {c.mismatch}</span>}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => navigate.toThread(c.id, { split: true })}>
          Открыть<Icon name="ExternalLink" className="size-3.5" /></Button>
      </li>;
    })}</ul>
  </Section>;
}

/** Optional AI Factory commands that are not part of readiness: docs, roadmap, rules, build, docker, archive. */
function ToolsSection({ actions, renderAction }: { actions: Action[]; renderAction: (action: Action) => ReactNode }) {
  const [help, setHelp] = useState<string | null>(null);
  if (!actions.length) return null;
  return <Disclosure className="aif-tools" summary="Другие команды">
    <p className="m-0 text-xs text-muted-foreground">По необходимости, в любом порядке. Кнопка отправляет команду в этот чат.</p>
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{actions.map(a => <li key={a.id} className="flex flex-col gap-1">
      <span className="flex items-center">{renderAction(a)}<HelpMark label={`Что делает «${a.label}»`} open={help === a.id} onToggle={() => setHelp(help === a.id ? null : a.id)} /></span>
      {help === a.id && <p className="m-0 rounded-md bg-muted px-3 py-2 text-xs">{toolHelp[a.id]}</p>}
    </li>)}</ul>
  </Disclosure>;
}

function ReadinessSection({ snapshot, run, busy, sending, setReadinessSkip }: {
  snapshot: Snapshot; run: (action: Action) => void; busy: boolean; sending: boolean;
  setReadinessSkip: (stepId: SkippableStepId, skipped: boolean) => Promise<void>;
}) {
  const [pendingSkip, setPendingSkip] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const steps = snapshot.readiness;
  const next = nextReadinessStep(steps);
  const actionFor = (s: ReadinessStep) => snapshot.actions.find(a => a.id === s.actionId);
  const iconFor = (s: ReadinessStep) => s.state === 'done' ? 'CircleCheck' : s.state === 'skipped' ? 'CircleDashed' : 'Circle';
  const stateLabel = (s: ReadinessStep) => s.state === 'done' ? 'Выполнен' : s.state === 'skipped' ? 'Пропущен' : 'Ожидает очереди';
  async function toggleSkip(s: ReadinessStep, skipped: boolean) {
    if (pendingSkip) return;
    setPendingSkip(s.id);
    try { await setReadinessSkip(s.id as SkippableStepId, skipped); }
    finally { setPendingSkip(null); }
  }
  function stepRow(s: ReadinessStep, n: number, isNext: boolean) {
    const action = s.state === 'todo' ? actionFor(s) : undefined;
    const small = 'h-7 px-2.5 text-xs';
    const toggleHelp = () => setHelp(help === s.id ? null : s.id);
    const skip = s.state === 'skipped'
      ? <Button type="button" size="sm" variant="ghost" className={cn(small, 'shrink-0 text-muted-foreground')} aria-label={`Вернуть: ${s.label}`} disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, false)}>Вернуть</Button>
      : s.skippable && s.state === 'todo'
        ? <Button type="button" size="sm" variant="ghost" className={cn(small, 'shrink-0 text-muted-foreground')} aria-label={`Пропустить: ${s.label}`} disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, true)}>Пропустить</Button>
        : null;
    return <li key={s.id} className="flex min-h-11 flex-col justify-center py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name={iconFor(s)} aria-label={stateLabel(s)} className={cn('size-4 shrink-0', s.state === 'done' ? 'text-primary' : 'text-muted-foreground')} />
        <span className="min-w-[9rem] flex-1 text-sm">
          <button type="button" aria-expanded={help === s.id} onClick={toggleHelp}
            className={cn('cursor-pointer text-left [overflow-wrap:normal] break-words', s.state === 'todo' ? 'font-medium' : 'text-muted-foreground')}>
            <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{n}.</span>{s.label}
          </button>
          {readinessHelp[s.id] && <HelpMark label={`Что делает шаг «${s.label}»`} open={help === s.id} onToggle={toggleHelp} />}
        </span>
        {(skip || action) && <span className="ml-auto flex shrink-0 items-center gap-1">{skip}
        {action && <Hint text={`${action.reason}\n${action.command}`}><Button type="button" size="sm" variant={isNext ? 'default' : 'outline'} className={cn(small, 'shrink-0')}
          aria-label={`Запустить: ${s.label}`} disabled={sending || busy || !action.available} onClick={() => void run(action)}>Запустить</Button></Hint>}</span>}
      </div>
      {help === s.id && <div className="ml-6 rounded-md bg-muted px-3 py-2 text-xs">
        <p className="m-0">{readinessHelp[s.id]}</p>
        {s.state === 'todo' && s.missing.length > 0 && !s.anyOf && <p className="m-0 mt-1 break-words text-muted-foreground">Не найдено: {s.missing.join(', ')}</p>}
      </div>}
    </li>;
  }
  const numbered = steps.map((s, i) => ({ s, n: i + 1 }));
  const rows = (items: typeof numbered) => <ol className="m-0 flex list-none flex-col divide-y divide-border p-0">{items.map(({ s, n }) => stepRow(s, n, next?.id === s.id))}</ol>;
  if (readinessComplete(steps)) return <div id="aif-readiness"><Disclosure summary="Проект готов к работе через AI Factory">{rows(numbered)}</Disclosure></div>;
  const core = readinessCoreComplete(steps);
  const finished = numbered.filter(({ s }) => s.state !== 'todo');
  const doneCount = finished.filter(({ s }) => s.state === 'done').length, skippedCount = finished.length - doneCount;
  return <Section id="aif-readiness" label="Подготовка проекта" title="Подготовка проекта" highlight={!core}>
    <p className="m-0 text-xs text-muted-foreground">{core ? 'Основное готово. Остальные шаги — по желанию, их можно пропустить' : 'Первые три шага нужны, чтобы AI Factory заработал. Выполните их по порядку'}</p>
    {finished.length > 0 && <Disclosure className="aif-readiness-finished" summary={<span className="text-sm font-normal text-muted-foreground">
      Выполнено · {doneCount}{skippedCount ? ` · пропущено · ${skippedCount}` : ''}</span>}>{rows(finished)}</Disclosure>}
    {rows(numbered.filter(({ s }) => s.state === 'todo'))}
  </Section>;
}

function Directive(props: PluginMessageDirectiveProps) {
  // Legacy directives have no identity; hide their historical output as well.
  const cardId = cardIdSchema.safeParse(props.attributes.card);
  if (!cardId.success) return null;
  const parsed = phaseSchema.safeParse(props.attributes.phase ?? 'unknown');
  if (!parsed.success || (props.attributes.target?.length ?? 0) > 1000) return <p className="aif-error">Некорректная карточка AI Factory.</p>;
  return <InlineCard key={`${props.message.threadId}:${cardId.data}`} cardId={cardId.data} threadId={props.message.threadId}
    initialTarget={props.attributes.target ?? ''} phase={parsed.data} openFile={props.openWorkspaceFile} />;
}
type InlineCardProps = { cardId: string; threadId: string; initialTarget: string; phase: Phase; openFile: PluginMessageDirectiveProps['openWorkspaceFile'] };
function InlineCard(props: InlineCardProps) {
  // Once superseded, the visibility query unmounts for good: an old card makes no further reads.
  const [superseded, setSuperseded] = useState(false);
  const retire = useCallback(() => setSuperseded(true), []);
  return superseded ? null : <CardVisibility {...props} onSuperseded={retire} />;
}
function CardVisibility({ cardId, threadId, initialTarget, phase, openFile, onSuperseded }: InlineCardProps & { onSuperseded: () => void }) {
  // A failed answer hides the card but keeps the query, so a later tag invalidation brings it back.
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'cardVisibility', input: { threadId, cardId } });
  const state = query.error ? null : query.data?.state;
  useEffect(() => { if (state === 'superseded') onSuperseded(); }, [state, onSuperseded]);
  return state === 'current' ? <WorkflowCard threadId={threadId} initialTarget={initialTarget} phase={phase} openFile={openFile} inline /> : null;
}
function ContextCard({ threadId }: ExperimentalThreadContextCardProps) { return <WorkflowCard threadId={threadId} compact />; }
function WorkflowPanel({ threadId, environment }: ExperimentalThreadTabProps) { return <SurfaceProvider value="panel"><div className="aif-panel h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain bg-muted/40 @container/aif px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"><WorkflowCard key={threadId} threadId={threadId} environmentId={environment?.id ?? null} compact delegation /></div></SurfaceProvider>; }
function SuggestedCommands() {
  const composer = useComposer();
  return composer.scope.kind === 'thread' ? <SuggestionBar key={composer.scope.threadId} threadId={composer.scope.threadId} composer={composer} composerBusy={composer.isRunning || composer.isSubmitting} /> : null;
}
function SuggestionBar({ threadId, composer, composerBusy }: { threadId: string; composer: PluginComposerApi; composerBusy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'suggestions', input: { threadId } });
  const data: Suggestions | null = query.data ?? null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const operation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function act(id: string, dismiss: boolean) {
    if (!data || operation.current) return;
    operation.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const input = { threadId, sourceKey: data.sourceKey, commandId: id };
      if (dismiss) await rpc.call('dismissSuggestion', input);
      else {
        const result = await rpc.call('runSuggestion', { ...input, fingerprint: data.fingerprint, requestId: crypto.randomUUID() });
        if (result.stale || !result.command) { if (mounted.current) setNotice(result.message); return; }
        const next = chipDraft(composer.draft, result.command, id);
        composer.replace({ text: next.text, mentions: next.mentions });
        if (next.submit) await composer.submit({ experimental_mode: 'queue-if-active', experimental_data: result.data ?? null });
        else composer.focus();
        await rpc.call('dismissSuggestion', input);
        if (mounted.current && !next.submit) setNotice(result.message);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { await query.refetch(); operation.current = false; if (mounted.current) setWorking(false); }
  }
  const busy = composerBusy || !!data && !['idle', 'error'].includes(data.threadState);
  if (!data?.items.length && !data?.gate && !data?.gateError && !error && !notice) return null;
  return <section className="aif-suggestions" aria-label="Команды из последнего ответа агента">
    {(data?.gate || data?.gateError) && <div className={`aif-message-gate${data.gate?.blocking || data.gateError ? ' aif-message-gate-blocking' : ''}`} role="group" aria-label="Gate из последнего ответа">
      {data.gate && <><div className="aif-message-gate-heading"><strong>{data.gate.gate} · {data.gate.status.toUpperCase()} в ответе</strong><span>{data.gate.blocking ? 'Блокирует следующий этап' : data.gateWarning ? 'Переход не подтверждён' : 'Не блокирует'}</span></div>
        <p className="aif-muted aif-small">Заявленный результат из чата. Актуальность отчёта для текущих файлов проверяет владелец workflow.</p>
        {data.gate.blockers.length ? <details open><summary>Блокирующие проблемы · {data.gate.blockers.length}</summary><ul>{data.gate.blockers.map((b, i) => <li key={`${b.id}-${i}`}><strong>{b.id}</strong> <span className="aif-muted">· {b.severity}</span><p>{b.summary}</p>{b.file && <code>{b.file}</code>}</li>)}</ul></details> : <p className="aif-small">Блокирующих проблем нет.</p>}
        {data.gate.suggested_next?.reason && <p className="aif-small"><strong>{data.gate.suggested_next.command ? 'Следующий шаг: ' : 'Пояснение: '}</strong>{data.gate.suggested_next.reason}</p>}
        {!!data.gate.affected_files.length && <details><summary>Затронутые файлы · {data.gate.affected_files.length}</summary><ul>{data.gate.affected_files.map((file, i) => <li key={i}><code>{file}</code></li>)}</ul></details>}
      </>}
      {data.gateError && <p className="aif-error" role="alert">Некорректный gate: {data.gateError}</p>}
      {data.gateWarning && <p className="aif-muted aif-small" role="note">Формат ответа: {data.gateWarning}</p>}
    </div>}
    {!!data?.items.length && (() => {
      const scored = data.items.some(i => typeof i.probability === 'number');
      const items = scored ? [...data.items].sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1)) : data.items;
      const topId = scored ? items[0].id : null;
      return <><span className="aif-suggestions-label">{data.origin === 'plan' ? 'Следующий шаг по плану' : 'Из ответа агента'}</span><div className="aif-suggestion-list">{items.map(item => {
        const pct = typeof item.probability === 'number' ? chipPercent(item.probability) : null;
        const text = item.label ?? item.command;
        const label = `${pct ? `${pct} ` : ''}${text}`;
        // "Применить всё" answers the agent's own question: it may run while the thread waits for input, and the server sends it.
        const approval = item.kind === 'improve-approval';
        const enabled = !working && item.available && (approval ? !composerBusy && data.threadState === 'awaiting_input' : !busy);
        // Only a chip that can run takes the draft along; the server-sent approval never touches it.
        const takesDraft = enabled && !approval && !composer.isEmpty;
        return <div className="aif-suggestion-entry" key={item.id}><div className={cn('aif-suggestion', item.id === topId && 'aif-suggestion-top')}>
          <button type="button" className="aif-suggestion-run" disabled={!enabled}
            title={approval ? item.reason : busy ? 'Дождитесь завершения текущей работы' : takesDraft ? `${item.command} + ваш текст из поля` : `${item.command}\n${item.reason}`}
            aria-label={takesDraft ? `${label} + ваш текст из поля` : pct ? label : undefined}
            onClick={() => void act(item.id, false)}><ActionIcon id={approval ? 'apply-improvements' : item.id} command={item.command} />{pct && <span className="aif-suggestion-score">{pct}</span>}<span className="aif-suggestion-command">{text}</span></button>
          <button type="button" className="aif-suggestion-dismiss" disabled={working} aria-label={`Удалить предложение ${text}`} title="Убрать из предложений этого ответа" onClick={() => void act(item.id, true)}>×</button>
        </div>{!item.available && <p className="aif-suggestion-reason" role="note">{item.reason}</p>}</div>;
      })}</div></>;
    })()}
    {error && <p className="aif-error" role="alert">{error}</p>}
    {notice && <p className="aif-muted aif-small" role="status">{notice}</p>}
  </section>;
}
const isAifPill = (m: { kind?: string; provider?: string; id?: string }) =>
  m.kind === 'plugin' && m.provider === AIF_MENTION.provider && m.id === AIF_MENTION.id;

/** Drop our mode pill(s) from the draft, shifting later mentions left. */
function removeAifPill(composer: PluginComposerApi) {
  composer.replace(current => {
    const pills = current.mentions.filter(isAifPill).sort((a, b) => a.from - b.from);
    if (!pills.length) return current;
    let text = '';
    let pos = 0;
    for (const m of pills) { text += current.text.slice(pos, m.from); pos = Math.max(pos, m.to); }
    text += current.text.slice(pos);
    const shift = (at: number) => pills.reduce((n, m) => n + (m.to <= at ? m.to - m.from : m.from < at ? at - m.from : 0), 0);
    return { text, mentions: current.mentions.filter(m => !isAifPill(m)).map(m => ({ ...m, from: m.from - shift(m.from), to: m.to - shift(m.to) })) };
  });
}

const aifModeInput = (threadId: string | null, projectId: string | null) => threadId ? { threadId } : projectId ? { projectId } : {};

/** Composer action: toggles the project-wide AI Factory mode; opens the tab when the project has no AI Factory. */
function FactoryIcon({ className = 'size-4' }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
    <path d="M3 21V11l5 3V11l5 3V11l5 3V4h3v17z" /><path d="M7 18h2M12 18h2" />
  </svg>;
}

function AifModeAction() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const panel = experimental_useAppPanel();
  const threadId = composer.scope.kind === 'thread' ? composer.scope.threadId : null;
  const projectId = composer.scope.kind === 'new-thread' ? composer.scope.projectId : null;
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'aifMode', input: aifModeInput(threadId, projectId), enabled: !!threadId || !!projectId });
  const [written, setView] = useState<{ on: boolean; configured: boolean | null; projectId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setView(null); }, [query.data]);
  const view = threadId || projectId ? written ?? query.data ?? null : null;
  const error = actionError || (query.error ? query.error.message : '');
  async function toggle() {
    if (pending || !view) return;
    if (threadId && view.configured === false) {
      panel.openTab({ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } });
      return;
    }
    const input = threadId ? { threadId, on: !view.on } : projectId ? { projectId, on: !view.on } : null;
    if (!input) return;
    setPending(true); setError('');
    try {
      const next = await rpc.call('setAifMode', input);
      if (!mounted.current) return;
      setView(next);
      if (threadId && !next.on) removeAifPill(composer);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (mounted.current) setError(message);
    } finally { if (mounted.current) setPending(false); }
  }
  const title = error
    || (!threadId && !projectId ? 'Сначала выберите проект' : '')
    || (threadId && view?.configured === false ? 'В проекте нет AI Factory — откройте вкладку, чтобы установить' : '')
    || (view?.on ? 'AI Factory включён для проекта: агент ведёт работу через /aif-plan → /aif-implement' : 'Включить режим AI Factory для проекта');
  return <button type="button" aria-label="Режим AI Factory" aria-pressed={!!view?.on} title={title}
    disabled={pending || !view || (!threadId && !projectId)} onClick={() => void toggle()}
    className={cn('grid size-7 cursor-pointer place-items-center rounded-md outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
      view?.on ? 'hover:brightness-110' : 'text-muted-foreground hover:bg-state-hover hover:text-foreground')}
    // Own colour, not the theme's primary: some themes pair primary with a low-contrast foreground.
    style={view?.on ? { background: '#EA580C', color: '#fff' } : undefined}>
    <FactoryIcon />
  </button>;
}

/** Composer banner (invisible): a typed `@AI Factory` never stays in a `/aif-…` command, where its text would become arguments. */
function AifPillStripper() {
  const composer = useComposer();
  const strip = isCommandDraft(composer.draft) && composer.draft.mentions.some(isAifPill);
  useEffect(() => { if (strip) removeAifPill(composer); }, [composer, strip]);
  return null;
}

export default definePluginApp(app => {
  app.slots.experimental_codeFenceRenderer({ id: 'gate-data', languages: ['aif-gate-result'], component: GateData });
  app.slots.experimental_codeFenceRenderer({ id: 'plan-document', languages: ['aif-plan'], component: PlanDocument });
  app.contentScripts.register({ id: 'plan-presentation', mount: mountPlanPresentation });
  app.composer.customize({ id: 'suggested-commands', scopes: ['thread'], banners: [{ id: 'commands', chrome: 'bare', component: SuggestedCommands }] });
  app.composer.customize({ id: 'aif-mode', scopes: ['new-thread', 'thread'], actions: [{ id: 'aif-mode', component: AifModeAction }] });
  app.composer.customize({ id: 'aif-mode-pill', scopes: ['new-thread', 'thread'], banners: [{ id: 'aif-pill', chrome: 'bare', component: AifPillStripper }] });
  app.slots.messageDirective({ id: 'aif-chat', component: Directive });
  app.slots.experimental_threadContextCardSection({ id: 'workflow', title: 'AI Factory', group: '9_aif', order: 10, component: ContextCard });
  app.experimental_icons.register({ name: 'aif-factory', component: FactoryIcon });
  app.slots.experimental_tab({ id: 'workflow', context: { kind: 'thread' }, availability: 'fixed', title: 'AI Factory', icon: 'aif-factory', layout: 'flush', component: WorkflowPanel });
  app.slots.experimental_threadAction({
    id: 'open-workflow', title: 'AI Factory', icon: 'aif-factory', group: '0_aif', placement: 'header',
    item: ({ experimental_panel }) => ({
      label: 'AI Factory', icon: 'aif-factory', detail: 'Версии, workflow и прогресс проверок',
      run: () => { experimental_panel.openTab({ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } }); },
    }),
  });
});
