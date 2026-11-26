import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostContract, hostSignals, rpcContract, type ChipScoringView, type DelegationView } from './contract.ts';
import { DELEGATION_ROLES, delegationDefaultsSchema, modelSpec } from './delegation.ts';
import { childModel, type ChildModel } from './child-model.ts';
import type { DelegationChoice, DelegationDefaults, DelegationRole, DelegationState } from './delegation.ts';
import { PLUGIN_SKILLS, requestSchema, phaseSchema, snapshotSchema, chipScoringStateSchema, type CardRequest, type ChipScoringState, type Snapshot, type Phase, type Suggestions } from './model.ts';
import { actionPrompt, workflowActions, commitNavigationDeferred } from './workflow.ts';
import { applyRan, applySkipped, RUN_CONFIRMED_STEPS } from './readiness.ts';
import { analyzeReply, nextStepItems, withTopic, rulesSyncCommand } from './suggestions.ts';
import { blockedByGate } from './gate.ts';
import { attachChatChecks, readChatChecks, type ChatCheck } from './check-history.ts';
import { lockUnchangedChecks, unchangedCheck, unchangedReason } from './check-actions.ts';
import { SnapshotCache } from './snapshot-cache.ts';
import { AIF_MENTION, aifMentionItems, aifModeInstructions, shouldContribute } from './aif-mode.ts';
import { versionSampleFresh } from './versions.ts';
import { DECISIONS_URL, decisionsRequest, decisionsResponseSchema, probabilitiesFor, scoringKey } from './chip-scoring.ts';
import { CHIP_SCORING_TAG, projectTag, threadTag } from './live-updates.ts';
import { isBasicPlanPath, nativePlanInput } from './basic-workflow.ts';
import { readChatPlan, type ChatPlanRecord } from './chat-plan.ts';
import { pendingConfirmation, asksToApplyPlanChanges } from './confirmation.ts';
import { IMPROVE_APPROVAL, pendingImproveProposal } from './improve-approval.ts';
import { readSessionBrief, sessionBriefBlocked, sessionBriefCommandAvailable, briefCommands, SESSION_BRIEF_COMMAND, type SessionBriefReport } from './session-brief.ts';
import { GATE_EVIDENCE_COMMAND, gateEvidenceCommandAvailable } from './gate-evidence-command.ts';
import { registerWorktreeProvider, WORKTREE_PROVIDER_ID } from './worktree-provider.ts';
import { waitWorker } from './worker-wait.ts';
export { rpcContract } from './contract.ts';
type Selection = { environmentId: string; target: string; phase: Phase; newTask?: boolean };
type Delivery = { requestId: string; fingerprint: string; actionId: string; state: 'attempting' | 'sent' | 'uncertain'; at: number };
type DismissedSuggestions = { sourceKey: string; ids: string[] };
const suggestionSource = (root: string, output: string | null, proposalSeq?: number) => createHash('sha256')
  .update(JSON.stringify(proposalSeq === undefined ? [root, output] : [root, output, proposalSeq])).digest('hex');
const CHIP_SCORE_CACHE_LIMIT = 200;
const chipScoreCache = new Map<string, Record<string, number>>();
const chipScoreInflight = new Set<string>();
const rememberChipScore = (key: string, value: Record<string, number>) => {
  if (!chipScoreCache.has(key) && chipScoreCache.size >= CHIP_SCORE_CACHE_LIMIT) chipScoreCache.delete(chipScoreCache.keys().next().value!);
  chipScoreCache.set(key, value);
};
const chatStorageKey = (threadId: string, environmentId: string, hostId: string, root: string) =>
  `chat-checks:${threadId}:${environmentId}:${createHash('sha256').update(JSON.stringify([hostId, root])).digest('hex')}`;
const commandInput = (command: string, context: string) => [
  { type: 'text' as const, text: command, mentions: [] },
  { type: 'text' as const, text: context, mentions: [], visibility: 'agent-only' as const },
];
export function cardDirective(request: { target?: string; phase?: Phase; cardId?: string }): string {
  const attrs = [request.cardId ? `card=${JSON.stringify(request.cardId)}` : '', request.target ? `target=${JSON.stringify(request.target)}` : '', request.phase && request.phase !== 'unknown' ? `phase=${JSON.stringify(request.phase)}` : ''].filter(Boolean).join(' ');
  return `::aif-chat{${attrs}}`;
}
const envListOutputSchema = z.looseObject({ variables: z.array(z.looseObject({ name: z.string() })) });
const envValueOutputSchema = z.looseObject({ name: z.string(), value: z.string().nullable() });
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: 'boolean', label: 'Карточки AI Factory в чате', default: true },
    sourceRepo: { type: 'string', label: 'Путь к исходникам AI Factory на хосте (необязательно)', default: '' },
    runtime: { type: 'select', label: 'Runtime установки проекта', options: ['auto', 'codex', 'codex-app', 'claude', 'cursor', 'opencode', 'gemini', 'devin', 'windsurf'], default: 'auto' },
    upstreamRepo: { type: 'string', label: 'GitHub upstream AI Factory', default: 'lee-to/ai-factory', experimental_schema: z.string().regex(/^[\w.-]+\/[\w.-]+$/) },
    upstreamRef: { type: 'string', label: 'Upstream ref (пусто — последний стабильный release)', default: '', experimental_schema: z.string().max(200) },
    decisionsKey: { type: 'string', label: 'Ключ Gemini Decisions (ручной ввод)', secret: true, default: '' },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  registerWorktreeProvider(bb, host);
  const watchers = new Map<string, Set<string>>();
  const threadEnvironments = new Map<string, string | null>();
  const noteEnvironment = (threadId: string, environmentId: string | null) => {
    const previous = threadEnvironments.get(threadId);
    if (previous === environmentId) return;
    threadEnvironments.set(threadId, environmentId);
    if (previous !== undefined) bb.rpc.experimental_invalidate([threadTag(threadId)]);
  };
  let enabled = (await settings.get()).enabled;
  settings.onChange(next => {
    enabled = next.enabled;
    const ids = new Set<string>();
    for (const listeners of watchers.values()) for (const id of listeners) ids.add(id);
    if (ids.size) bb.rpc.experimental_invalidate([...ids].map(threadTag));
  });
  const queues = new Map<string, Promise<unknown>>();
  let disposed = false;
  const db = bb.storage.database();
  bb.storage.migrate(db, ['CREATE TABLE IF NOT EXISTS status_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS local_versions (key TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS project_modes (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)']);
  const versionScopes = new Map<string, string>();
  const readLocalVersions = (key: string) => {
    const row = db.prepare('SELECT at, value FROM local_versions WHERE key = ?').get(key) as { at: number; value: string } | undefined;
    if (!row || !versionSampleFresh(row.at)) return null;
    try {
      const value = snapshotSchema.shape.versions.safeParse(JSON.parse(row.value));
      return value.success ? { versions: value.data, checkedAt: new Date(row.at).toISOString() } : null;
    } catch { return null; }
  };
  const cacheRead = db.prepare('SELECT at, value FROM status_cache WHERE key = ?');
  const cacheWrite = db.prepare('INSERT INTO status_cache (key, at, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at=excluded.at, value=excluded.value');
  const modeRead = db.prepare('SELECT enabled FROM project_modes WHERE project_id = ?');
  const modeWrite = db.prepare('INSERT INTO project_modes (project_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at');
  const getMode = (projectId: string) => (modeRead.get(projectId) as { enabled: number } | undefined)?.enabled === 1;
  const setMode = (projectId: string, on: boolean) => { modeWrite.run(projectId, on ? 1 : 0, Date.now()); };
  const cache = new SnapshotCache({
    read(key) {
      const row = cacheRead.get(key) as { at: number; value: string } | undefined;
      if (!row) return null;
      const parsed = snapshotSchema.safeParse(JSON.parse(row.value));
      return parsed.success && Number.isFinite(row.at) ? { at: row.at, value: parsed.data } : null;
    },
    write(key, entry) {
      const json = JSON.stringify(entry.value);
      if (Buffer.byteLength(json) > 1024 * 1024) return;
      cacheWrite.run(key, entry.at, json);
      db.prepare('DELETE FROM status_cache WHERE key IN (SELECT key FROM status_cache ORDER BY at DESC LIMIT -1 OFFSET 100)').run();
    },
    changed(key) { const ids = watchers.get(key); if (ids?.size) bb.rpc.experimental_invalidate([...ids].map(threadTag)); },
  });
  const histories = new Map<string, { at: number; records: ChatCheck[]; error?: boolean }>();
  const historyLoads = new Map<string, Promise<void>>();
  const historyEpochs = new Map<string, number>();
  async function chatChecks(threadId: string, environmentId: string, hostId: string, snapshot: Snapshot, fresh: boolean) {
    if (!snapshot.candidates.length) return;
    const epoch = historyEpochs.get(threadId) ?? 0;
    const key = JSON.stringify([threadId, environmentId, hostId, snapshot.root, snapshot.candidates.map(c => c.path), epoch]);
    const storageKey = chatStorageKey(threadId, environmentId, hostId, snapshot.root);
    if (!histories.has(key)) histories.set(key, { at: 0, records: await bb.storage.kv.get<ChatCheck[]>(storageKey) ?? [] });
    const load = async () => {
      try {
        const rows: Awaited<ReturnType<typeof bb.sdk.threads.events.list>> = [];
        let beforeSeq: string | undefined;
        for (let page = 0; page < 6; page++) {
          const batch = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '100', beforeSeq,
            types: ['item/completed', 'client/turn/requested'] });
          if (disposed || epoch !== (historyEpochs.get(threadId) ?? 0)) return;
          rows.push(...batch);
          if (batch.length < 100) break;
          beforeSeq = String(Math.min(...batch.map(row => row.seq)));
        }
        if (disposed) return;
        const history = await serial(`history:${storageKey}`, async () => {
          const saved = await bb.storage.kv.get<ChatCheck[]>(storageKey) ?? [];
          const records = [...saved, ...readChatChecks(rows, snapshot.candidates.map(c => c.path))];
          const latest = new Map<string, ChatCheck>();
          for (const record of records) {
            const id = `${record.target}:${record.result.gate}`;
            if ((latest.get(id)?.seq ?? -1) < record.seq) latest.set(id, record);
          }
          const value = { at: Date.now(), records: [...latest.values()].slice(-200) };
          await bb.storage.kv.set(storageKey, value.records);
          return value;
        });
        if (histories.size > 100) histories.clear();
        histories.set(key, history);
        bb.rpc.experimental_invalidate([threadTag(threadId)]);
      } catch (error) {
        if (disposed) return;
        bb.log.warn(`Chat gate history: ${error instanceof Error ? error.message.slice(0, 500) : 'unavailable'}`);
        const history = histories.get(key); if (history) { history.at = Date.now() - 45000; history.error = true; }
        bb.rpc.experimental_invalidate([threadTag(threadId)]);
      }
    };
    if (fresh || Date.now() - histories.get(key)!.at > 60000) {
      if (!historyLoads.has(key)) {
        const pending = load().finally(() => { if (historyLoads.get(key) === pending) historyLoads.delete(key); });
        historyLoads.set(key, pending);
      }
      if (fresh) await historyLoads.get(key);
      else void historyLoads.get(key)?.catch(() => {});
    }
    const history = histories.get(key);
    if (history) attachChatChecks(snapshot, history.records);
    if (history?.error) snapshot.diagnostics.push('История gate не обновилась; показаны сохранённые результаты.');
  }
  async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(key, current);
    try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
  }
  async function context(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error('У чата нет рабочей среды.');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== 'ready' || environment.lifecycle.phase !== 'active' || !environment.path) throw new Error('Рабочая среда недоступна.');
    if (environment.projectId !== thread.projectId) throw new Error('Среда не соответствует проекту чата.');
    noteEnvironment(threadId, environment.id);
    return { thread, environment };
  }
  function preparationKey({ projectId, hostId, path }: { projectId: string; hostId: string; path: string | null }) {
    if (projectId !== 'proj_personal') return `preparation-visible:${projectId}`;
    const folder = createHash('sha256').update(JSON.stringify([hostId, path])).digest('hex');
    return `preparation-visible:${projectId}:${folder}`;
  }
  const readConfirmation = async (threadId: string) => pendingConfirmation(await bb.sdk.threads.events.list({ threadId,
    order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] }));
  async function requireConfirmationAnswer(threadId: string) {
    let pending: boolean;
    try { pending = await readConfirmation(threadId); }
    catch { throw new Error('Не удалось проверить ожидание подтверждения. Обновите статус.'); }
    if (pending) throw new Error('Сначала ответьте на запрос подтверждения в чате.');
  }
  async function contextReport(threadId: string, environment: { id: string; path: string | null; hostId: string }, snapshot: Snapshot,
    rows?: Parameters<typeof readSessionBrief>[0]) {
    if (snapshot.profile !== 'aifhub-openspec' || snapshot.target?.kind !== 'openspec') return;
    await serial(`session-brief:${threadId}`, async () => {
      const key = `session-brief:${threadId}`;
      const scope = JSON.stringify([environment.id, environment.path, environment.hostId]);
      const saved = await bb.storage.kv.get<{ scope: string; reports: SessionBriefReport[] }>(key);
      const reports = saved?.scope === scope ? saved.reports : [];
      const previous = reports.find(r => r.target === snapshot.target!.path);
      const report = rows ? readSessionBrief(rows, snapshot.target, previous) : previous;
      if (report) snapshot.sessionBrief = report;
      else delete snapshot.sessionBrief;
      if (report && report.seq !== previous?.seq) await bb.storage.kv.set(key,
        { scope, reports: [...reports.filter(r => r.target !== report.target).slice(-79), report] });
    });
  }
  async function status(input: CardRequest, checkUpdates = false, fresh = false): Promise<Snapshot> {
    const config = await settings.get();
    if (!config.enabled) throw new Error('Карточки отключены в настройках плагина.');
    const { thread, environment } = await context(input.threadId);
    const saved = await bb.storage.kv.get<Selection>(`selection:${input.threadId}`);
    const selection = saved?.environmentId === environment.id ? saved : undefined;
    const newTask = !input.target && (input.newTask ?? selection?.newTask ?? false);
    const target = newTask ? '' : input.target || selection?.target || '';
    const phase = input.phase === 'unknown' ? selection?.phase ?? input.phase : input.phase;
    const runtime = config.runtime === 'auto' ? thread.providerId === 'codex' ? 'codex-app' : thread.providerId : config.runtime;
    const key = JSON.stringify(['status/v1', environment.id, environment.path, environment.hostId, target, runtime, config.sourceRepo, config.upstreamRepo, config.upstreamRef, newTask]);
    const versionKey = JSON.stringify([environment.id, environment.path, environment.hostId, runtime, config.sourceRepo]);
    const remoteKey = `upstream:${environment.hostId}:${config.upstreamRepo}:${config.upstreamRef}`;
    if (versionScopes.size > 100) versionScopes.clear();
    versionScopes.set(input.threadId, versionKey);
    if (watchers.size > 100) watchers.clear();
    const listeners = watchers.get(key) ?? new Set<string>(); listeners.add(input.threadId); watchers.set(key, listeners);
    if (fresh || checkUpdates) cache.invalidate(candidate => candidate === key);
    const snapshot = await cache.get(key, async () => {
      const dirty = fresh && thread.status === 'active' ? await bb.storage.kv.get<{ key: string }>(`updating-versions:${input.threadId}`) : null;
      const collect = async () => {
        const local = dirty?.key === versionKey ? null : readLocalVersions(versionKey);
        let checkRemote = false;
        if (checkUpdates) checkRemote = await serial(`version-check:${remoteKey}`, async () => {
          const previous = await bb.storage.kv.get<Snapshot['upstream']>(remoteKey);
          if (previous?.checkedAt && versionSampleFresh(Date.parse(previous.checkedAt))) return false;
          // Reserve the attempt before the host/network call; reloads, parallel
          // workspaces and failed requests must not bypass the daily limit.
          await bb.storage.kv.set(remoteKey, { version: null, sha: null, ref: null, checkedAt: new Date().toISOString(), error: 'Проверка выполняется; повторная попытка доступна через сутки.' });
          return true;
        });
        try {
          const collected = await host.call('collect', { root: environment.path!, target, phase: 'unknown', runtime, sourceRepo: config.sourceRepo,
            checkUpdates: checkRemote, cachedVersions: local, upstreamRepo: config.upstreamRepo, upstreamRef: config.upstreamRef }, { hostId: environment.hostId });
          if (!local) {
            const at = Date.now();
            db.prepare('INSERT INTO local_versions (key, at, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at=excluded.at, value=excluded.value')
              .run(versionKey, at, JSON.stringify({ ...collected.versions, installed: null }));
            db.prepare('DELETE FROM local_versions WHERE key IN (SELECT key FROM local_versions ORDER BY at DESC LIMIT -1 OFFSET 100)').run();
            collected.versionsCheckedAt = new Date(at).toISOString();
          } else collected.versionsCheckedAt = local.checkedAt;
          if (checkRemote) {
            const attempt = await bb.storage.kv.get<Snapshot['upstream']>(remoteKey);
            await bb.storage.kv.set(remoteKey, { ...collected.upstream, checkedAt: attempt?.checkedAt ?? new Date().toISOString() });
          }
          return collected;
        } catch (error) {
          if (checkRemote && !disposed) {
            const attempt = await bb.storage.kv.get<Snapshot['upstream']>(remoteKey);
            if (attempt) await bb.storage.kv.set(remoteKey, { ...attempt, error: 'Проверка не завершилась; сохранён суточный интервал повторной попытки.' });
          }
          throw error;
        }
      };
      return !readLocalVersions(versionKey) || dirty?.key === versionKey ? serial(`local-versions:${versionKey}`, collect) : collect();
    }, fresh || checkUpdates);
    // After installation, basic plans remain files but are not AI Factory plans.
    // Release only our managed selection, never reinterpret it as a native plan.
    if (snapshot.configured && isBasicPlanPath(target)) {
      if (selection?.target === target) await bb.storage.kv.delete(`selection:${input.threadId}`);
      return status({ ...input, target: '', phase: 'unknown' }, false, true);
    }
    if (snapshot.selectionReset && snapshot.profile !== 'invalid' && target) {
      await bb.storage.kv.set(`selection:${input.threadId}`, { environmentId: environment.id, target: '', phase, newTask: true } satisfies Selection);
      await bb.storage.kv.delete(`chat-plan:${input.threadId}`);
      const recovered = await status({ ...input, target: '', newTask: true }, false, true);
      recovered.selectionReset = true;
      recovered.diagnostics = [...new Set([...snapshot.diagnostics, ...recovered.diagnostics])];
      return recovered;
    }
    if (newTask && snapshot.profile !== 'invalid') {
      snapshot.target = null;
      snapshot.checks = [];
      snapshot.fingerprint = createHash('sha256').update(JSON.stringify([snapshot.fingerprint, 'new-task'])).digest('hex');
    }
    snapshot.upstream = await bb.storage.kv.get<Snapshot['upstream']>(remoteKey) ?? snapshot.upstream;
    if (snapshot.phase !== phase) {
      snapshot.fingerprint = createHash('sha256').update(JSON.stringify([snapshot.fingerprint, phase])).digest('hex');
      snapshot.phase = phase;
      snapshot.phaseSource = phase === 'unknown' ? 'Этап не указан; состояние файлов не доказывает активный вызов' : 'Этап указан агентом в карточке; выполнение проверяется BB';
    }
    const projectKey = `${environment.hostId}:${environment.path!}`;
    snapshot.readiness = applySkipped(applyRan(snapshot.readiness, await bb.storage.kv.get<string[]>(`readiness-ran:${projectKey}`) ?? []),
      await bb.storage.kv.get<string[]>(`readiness-skip:${projectKey}`) ?? []);
    await contextReport(input.threadId, environment, snapshot);
    snapshot.threadState = thread.runtime.displayStatus;
    try {
      snapshot.pendingQuestions = (await bb.sdk.threads.interactions.list({ threadId: input.threadId })).length;
      if (snapshot.pendingQuestions > 0) snapshot.threadState = 'awaiting_input';
    } catch { snapshot.pendingQuestions = null; }
    try {
      const rows = await bb.sdk.threads.events.list({ threadId: input.threadId,
        order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] });
      snapshot.pendingConfirmation = pendingConfirmation(rows);
      await contextReport(input.threadId, environment, snapshot, rows);
      if (snapshot.profile === 'aifhub-openspec' && snapshot.target?.kind === 'openspec') {
        const reply = [...rows].sort((a, b) => b.seq - a.seq).find(row => row.type === 'item/completed'
          && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId
          && row.data.item.text.replace(/::aif-chat\{[^\n]*\}/g, '').trim());
        if (reply?.type === 'item/completed' && reply.data.item.type === 'agentMessage') {
          const command = rulesSyncCommand(reply.data.item.text, snapshot.target.id);
          if (command) snapshot.rulesSync = { command, seq: reply.seq };
        }
      }
      if (!snapshot.configured && snapshot.profile === 'none' && !snapshot.target) {
        const savedPlan = await bb.storage.kv.get<ChatPlanRecord>(`chat-plan:${input.threadId}`);
        const accepted = savedPlan?.environmentId === environment.id && savedPlan.root === snapshot.root ? savedPlan : null;
        const proposed = readChatPlan(rows);
        const plan = proposed ?? accepted;
        if (plan) snapshot.chatPlan = { seq: plan.seq, hash: plan.hash, title: plan.title,
          accepted: !!accepted && plan.seq === accepted.seq && plan.hash === accepted.hash };
      }
    } catch {
      snapshot.pendingConfirmation = null;
      snapshot.diagnostics.push('Не удалось проверить, ожидается ли подтверждение пользователя. Обновите статус.');
    }
    if (snapshot.pendingConfirmation !== false) snapshot.threadState = 'awaiting_input';
    if (snapshot.sessionBrief) snapshot.fingerprint = createHash('sha256').update(JSON.stringify([snapshot.fingerprint, snapshot.sessionBrief])).digest('hex');
    if (snapshot.rulesSync) snapshot.fingerprint = createHash('sha256').update(JSON.stringify([snapshot.fingerprint, snapshot.rulesSync])).digest('hex');
    if (snapshot.chatPlan) snapshot.fingerprint = createHash('sha256').update(JSON.stringify([snapshot.fingerprint, snapshot.chatPlan])).digest('hex');
    snapshot.actions = workflowActions(snapshot);
    await chatChecks(input.threadId, environment.id, environment.hostId, snapshot, fresh);
    lockUnchangedChecks(snapshot);
    if (snapshot.preparation?.length) {
      snapshot.preparationVisible = await bb.storage.kv.get<boolean>(preparationKey(environment)) === true;
    }
    return snapshot;
  }
  async function show(input: CardRequest) {
    const { environment } = await context(input.threadId);
    const snapshot = await status(input, false, true);
    const previous = await bb.storage.kv.get<Selection>(`selection:${input.threadId}`);
    const selectedTarget = snapshot.selectionReset ? '' : input.target;
    await bb.storage.kv.set(`selection:${input.threadId}`, { environmentId: environment.id, target: selectedTarget, phase: input.phase,
      newTask: snapshot.selectionReset === true || !selectedTarget && (input.newTask ?? (previous?.environmentId === environment.id ? previous.newTask ?? false : false)) } satisfies Selection);
    if (input.phase === 'plan' && !snapshot.configured && snapshot.profile === 'none') {
      await bb.storage.kv.set(`inline-card:${input.threadId}`, { cardId: randomUUID(), environmentId: environment.id });
      bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
      return { snapshot, previewDirective: '' };
    }
    if (snapshot.pendingConfirmation || snapshot.pendingQuestions) {
      bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
      return { snapshot, previewDirective: '' };
    }
    const cardId = randomUUID();
    await bb.storage.kv.set(`inline-card:${input.threadId}`, { cardId, environmentId: environment.id });
    bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
    return { snapshot, previewDirective: cardDirective({ cardId, target: snapshot.target?.path ?? selectedTarget, phase: input.phase }) };
  }
  async function saveCompletedPlan(threadId: string, expectedText?: string) {
    return serial(`plan-document:${threadId}`, async () => {
      if (!enabled) return null;
      const { thread, environment } = await context(threadId);
      if (thread.status !== 'idle' || thread.queuedMessageCount || thread.activeBackgroundAgentCount) return null;
      const rows = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] });
      const plan = readChatPlan(rows);
      if (!plan || expectedText !== undefined && plan.text !== expectedText.trim()) return null;
      type Saved = { environmentId: string; root: string; path: string; seq: number; hash: string };
      const previous = await bb.storage.kv.get<Saved>(`plan-document:${threadId}`);
      if (previous?.environmentId === environment.id && previous.root === environment.path && previous.seq === plan.seq && previous.hash === plan.hash)
        return { path: previous.path, seq: previous.seq, hash: previous.hash, environmentId: environment.id };
      const snapshot = await status({ threadId, target: '', phase: 'unknown' }, false, true);
      if (snapshot.configured || snapshot.profile !== 'none') return null;
      const latest = await context(threadId);
      const check = readChatPlan(await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] }));
      if (latest.environment.id !== environment.id || latest.environment.path !== snapshot.root || latest.thread.status !== 'idle'
        || latest.thread.queuedMessageCount || !check || check.seq !== plan.seq || check.hash !== plan.hash) return null;
      let result: { path: string };
      try {
        result = await host.call('savePlan', { root: snapshot.root, threadId, seq: plan.seq, hash: plan.hash, text: plan.text }, { hostId: environment.hostId });
      } catch (error) {
        bb.log.warn(`aif-chat: plan export failed threadId=${threadId}: ${errMessage(error)}`);
        throw error;
      }
      await bb.storage.kv.set(`plan-document:${threadId}`, { environmentId: environment.id, root: snapshot.root, ...result, seq: plan.seq, hash: plan.hash } satisfies Saved);
      await bb.storage.kv.set(`selection:${threadId}`, { environmentId: environment.id, target: result.path, phase: 'plan', newTask: false } satisfies Selection);
      await bb.storage.kv.set(`inline-card:${threadId}`, { cardId: randomUUID(), environmentId: environment.id });
      bb.log.debug(`aif-chat: plan exported threadId=${threadId} path=${result.path}`);
      cache.invalidate(key => !!watchers.get(key)?.has(threadId));
      bb.rpc.experimental_invalidate([threadTag(threadId)]);
      return { ...result, seq: plan.seq, hash: plan.hash, environmentId: environment.id };
    });
  }
  async function suggested(threadId: string, fresh = false) {
    const empty: Suggestions = { sourceKey: '', fingerprint: '', threadState: 'unknown', items: [], gate: null, gateError: null, origin: 'reply' };
    if (!enabled) return { view: empty, ids: [] as string[], hidden: [] as string[], snapshot: null, proposal: null };
    const { output } = await bb.sdk.threads.output({ threadId });
    const reply = analyzeReply(output ?? '');
    const ids = [...reply.ids];
    const applyQuestion = asksToApplyPlanChanges(output ?? '');
    if (!ids.length && !reply.gate && !reply.error && !applyQuestion) {
      const projectId = (await bb.sdk.threads.get({ threadId })).projectId;
      if (!getMode(projectId)) return { view: empty, ids, hidden: [] as string[], snapshot: null, proposal: null };
      return fallbackSuggestions(threadId, output, fresh);
    }
    const snapshot = await status({ threadId, target: '', phase: 'unknown' }, false, fresh);
    let proposal: ReturnType<typeof pendingImproveProposal> = null;
    if (applyQuestion && !reply.warning && snapshot.configured && snapshot.profile !== 'invalid') {
      try { proposal = pendingImproveProposal(await bb.sdk.threads.events.list({ threadId,
        order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] }), output, snapshot.target); }
      catch { /* Unknown history cannot authorize an approval shortcut. */ }
    }
    if (proposal) ids.unshift(IMPROVE_APPROVAL);
    const approvalThread = proposal ? (await context(threadId)).thread : null;
    const sourceKey = suggestionSource(snapshot.root, output, proposal?.seq);
    const dismissed = await bb.storage.kv.get<DismissedSuggestions>(`suggestions-dismissed:${threadId}`);
    const hidden = dismissed?.sourceKey === sourceKey ? dismissed.ids : [];
    const prefix = ['codex', 'codex-app'].includes(snapshot.runtime) ? '$' : '/';
    const blockedReason = reply.gate?.blocking ? 'Gate содержит блокирующие проблемы.' : reply.warning;
    const contextBlock = snapshot.rulesSync ? 'Сначала синхронизируйте правила выбранного change.'
      : sessionBriefBlocked(snapshot) ? 'Сначала восстановите SessionBrief выбранного change.' : null;
    const specialChip = (id: string) => id === IMPROVE_APPROVAL || id === GATE_EVIDENCE_COMMAND || id === SESSION_BRIEF_COMMAND;
    // Plugin skills ship with the plugin, so a broken project AI Factory config does not turn them off.
    const pluginSkill = (id: string) => (PLUGIN_SKILLS as readonly string[]).includes(id);
    const skillInstalled = (id: string) => snapshot.skills.includes(id) || pluginSkill(id);
    const offered = ids.filter(id => !hidden.includes(id));
    const items: Suggestions['items'] = offered.filter(id => specialChip(id) || skillInstalled(id) || id === reply.next).map(id => id === IMPROVE_APPROVAL && proposal ? {
      id, label: 'Применить всё', kind: 'improve-approval' as const, command: proposal.command,
      available: !reply.error && !reply.gate?.blocking && snapshot.skills.includes('aif-improve')
        && snapshot.pendingQuestions === 0 && snapshot.pendingConfirmation === true && !!approvalThread
        && ['idle', 'error'].includes(approvalThread.status) && !approvalThread.queuedMessageCount && !approvalThread.activeBackgroundAgentCount,
      reason: 'Подтвердить только предложенные в этом ответе улучшения выбранного плана; без запуска выполнения',
      probability: null,
    } : id === GATE_EVIDENCE_COMMAND && reply.evidenceCommands.length ? { id,
      label: `Сохранить результат ${reply.evidenceCommands.at(-1)!.gate}${reply.evidenceCommands.at(-1)!.placeholder ? ' · уточнить файл' : ''}`,
      command: reply.commands.get(id)!,
      available: !reply.error && gateEvidenceCommandAvailable(snapshot) && reply.evidenceCommands.at(-1)?.change === snapshot.target?.id,
      reason: reply.evidenceCommands.at(-1)!.placeholder
        ? 'Отправить команду агенту: <…> — шаблон пути, владелец workflow должен выбрать или подготовить исходный отчёт и проверить evidence.'
        : 'Передать команду штатному writer выбранного change. Сохранение и актуальность evidence проверяет владелец workflow; отправка не означает PASS.',
      probability: null,
    } : id === SESSION_BRIEF_COMMAND ? { id, label: 'Пересобрать SessionBrief', command: reply.commands.get(id)!,
      available: !reply.error && sessionBriefCommandAvailable(snapshot) && briefCommands(reply.commands.get(id)!).some(c => c.change === snapshot.target?.id),
      reason: 'Пересобрать контекст только выбранного change; команда объявлена установленным расширением',
      probability: null,
    } : ({ id, command: withTopic(`${prefix}${reply.commands.get(id) ?? id}`, id, reply.next === id ? reply.gate?.suggested_next?.reason : null),
      available: !reply.error && !blockedByGate(id, reply.gate, reply.warning) && !(id === 'aif-implement' && contextBlock) && !(id === 'aif-commit' && commitNavigationDeferred(snapshot)) && !unchangedCheck(snapshot, id, reply.commands.get(id)) && (snapshot.profile !== 'invalid' || pluginSkill(id)) && skillInstalled(id),
      reason: reply.error ?? (id === 'aif-implement' && contextBlock ? contextBlock : blockedByGate(id, reply.gate, reply.warning) ? blockedReason! : id === 'aif-commit' && commitNavigationDeferred(snapshot) ? 'Коммиты привязаны к плану; продолжите aif-implement до разрешённого commit-boundary.' : unchangedCheck(snapshot, id, reply.commands.get(id)) ? unchangedReason : snapshot.profile === 'invalid' && !pluginSkill(id) ? 'Проверьте конфигурацию проекта.' : !skillInstalled(id) ? `Команда ${id} не установлена для ${snapshot.runtime}. Добавьте этот skill в установку AI Factory проекта.` : reply.next === id ? reply.gate?.suggested_next?.reason ?? 'Следующий шаг из gate' : 'Команда из последнего ответа агента'),
      probability: null,
    }));
    if (offered.length > items.length) bb.log.debug(`aif-chat: suggestions threadId=${threadId} shown=${items.length} hiddenUnknown=${offered.length - items.length}`);
    await chipScoringFor(threadId, sourceKey, reply.prose, items);
    const view: Suggestions = { sourceKey, fingerprint: snapshot.fingerprint, threadState: snapshot.threadState, gate: reply.gate, gateError: reply.error, gateWarning: reply.warning, origin: 'reply', items };
    return { view, ids, hidden, snapshot, proposal };
  }
  async function fallbackSuggestions(threadId: string, output: string | null, fresh: boolean) {
    const snapshot = await status({ threadId, target: '', phase: 'unknown' }, false, fresh);
    const sourceKey = suggestionSource(snapshot.root, output);
    const dismissed = await bb.storage.kv.get<DismissedSuggestions>(`suggestions-dismissed:${threadId}`);
    const hidden = dismissed?.sourceKey === sourceKey ? dismissed.ids : [];
    const items = nextStepItems(snapshot.actions, { skills: snapshot.skills, invalid: snapshot.profile === 'invalid',
      prefix: ['codex', 'codex-app'].includes(snapshot.runtime) ? '$' : '/', hidden });
    bb.log.debug(`aif-chat: fallback suggestions threadId=${threadId} count=${items.length}`);
    await chipScoringFor(threadId, sourceKey, output ?? '', items);
    const view: Suggestions = { sourceKey, fingerprint: snapshot.fingerprint, threadState: snapshot.threadState, gate: null, gateError: null, origin: 'plan', items };
    return { view, ids: items.map(i => i.id), hidden, snapshot, proposal: null };
  }
  // Requested model per child thread, cached by id + updatedAt so panel refreshes do not re-read events.
  const childModels = new Map<string, ChildModel>();
  async function childModelFor(c: { id: string; title?: string | null; providerId?: string | null; updatedAt: unknown }, state: DelegationState): Promise<ChildModel> {
    const key = `${c.id}:${String(c.updatedAt)}:${JSON.stringify([state.choice, state.research, state.research2, state.research3])}`;
    const hit = childModels.get(key);
    if (hit) return hit;
    try {
      const rows = await bb.sdk.threads.events.list({ threadId: c.id, order: 'desc', limit: '20', types: ['client/turn/requested', 'provider/modelFallback'] });
      const value = childModel(rows, { title: c.title ?? null, providerId: c.providerId ?? null }, state);
      childModels.set(key, value);
      if (childModels.size > 200) childModels.delete(childModels.keys().next().value!);
      return value;
    } catch (error) {
      bb.log.warn(`aif-chat: child model read failed childId=${c.id}: ${error instanceof Error ? error.message : String(error)}`);
      return { execution: null, fallback: null, mismatch: null };
    }
  }
  async function delegationView(threadId: string): Promise<DelegationView> {
    const { environment } = await context(threadId);
    const defaults = delegationDefaultsSchema.safeParse(await bb.storage.kv.get<DelegationDefaults>('delegation-defaults'));
    const [state, providers, children] = await Promise.all([
      host.call('delegation', { root: environment.path! }, { hostId: environment.hostId }),
      bb.sdk.providers.list({ environmentId: environment.id }).catch(() => []),
      bb.sdk.threads.list({ parentThreadId: threadId, limit: 20 }).catch(() => []),
    ]);
    return { ...state,
      providers: providers.filter(p => p.available).map(p => ({ id: p.id, name: p.displayName })),
      children: await Promise.all(children.map(async c => ({ id: c.id, title: c.title ?? null, status: c.status, providerId: c.providerId ?? null, updatedAt: String(c.updatedAt), worktree: c.environmentIsWorktree === true,
        ...await childModelFor(c, state) }))),
      defaults: defaults.success ? defaults.data : null,
      appliedDefaults: null };
  }
  async function setDelegation(threadId: string, choice: DelegationChoice, role: DelegationRole = 'implement') {
    const { environment } = await context(threadId);
    const state = await host.call('setDelegation', { root: environment.path!, choice, role }, { hostId: environment.hostId });
    await markApplied(environment);
    bb.log.info(`aif-chat: delegation saved threadId=${threadId} role=${role} mode=${choice.mode}`);
    if (state.removedLegacy) bb.log.info(`aif-chat: removed legacy runner root=${environment.path}`);
    cache.invalidate(key => !!watchers.get(key)?.has(threadId));
    bb.rpc.experimental_invalidate([threadTag(threadId)]);
    return delegationView(threadId);
  }
  async function setDelegationDefaults(threadId: string, action: 'from-project' | 'apply' | 'clear') {
    const { environment } = await context(threadId);
    const root = environment.path!;
    const hostId = environment.hostId;
    if (action === 'clear') {
      await bb.storage.kv.delete('delegation-defaults');
    } else if (action === 'from-project') {
      const state = await host.call('delegation', { root }, { hostId });
      const defaults: DelegationDefaults = { implement: state.choice, research: state.research, research2: state.research2, research3: state.research3 };
      if (DELEGATION_ROLES.every(role => defaults[role].mode === 'self')) throw new Error('В этом проекте у всех ролей «Этот агент» — брать нечего.');
      await bb.storage.kv.set('delegation-defaults', defaults);
    } else {
      const parsed = delegationDefaultsSchema.safeParse(await bb.storage.kv.get<DelegationDefaults>('delegation-defaults'));
      if (!parsed.success) throw new Error('Модели по умолчанию не заданы.');
      const state = await host.call('delegation', { root }, { hostId });
      await applyDefaults(root, hostId, parsed.data, state.foreign);
    }
    if (action !== 'clear') await markApplied(environment);
    bb.log.info(`aif-chat: delegation defaults ${action} threadId=${threadId}`);
    cache.invalidate(key => !!watchers.get(key)?.has(threadId));
    bb.rpc.experimental_invalidate([threadTag(threadId)]);
    return delegationView(threadId);
  }
  async function applyDefaults(root: string, hostId: string, defaults: DelegationDefaults, foreign: string | null): Promise<DelegationRole[]> {
    const written: DelegationRole[] = [];
    for (const role of DELEGATION_ROLES) {
      if (role === 'implement' && foreign) continue;
      await host.call('setDelegation', { root, choice: defaults[role], role }, { hostId });
      written.push(role);
    }
    return written;
  }
  const appliedDefaultsKey = (environment: { hostId: string; path: string | null }) => `delegation-defaults-applied:${environment.hostId}:${environment.path!}`;
  async function markApplied(environment: { hostId: string; path: string | null }) {
    await bb.storage.kv.set(appliedDefaultsKey(environment), new Date().toISOString());
  }
  const ROLE_NAMES: Record<DelegationRole, string> = { implement: 'Код', research: 'Разведчик 1', research2: 'Разведчик 2', research3: 'Разведчик 3' };
  async function autoApplyDefaults(threadId: string): Promise<string | null> {
    const { environment } = await context(threadId);
    const root = environment.path!;
    const hostId = environment.hostId;
    return serial(`defaults-apply:${hostId}:${root}`, async () => {
      const parsed = delegationDefaultsSchema.safeParse(await bb.storage.kv.get<DelegationDefaults>('delegation-defaults'));
      if (!parsed.success || !DELEGATION_ROLES.some(role => parsed.data[role].mode === 'bb')) return null;
      if (await bb.storage.kv.get(appliedDefaultsKey(environment))) return null;
      const state = await host.call('delegation', { root }, { hostId });
      if (!state.configured || state.error !== null
        || state.choice.mode !== 'self' || state.research.mode !== 'self' || state.research2.mode !== 'self' || state.research3.mode !== 'self') return null;
      let roles: DelegationRole[];
      try {
        roles = await applyDefaults(root, hostId, parsed.data, state.foreign);
      } catch (error) {
        bb.log.warn(`aif-chat: delegation defaults auto-apply failed threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      await markApplied(environment);
      bb.log.info(`aif-chat: delegation defaults auto-applied threadId=${threadId} roles=${roles.join(',')}`);
      cache.invalidate(key => !!watchers.get(key)?.has(threadId));
      bb.rpc.experimental_invalidate([threadTag(threadId)]);
      const parts = roles.flatMap(role => {
        const choice = parsed.data[role];
        return choice.mode === 'bb' ? [`${ROLE_NAMES[role]} — ${modelSpec(choice)}`] : [];
      });
      return `Применены модели по умолчанию: ${parts.join(', ')}`;
    });
  }
  async function aifModeTarget(input: { threadId?: string; projectId?: string }) {
    if ((input.threadId ? 1 : 0) + (input.projectId ? 1 : 0) !== 1) throw new Error('Укажите ровно один параметр: threadId или projectId.');
    return { threadId: input.threadId, projectId: input.projectId ?? (await bb.sdk.threads.get({ threadId: input.threadId! })).projectId };
  }
  async function aifModeView(threadId: string | undefined, projectId: string, on: boolean) {
    const configured = threadId ? await status({ threadId, target: '', phase: 'unknown' }).then(s => s.configured).catch(() => null) : null;
    return { projectId, on, configured };
  }
  const CHIP_SCORING_KV = 'chip-scoring';
  const scoringState = async (): Promise<ChipScoringState> => {
    const parsed = chipScoringStateSchema.safeParse(await bb.storage.kv.get(CHIP_SCORING_KV) ?? {});
    return parsed.success ? parsed.data : chipScoringStateSchema.parse({});
  };
  async function catalogSecrets(): Promise<{ available: boolean; names: string[] }> {
    try {
      const { variables } = await bb.sdk.plugins.callRpc({ pluginId: 'env-catalog', method: 'env_list', input: { kind: 'secret' },
        outputSchema: envListOutputSchema, signal: AbortSignal.timeout(5000) });
      const gemini = (name: string) => name.toUpperCase().includes('GEMINI');
      const names = variables.map(v => v.name).sort((a, b) => Number(gemini(b)) - Number(gemini(a)) || a.localeCompare(b));
      return { available: true, names };
    } catch (error) {
      bb.log.warn(`aif-chat: env-catalog unavailable: ${error instanceof Error ? error.name : 'error'}`);
      return { available: false, names: [] };
    }
  }
  async function chipScoringView(): Promise<ChipScoringView> {
    const [state, catalog, config] = await Promise.all([scoringState(), catalogSecrets(), settings.get()]);
    return { ...state, catalogAvailable: catalog.available, catalogNames: catalog.names, manualKeySet: config.decisionsKey !== '' };
  }
  async function setChipScoring(input: { enabled?: boolean; source?: 'catalog' | 'manual'; catalogName?: string | null; manualKey?: string | null }) {
    const state = await scoringState();
    const next: ChipScoringState = { ...state, enabled: input.enabled ?? state.enabled, source: input.source ?? state.source,
      catalogName: input.catalogName === undefined ? state.catalogName : input.catalogName };
    if (input.manualKey !== undefined) await settings.experimental_set({ decisionsKey: input.manualKey });
    await bb.storage.kv.set(CHIP_SCORING_KV, next);
    bb.log.info(`aif-chat: chip scoring settings enabled=${next.enabled} source=${next.source}`);
    return chipScoringView();
  }
  async function resolveDecisionsKey(): Promise<{ key: string } | { error: string }> {
    const state = await scoringState();
    if (state.source === 'manual') {
      const key = (await settings.get()).decisionsKey;
      return key ? { key } : { error: 'Ключ не задан' };
    }
    if (!state.catalogName) return { error: 'ключ не найден в каталоге' };
    try {
      const { value } = await bb.sdk.plugins.callRpc({ pluginId: 'env-catalog', method: 'env_get_value', input: { name: state.catalogName },
        outputSchema: envValueOutputSchema, signal: AbortSignal.timeout(5000) });
      if (!value) return { error: 'ключ не найден в каталоге' };
      bb.log.info(`aif-chat: decisions key read source=catalog name=${state.catalogName}`);
      return { key: value };
    } catch (error) {
      bb.log.warn(`aif-chat: decisions key read failed name=${state.catalogName}: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'ключ не найден в каталоге' };
    }
  }
  async function scoreChips(threadId: string, key: string, reply: string, options: { id: string; command: string }[]) {
    const started = Date.now();
    const fail = async (lastError: string, detail: string) => {
      rememberChipScore(key, {});
      bb.log.warn(`aif-chat: chip scoring failed threadId=${threadId}: ${detail}`);
      await serial(CHIP_SCORING_KV, async () => {
        const state = await scoringState();
        await bb.storage.kv.set(CHIP_SCORING_KV, { ...state, lastError });
      });
      bb.rpc.experimental_invalidate([CHIP_SCORING_TAG]);
    };
    const resolved = await resolveDecisionsKey();
    if ('error' in resolved) return fail(resolved.error, resolved.error);
    let probabilities: Record<string, number>;
    try {
      const response = await fetch(DECISIONS_URL, { method: 'POST', headers: { 'x-goog-api-key': resolved.key, 'content-type': 'application/json' },
        body: JSON.stringify(decisionsRequest(reply, options)), signal: AbortSignal.timeout(15000) });
      if (!response.ok) return fail(`Gemini ответил HTTP ${response.status}`, `HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 1_048_576) return fail('Неверный ответ Gemini', 'response too large');
      const parsed = decisionsResponseSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return fail('Неверный ответ Gemini', 'invalid response');
      probabilities = probabilitiesFor(parsed.data, options.map(o => o.id));
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      const lastError = name === 'TimeoutError' || name === 'AbortError' ? 'Таймаут Gemini' : name === 'SyntaxError' ? 'Неверный ответ Gemini' : 'Gemini недоступен';
      return fail(lastError, name);
    }
    rememberChipScore(key, probabilities);
    bb.rpc.experimental_invalidate([threadTag(threadId), CHIP_SCORING_TAG]);
    const top = options.reduce((a, b) => (probabilities[b.id] ?? 0) > (probabilities[a.id] ?? 0) ? b : a).id;
    bb.log.info(`aif-chat: chips scored threadId=${threadId} options=${options.length} top=${top} ms=${Date.now() - started}`);
    await serial(CHIP_SCORING_KV, async () => {
      const state = await scoringState();
      await bb.storage.kv.set(CHIP_SCORING_KV, { ...state, lastError: null, lastScoredAt: Date.now() });
    });
  }
  async function chipScoringFor(threadId: string, sourceKey: string, reply: string, items: Suggestions['items']) {
    const options = items.filter(item => item.available);
    if (options.length < 2) return;
    if (!(await scoringState()).enabled) return;
    const key = scoringKey(sourceKey, options.map(item => item.id));
    const cached = chipScoreCache.get(key);
    if (cached) {
      for (const item of items) {
        const p = cached[item.id];
        if (p !== undefined) item.probability = p;
      }
      return;
    }
    if (chipScoreInflight.has(key)) return;
    chipScoreInflight.add(key);
    void scoreChips(threadId, key, reply, options.map(item => ({ id: item.id, command: item.command })))
      .catch(() => {}).finally(() => { chipScoreInflight.delete(key); });
  }
  bb.rpc.register(rpcContract, {
    cardVisibility: async input => {
      if (!enabled) return { state: 'hidden' as const };
      const latest = await bb.storage.kv.get<{ cardId: string; environmentId: string }>(`inline-card:${input.threadId}`);
      if (!latest) return { state: 'hidden' as const };
      if (latest.cardId !== input.cardId) return { state: 'superseded' as const };
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      noteEnvironment(input.threadId, thread.environmentId);
      return { state: thread.environmentId === latest.environmentId ? 'current' as const : 'hidden' as const };
    },
    status: input => status(input, input.checkUpdates, input.force),
    setPreparationVisibility: async ({ threadId, visible }) => {
      const { environment } = await context(threadId);
      const key = preparationKey(environment);
      if (visible) await bb.storage.kv.set(key, true);
      else await bb.storage.kv.delete(key);
      bb.rpc.experimental_invalidateAll();
      return { visible };
    },
    planDocument: input => saveCompletedPlan(input.threadId, input.text),
    suggestions: async input => (await suggested(input.threadId)).view,
    delegation: async input => {
      const appliedDefaults = await autoApplyDefaults(input.threadId);
      return { ...await delegationView(input.threadId), appliedDefaults };
    },
    setDelegation: input => serial(`delegation:${input.threadId}`, () => setDelegation(input.threadId, input.choice, input.role)),
    setDelegationDefaults: input => serial(`delegation:${input.threadId}`, () => setDelegationDefaults(input.threadId, input.action)),
    chipScoring: () => chipScoringView(),
    setChipScoring: input => serial('chip-scoring', async () => {
      const view = await setChipScoring(input);
      bb.rpc.experimental_invalidateAll();
      return view;
    }),
    setReadinessSkip: async input => {
      const { environment } = await context(input.threadId);
      const key = `readiness-skip:${environment.hostId}:${environment.path!}`;
      return serial(key, async () => {
        const list = await bb.storage.kv.get<string[]>(key) ?? [];
        if (list.includes(input.stepId) === input.skipped) return { ok: true as const };
        const next = input.skipped ? [...list, input.stepId] : list.filter(id => id !== input.stepId);
        await bb.storage.kv.set(key, next);
        bb.log.info(`aif-chat: readiness skip threadId=${input.threadId} stepId=${input.stepId} skipped=${input.skipped}`);
        cache.invalidate(k => !!watchers.get(k)?.has(input.threadId));
        bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
        return { ok: true as const };
      });
    },
    dismissSuggestion: input => serial(input.threadId, async () => {
      const current = await suggested(input.threadId);
      if (current.view.sourceKey !== input.sourceKey || !current.ids.includes(input.commandId)) throw new Error('Предложения изменились. Обновите их.');
      await bb.storage.kv.set(`suggestions-dismissed:${input.threadId}`, { sourceKey: input.sourceKey, ids: [...new Set([...current.hidden, input.commandId])] } satisfies DismissedSuggestions);
      bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
      return { dismissed: true as const };
    }),
    runSuggestion: input => serial(input.threadId, async () => {
      const deliveries = await bb.storage.kv.get<Delivery[]>(`deliveries:${input.threadId}`) ?? [];
      const previous = deliveries.find(d => d.requestId === input.requestId);
      if (previous) return { sent: false, message: previous.state === 'sent' ? 'Команда уже отправлена.' : 'Исход отправки не подтверждён. Проверьте чат; автоматический повтор отключён.' };
      if (deliveries.some(d => d.state !== 'sent')) throw new Error('Есть отправка с неизвестным исходом. Сначала проверьте чат.');
      const current = await suggested(input.threadId, true);
      const stale = { sent: false, stale: true as const, message: 'Предложения изменились. Проверьте обновлённый список перед запуском.' };
      if (current.view.sourceKey !== input.sourceKey || current.view.fingerprint !== input.fingerprint) return stale;
      const item = current.view.items.find(i => i.id === input.commandId && i.available);
      if (!item || !current.snapshot) throw new Error('Команда недоступна или удалена из предложений.');
      const approval = item.kind === 'improve-approval';
      if (current.snapshot.pendingConfirmation === null) throw new Error('Не удалось проверить ожидание подтверждения. Обновите предложения.');
      if (current.snapshot.pendingConfirmation && !approval) throw new Error('Сначала ответьте на запрос подтверждения в чате.');
      if (current.snapshot.pendingQuestions === null) throw new Error('Не удалось проверить открытые вопросы. Обновите предложения.');
      if (current.snapshot.pendingQuestions) throw new Error('Сначала ответьте на открытые вопросы текущего workflow.');
      const { thread, environment } = await context(input.threadId);
      if (!['idle', 'error'].includes(thread.status) || thread.queuedMessageCount > 0 || thread.activeBackgroundAgentCount > 0) throw new Error('В чате выполняется или уже ожидает работа. Дождитесь завершения.');
      // Reading project files may take time; the last answer can change during it.
      const latest = await bb.sdk.threads.output({ threadId: input.threadId });
      const latestProposal = current.proposal ? pendingImproveProposal(await bb.sdk.threads.events.list({ threadId: input.threadId,
        order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] }), latest.output, current.snapshot.target) : null;
      const special = approval || item.label !== undefined;
      if ((approval && !latestProposal) || suggestionSource(current.snapshot.root, latest.output, latestProposal?.seq) !== input.sourceKey) return stale;
      if (!special) {
        bb.log.info(`aif-chat: chip checked threadId=${input.threadId} commandId=${input.commandId}`);
        return { sent: false, message: 'Команда подставлена в поле ввода.', command: item.command,
          data: { source: 'aif-chat' as const, sourceKey: input.sourceKey, commandId: item.id, fingerprint: input.fingerprint, gate: current.view.gate ?? null } };
      }
      if (!approval) await requireConfirmationAnswer(input.threadId);
      const actionId = `suggestion:${input.sourceKey}:${item.id}`;
      if (deliveries.some(d => d.actionId === actionId && d.state === 'sent')) return { sent: false, message: 'Эта команда уже отправлена из данного ответа.' };
      const record: Delivery = { requestId: input.requestId, fingerprint: input.fingerprint, actionId, state: 'attempting', at: Date.now() };
      const next = [...deliveries.slice(-29), record];
      await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
      try {
        await bb.sdk.threads.send({ threadId: input.threadId, input: [{ type: 'text', text: item.command, mentions: [] }], mode: 'queue-if-active' });
        record.state = 'sent'; await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
      } catch {
        record.state = 'uncertain'; await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
        throw new Error('Исход отправки не подтверждён. Сначала проверьте чат; команда автоматически не повторяется.');
      }
      await bb.storage.kv.set(`suggestions-dismissed:${input.threadId}`, { sourceKey: input.sourceKey, ids: [...new Set([...current.hidden, item.id])] } satisfies DismissedSuggestions);
      cache.invalidate(key => !!watchers.get(key)?.has(input.threadId));
      bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
      return { sent: true, message: 'Команда отправлена в этот чат.' };
    }),
    run: input => serial(input.threadId, async () => {
      if (input.actionId === 'basic-explore' && !input.researchTask) throw new Error('Опишите, что нужно исследовать.');
      if (input.actionId !== 'basic-explore' && input.researchTask !== undefined) throw new Error('Описание исследования допустимо только для кнопки «Исследовать задачу».');
      const deliveries = await bb.storage.kv.get<Delivery[]>(`deliveries:${input.threadId}`) ?? [];
      const existing = deliveries.find(d => d.requestId === input.requestId);
      if (existing) return { sent: false, message: existing.state === 'sent' ? 'Команда уже отправлена.' : 'Исход отправки не подтверждён. Проверьте ленту чата; автоматический повтор отключён.' };
      if (deliveries.some(d => d.state !== 'sent')) throw new Error('Есть отправка с неизвестным исходом. Проверьте чат и явно сбросьте её через bb plugin run aif-chat reset-dispatch.');
      const current = await status(input, false, true);
      if (current.fingerprint !== input.fingerprint) return {
        sent: false, stale: true as const, message: 'Карточка устарела. Проверьте обновлённую задачу и нажмите ещё раз.',
      };
      const candidate = current.actions.find(a => a.id === input.actionId);
      if (candidate?.disabledReason === 'unchanged') throw new Error(unchangedReason);
      if (candidate?.disabledReason === 'context-blocked') throw new Error(candidate.reason);
      const action = candidate?.available ? candidate : undefined;
      if (!action) throw new Error('Действие недоступно для текущего плана/runtime.');
      if (current.pendingConfirmation === null) throw new Error('Не удалось проверить ожидание подтверждения. Обновите карточку.');
      if (current.pendingConfirmation) throw new Error('Сначала ответьте на запрос подтверждения в чате.');
      const skill = action.id === 'basic-commit' ? 'aif-commit' : action.id === 'basic-implement' ? 'aif-implement'
        : action.command.match(/^[/$](aif(?:-[a-z0-9]+)*)\b/)?.[1];
      if (skill && ['aif-commit', 'aif-done', 'aif-archive', 'aif-implement'].includes(skill)) {
        const reply = analyzeReply((await bb.sdk.threads.output({ threadId: input.threadId })).output ?? '');
        if (reply.error || blockedByGate(skill, reply.gate, reply.warning)) throw new Error('Последний gate содержит блокирующие проблемы или некорректен. Сначала разберите его результат.');
      }
      if (current.pendingQuestions) throw new Error('Сначала ответьте на открытые вопросы текущего workflow.');
      if (action.id === 'basic-plan' && current.pendingQuestions === null) throw new Error('Не удалось проверить открытые вопросы. Обновите карточку.');
      const { thread, environment } = await context(input.threadId);
      if (!['idle', 'error'].includes(thread.status) || thread.queuedMessageCount > 0 || thread.activeBackgroundAgentCount > 0) throw new Error('В чате выполняется или уже ожидает работа. Дождитесь завершения.');
      if (action.id === 'basic-plan') {
        const providers = await bb.sdk.providers.list({ environmentId: environment.id });
        const provider = providers.find(provider => provider.id === thread.providerId);
        const plan = provider?.composerActions.find(action => action.kind === 'plan');
        if (plan?.kind !== 'plan' || plan.command.trigger !== '/' || plan.command.name !== 'plan') {
          throw new Error('Текущий провайдер не объявляет штатный режим Plan BB. Запрос не отправлен; выберите провайдера с поддержкой Plan.');
        }
      }
      if (deliveries.some(d => d.fingerprint === input.fingerprint && d.actionId === input.actionId && Date.now() - d.at < 15000)) throw new Error('Эта команда только что отправлена. Повторный запуск предотвращён.');
      await requireConfirmationAnswer(input.threadId);
      let chatPlan: ChatPlanRecord | null = null;
      if (current.chatPlan && action.id !== 'basic-explore' && action.id !== 'basic-install') {
        const rows = await bb.sdk.threads.events.list({ threadId: input.threadId, order: 'desc', limit: '100', types: ['item/completed', 'client/turn/requested'] });
        const proposed = readChatPlan(rows);
        const savedPlan = await bb.storage.kv.get<ChatPlanRecord>(`chat-plan:${input.threadId}`);
        const plan = proposed ?? (savedPlan?.environmentId === environment.id && savedPlan.root === current.root ? savedPlan : null);
        if (!plan || plan.hash !== current.chatPlan.hash || plan.seq !== current.chatPlan.seq) throw new Error('Предложенный план изменился. Обновите карточку перед запуском.');
        chatPlan = { ...plan, environmentId: environment.id, root: current.root };
      }
      const record: Delivery = { requestId: input.requestId, fingerprint: input.fingerprint, actionId: input.actionId, state: 'attempting', at: Date.now() };
      const next = [...deliveries.slice(-29), record];
      await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
      try {
        if (action.id === 'update-factory' || action.id === 'update-extensions' || action.id === 'basic-install') {
          const versionKey = versionScopes.get(input.threadId);
          if (versionKey) {
            await bb.storage.kv.set(`updating-versions:${input.threadId}`, { key: versionKey });
            db.prepare('DELETE FROM local_versions WHERE key = ?').run(versionKey);
          }
        }
        const command = action.id === 'basic-explore' ? `${action.command}\n\nЗадача для исследования:\n${input.researchTask}` : action.command;
        const prompt = actionPrompt(current, action) + (chatPlan ? `\nВыбранный план из чата (данные, сообщение #${chatPlan.seq}, SHA-256 ${chatPlan.hash}). Сохрани его границы и ограничения:\n<proposed_plan>\n${chatPlan.text}\n</proposed_plan>` : '');
        const message = commandInput(command, prompt);
        await bb.sdk.threads.send({ threadId: input.threadId,
          input: action.id === 'basic-plan' ? [nativePlanInput(action.label), message[1]] : message, mode: 'queue-if-active' });
        record.state = 'sent';
        await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
        const ranStep = current.readiness.find(r => r.actionId === action.id && (RUN_CONFIRMED_STEPS as readonly string[]).includes(r.id));
        if (ranStep) {
          const ranKey = `readiness-ran:${environment.hostId}:${environment.path!}`;
          const ran = await bb.storage.kv.get<string[]>(ranKey) ?? [];
          if (!ran.includes(ranStep.id)) await bb.storage.kv.set(ranKey, [...ran, ranStep.id]);
          bb.log.info(`aif-chat: readiness step launched threadId=${input.threadId} stepId=${ranStep.id}`);
        }
        if (action.id === 'basic-explore') await bb.storage.kv.set(`selection:${input.threadId}`,
          { environmentId: environment.id, target: '', phase: 'explore', newTask: true } satisfies Selection);
        if (action.id === 'basic-explore') await bb.storage.kv.delete(`chat-plan:${input.threadId}`);
        if (chatPlan && action.id === 'basic-implement') {
          await bb.storage.kv.set(`chat-plan:${input.threadId}`, chatPlan);
          await bb.storage.kv.set(`selection:${input.threadId}`, { environmentId: environment.id, target: '', phase: 'implement', newTask: true } satisfies Selection);
        }
        if (action.id === 'basic-plan') await bb.storage.kv.set(`inline-card:${input.threadId}`, { cardId: randomUUID(), environmentId: environment.id });
      } catch {
        record.state = 'uncertain';
        await bb.storage.kv.set(`deliveries:${input.threadId}`, next);
        throw new Error('Исход отправки не подтверждён. Сначала проверьте чат; команда автоматически не повторяется.');
      }
      cache.invalidate(key => !!watchers.get(key)?.has(input.threadId)); bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
      return { sent: true, message: 'Команда отправлена в этот чат.', ...(action.id === 'basic-explore' || chatPlan && action.id === 'basic-implement' ? { newTask: true } : {}) };
    }),
    aifMode: async input => {
      const { threadId, projectId } = await aifModeTarget(input);
      return aifModeView(threadId, projectId, getMode(projectId));
    },
    setAifMode: input => serial(`aif-mode:${input.projectId ?? input.threadId}`, async () => {
      const { threadId, projectId } = await aifModeTarget(input);
      setMode(projectId, input.on);
      bb.log.info(`aif-chat: aif-mode set projectId=${projectId} on=${input.on}`);
      bb.rpc.experimental_invalidate([projectTag(projectId), ...(threadId ? [threadTag(threadId)] : [])]);
      return aifModeView(threadId, projectId, input.on);
    }),
  });
  const liveRoots = new Map<string, { hostId: string; root: string; refs: number; retriedAt: number }>();
  // A loss within this window of the last retry counts as consecutive: give up instead of looping.
  const RETRY_WINDOW_MS = 60_000;
  const mayRetry = (live: { retriedAt: number }) => !live.retriedAt || Date.now() - live.retriedAt >= RETRY_WINDOW_MS;
  const liveKey = (hostId: string, root: string) => `${hostId}:${root}`;
  const errMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const invalidateRoot = (hostId: string, root: string) => {
    const threadIds = new Set<string>();
    cache.invalidate(key => {
      let match = false;
      try {
        const parts: unknown = JSON.parse(key);
        // Match by root only: the signal's hostId and environment.hostId may name the same daemon differently.
        match = Array.isArray(parts) && parts[2] === root;
      } catch { /* Keys that are not JSON arrays cannot belong to a project root. */ }
      if (match) for (const id of watchers.get(key) ?? []) threadIds.add(id);
      return match;
    });
    bb.log.debug(`aif-chat: files changed root=${root} hostId=${hostId} threads=${threadIds.size}`);
    if (threadIds.size) bb.rpc.experimental_invalidate([...threadIds].map(threadTag));
  };
  const rewatch = (hostId: string, root: string) => {
    host.call('watch', { root }, { hostId }).catch(error => bb.log.warn(`aif-chat: watch retry failed root=${root}: ${errMessage(error)}`));
  };
  const offFilesChanged = host.experimental_onSignal('filesChanged', ({ hostId, payload }) => invalidateRoot(hostId, payload.root));
  const offWatchLost = host.experimental_onSignal('watchLost', ({ hostId, payload }) => {
    bb.log.warn(`aif-chat: watch lost root=${payload.root} reason=${payload.reason}`);
    invalidateRoot(hostId, payload.root);
    const live = [...liveRoots.values()].find(entry => entry.root === payload.root);
    if (!live) return;
    if (!mayRetry(live)) { bb.log.warn(`aif-chat: watch lost again root=${payload.root}; staying unwatched`); return; }
    live.retriedAt = Date.now();
    rewatch(live.hostId, payload.root);
  });
  const offWorkerExit = host.experimental_onWorkerExit(({ hostId }) => {
    bb.log.warn(`aif-chat: host worker exited hostId=${hostId}`);
    for (const live of liveRoots.values()) {
      // Same hostId caveat as invalidateRoot; a redundant watch call is a no-op on a healthy host.
      invalidateRoot(hostId, live.root);
      if (!mayRetry(live)) continue;
      live.retriedAt = Date.now();
      rewatch(hostId, live.root);
    }
  });
  bb.rpc.experimental_whileWatched('status', (read, signal) => {
    if (!('input' in read)) return;
    const input = read.input;
    if (!input || typeof input !== 'object' || !('threadId' in input)) return;
    const threadId = input.threadId;
    if (typeof threadId !== 'string') return;
    void (async () => {
      const { environment } = await context(threadId);
      if (signal.aborted) return;
      const root = environment.path!;
      const hostId = environment.hostId;
      const key = liveKey(hostId, root);
      let live = liveRoots.get(key);
      if (!live) { live = { hostId, root, refs: 0, retriedAt: 0 }; liveRoots.set(key, live); }
      live.refs += 1;
      if (live.refs === 1) {
        try {
          await host.call('watch', { root }, { hostId });
          live.retriedAt = 0;
          bb.log.debug(`aif-chat: watch on root=${root} hostId=${hostId} refs=${live.refs}`);
        } catch (error) {
          bb.log.warn(`aif-chat: watch failed root=${root}: ${errMessage(error)}`);
        }
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const entry = liveRoots.get(key);
        if (!entry) return;
        entry.refs -= 1;
        bb.log.debug(`aif-chat: watch release root=${root} refs=${entry.refs}`);
        if (entry.refs > 0) return;
        liveRoots.delete(key);
        host.call('unwatch', { root }, { hostId }).catch(error => { if (!disposed) bb.log.warn(`aif-chat: unwatch failed root=${root}: ${errMessage(error)}`); });
      };
      signal.addEventListener('abort', release, { once: true });
      if (signal.aborted) release();
    })().catch(error => bb.log.warn(`aif-chat: status watch failed threadId=${threadId}: ${errMessage(error)}`));
  });
  bb.agents.registerTool({
    name: 'aif_chat_status',
    description: 'Read AI Factory versions, installed extensions, selected plan progress and QA reports in this thread. Returns a previewDirective for a live workflow card. Does not run workflow commands, tests or update installations. phase is agent-declared, not a QA verdict.',
    parameters: z.object({ target: z.string().max(1000).optional(), phase: phaseSchema.optional() }).strict(),
    presentation: { label: { pending: 'Читаю статус AI Factory', completed: 'Статус AI Factory' } },
    async execute(input, ctx) {
      const result = await show({ threadId: ctx.threadId, target: input.target ?? '', phase: input.phase ?? 'unknown' });
      return JSON.stringify({ previewDirective: result.previewDirective, versions: result.snapshot.versions, profile: result.snapshot.profile,
        target: result.snapshot.target?.path ?? null, progress: result.snapshot.target ? { completed: result.snapshot.target.tasks.filter(t => t.done).length, total: result.snapshot.target.tasks.length } : null,
        chatPlan: result.snapshot.chatPlan ?? null,
        awaitingUser: !!(result.snapshot.pendingConfirmation || result.snapshot.pendingQuestions),
        checks: result.snapshot.checks, diagnostics: result.snapshot.diagnostics });
    },
  });
  bb.agents.configure(ctx => {
    if (!enabled) return { tools: [], skills: [], instructions: '' };
    let modeOn = false;
    try { modeOn = getMode(ctx.project.id); } catch (error) { bb.log.warn(`aif-chat: aif-mode read failed projectId=${ctx.project.id}: ${error instanceof Error ? error.message : String(error)}`); }
    const mode = shouldContribute({ enabled, modeOn, parentThreadId: ctx.thread.parentThreadId }) ? '\n\n' + aifModeInstructions() : '';
    return { tools: ["aif_chat_status"], skills: [...PLUGIN_SKILLS], instructions: 'For AI Factory/AIFHub work, use aif_chat_status at workflow boundaries or explicit status requests and emit its previewDirective exactly once on its own line. The directive renders real workflow buttons and read-only plan/check progress. Do not wrap it in code. Report the phase actually reached, preserve exact owner handoffs and gate blocks. Never add a directive after a required final aif-gate-result or proposed_plan, or inside an exact-handoff-only response. Native Plan responses must end with the plan block; the persistent panel discovers the proposal without extra markup. Do not call for unrelated tasks or repeat unchanged cards. When asking the user to confirm scope or answer a clarification, wait for their answer without adding a workflow card. If awaitingUser is true or previewDirective is empty, emit no directive. Existing authorization persists; do not invent approval questions. Buttons are optional navigation, not required questions. No workflow action runs until the user clicks or has already authorized it. Plugin phase is a declaration; file reports are not proof of current PASS.' + mode };
  });
  bb.ui.registerMentionProvider({
    id: AIF_MENTION.provider,
    label: 'AI Factory',
    search: ({ query }) => {
      if (!enabled) return [];
      return aifMentionItems(query);
    },
    resolve: itemId => {
      if (itemId !== AIF_MENTION.id) throw new Error('Неизвестное упоминание AI Factory.');
      bb.log.info('aif-chat: aif-mode mention resolved');
      return { context: aifModeInstructions() };
    },
  });
  // Parallel /aif-implement: the git and spawn steps run here and on the folder's machine, so no path or JSON ever
  // passes through the coordinator's shell (PowerShell, quoting, `git status` output copied by hand).
  async function parallelCommand(command: 'spawn-worker' | 'bring-back', threadId: string, target: string, options: Record<string, string>) {
    const { thread, environment } = await context(threadId);
    const root = environment.path!, hostId = environment.hostId;
    const planName = (target.split(/[\\/]/).pop() ?? 'plan').replace(/\.md$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'plan';
    if (command === 'spawn-worker') {
      // Models write `task-1`, `Task 1` or `#1`: keep only the number.
      const task = options['--task']?.trim().replace(/^(?:task[\s#_-]?|#)(?=\d)/i, ''), brief = options['--brief'];
      if (!target) throw new Error('Укажите план: --target <путь>.');
      if (!/^\d{1,6}(?:\.\d{1,6}){0,5}$/.test(task ?? '')) throw new Error('Укажите номер задачи: --task <id> (например 3 или 1.2).');
      if (!brief) throw new Error('Укажите файл задания: --brief <файл>.');
      const state = await host.call('delegation', { root }, { hostId });
      if (state.choice.mode !== 'bb') throw new Error('Делегирование кода выключено: выполняйте задачи сами.');
      const choice = state.choice;
      // The setting is read at each launch: a coordinator still following the parallel block after the owner turned it off must not spawn.
      if (!choice.parallel) throw new Error('Параллельный режим выключен: перечитайте блок в .ai-factory/skill-context/aif-implement/SKILL.md и работайте одним исполнителем.');
      // BB's own record, not a list kept here: every unarchived child this plugin spawned under the chat counts — renamed,
      // restored from the archive or started by an older version — and a failed write can never lose a live worker.
      const running = (await bb.sdk.threads.list({ parentThreadId: threadId, originPluginId: 'aif-chat', archived: false, includeHidden: true, limit: 200 }))
        .filter(t => !t.archivedAt);
      if (running.length >= choice.parallel) throw new Error(`Уже запущено исполнителей: ${running.length} из ${choice.parallel}. Дождитесь их, перенесите результат и архивируйте (bb thread archive <id>), затем запускайте следующих.`);
      const { text } = await host.call('readBrief', { path: brief }, { hostId });
      const { sha } = await host.call('headCommit', { root }, { hostId });
      // A fresh suffix per launch: a retry never collides with a copy BB has not removed yet.
      const name = `${planName}-${task}-${randomUUID().slice(0, 8)}`;
      const prompt = `${text.trim()}\n\nYou work in your own copy of the project: the folder BB opened this thread in. Before any change run \`git rev-parse --show-toplevel\`; if it fails, \`cd\` into that folder first. The copy already holds the coordinator's uncommitted work from earlier tasks: \`git status\` shows it as changes. Keep it. Change files only: do not run git commands that change the index or the history (\`git add\`, \`rm\`, \`mv\`, \`stash\`, \`reset\`, \`checkout\`, \`restore\`, \`commit\`); the coordinator takes your changes from the files. If dependencies are missing, install them first. Do not commit.`;
      const spawned = await bb.sdk.threads.spawn({
        projectId: thread.projectId, origin: 'plugin', title: `AIF · ${planName} · ${task}`, prompt,
        environment: { type: 'provider', environmentProviderId: WORKTREE_PROVIDER_ID, inputs: { basePath: root, name, ref: sha, seed: true }, machine: { type: 'existing', hostId } },
        parentThreadId: threadId, lifecycleOwnerThreadId: threadId, parentNotifications: 'off',
        providerId: choice.providerId, model: choice.model,
        ...(choice.reasoning ? { reasoningLevel: choice.reasoning } : {}),
        // The worker never inherits the coordinator's tier: the Code role's tier, or default.
        serviceTier: choice.tier || 'default',
        // Without a source BB drops the provider and model and starts the provider's default one.
        executionInputSources: { providerId: 'explicit', model: 'explicit',
          ...(choice.reasoning ? { reasoningLevel: 'explicit' as const } : {}), serviceTier: 'explicit' },
      });
      bb.log.info(`aif-chat: worker spawned threadId=${threadId} worker=${spawned.id} task=${task} sha=${sha.slice(0, 12)} running=${running.length + 1}/${choice.parallel}`);
      const data = { id: spawned.id, task, name, sha };
      return { ok: true, data, text: `Исполнитель задачи ${task}: ${spawned.id}` };
    }
    const workerId = options['--worker'];
    if (!/^[\w-]{1,200}$/.test(workerId ?? '')) throw new Error('Укажите исполнителя: --worker <id треда>.');
    const worker = await bb.sdk.threads.get({ threadId: workerId });
    if (worker.parentThreadId !== threadId) throw new Error(`Тред ${workerId} не исполнитель этого чата.`);
    if (!worker.environmentId) throw new Error(`У исполнителя ${workerId} нет рабочей среды.`);
    const env = await bb.sdk.environments.get({ environmentId: worker.environmentId });
    if (env.environmentProviderId !== WORKTREE_PROVIDER_ID || env.hostId !== hostId || !env.path) throw new Error(`Исполнитель ${workerId} работает не в копии AI Factory на этой машине.`);
    const result = await host.call('bringBack', { root, copy: env.path }, { hostId });
    bb.log.info(`aif-chat: bring-back threadId=${threadId} worker=${workerId} applied=${result.applied} files=${result.files.length}`);
    const text = result.applied ? `Перенесено файлов: ${result.files.length}\n${result.files.join('\n')}`
      : result.empty ? 'Исполнитель ничего не изменил.'
      : result.partial ? `Запись прервалась, и эти файлы не удалось вернуть как было: ${result.files.join(', ')}\n${result.error}`
      : `Патч не ложится, рабочая папка не изменена:\n${result.error}`;
    return { ok: result.applied || !!result.empty, data: result, text };
  }
  bb.cli.register({
    name: 'aif-chat', summary: 'AI Factory versions, live workflow card and read-only plan/check progress',
    commands: [...['status', 'show', 'save-plan', 'mark-verified', 'check-updates', 'reset', 'reset-dispatch'].map(name => ({ name, summary: name === 'show' ? 'Show a live chat card' : name, usage: `bb plugin run aif-chat ${name} [--thread <id>] [--target <path>] [--phase <phase>] [--json]` })),
      { name: 'spawn-worker', summary: 'Start a parallel worker on its own copy of the project', usage: 'bb plugin run aif-chat spawn-worker --target <plan> --task <id> --brief <file> [--json]' },
      { name: 'bring-back', summary: 'Apply a parallel worker\'s changes to this workspace', usage: 'bb plugin run aif-chat bring-back --worker <thread id> [--json]' },
      { name: 'wait-worker', summary: 'Wait up to 90 s for a worker of this chat, with no gap between calls', usage: 'bb plugin run aif-chat wait-worker --worker <thread id> [--after <seq>] [--json]' }],
    async run(argv, ctx) {
      try {
        const [command = 'help', ...args] = argv;
        if (command === 'help' || command === '--help') return { exitCode: 0, stdout: 'bb plugin run aif-chat status|show|save-plan|mark-verified|check-updates|reset|reset-dispatch|spawn-worker|bring-back|wait-worker [--thread ID] [--target PATH] [--phase explore|plan|improve|implement|verify|fix|done] [--json]' };
        const options: Record<string, string> = {}; let json = false;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--json') { json = true; continue; }
          if (!['--thread', '--target', '--phase', '--max', '--group', '--token', '--task', '--brief', '--worker', '--after'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Неизвестный аргумент или отсутствует значение.');
          if (args[i] in options) throw new Error('Повторяющийся аргумент.');
          const name = args[i]; options[name] = args[++i];
        }
        const input = requestSchema.parse({ threadId: options['--thread'] ?? ctx.threadId, target: options['--target'] ?? '', phase: options['--phase'] ?? 'unknown' });
        if (command === 'mark-verified') return serial(`plan-verification:${input.threadId}`, async () => {
          if (!input.target) throw new Error('Укажите точный путь базового плана через --target.');
          const { environment } = await context(input.threadId);
          const snapshot = await status({ ...input, phase: 'verify' }, false, true);
          if (snapshot.profile !== 'none' || snapshot.target?.kind !== 'basic' || !snapshot.target.verification
            || !snapshot.target.tasks.length || snapshot.target.tasks.some(task => !task.done)
            || snapshot.pendingQuestions !== 0 || snapshot.pendingConfirmation !== false) throw new Error('Отметка недоступна: план не завершён, не является базовым или ожидается ответ пользователя.');
          const latest = await context(input.threadId);
          if (latest.environment.id !== environment.id || latest.environment.hostId !== environment.hostId || latest.environment.path !== snapshot.root
            || !['idle', 'active'].includes(latest.thread.status) || latest.thread.queuedMessageCount || latest.thread.activeBackgroundAgentCount)
            throw new Error('Контекст изменился или в чате ожидается другая работа. Перечитайте план.');
          let result: { path: string; verified: true };
          try {
            result = await host.call('markPlanVerified', { root: snapshot.root, target: snapshot.target.path,
              expectedHash: snapshot.target.verification.contentHash }, { hostId: environment.hostId });
          } catch (error) {
            bb.log.warn(`aif-chat: verification mark failed threadId=${input.threadId}: ${errMessage(error)}`);
            throw error;
          }
          bb.log.debug(`aif-chat: plan verified threadId=${input.threadId} path=${result.path}`);
          cache.invalidate(key => !!watchers.get(key)?.has(input.threadId));
          bb.rpc.experimental_invalidate([threadTag(input.threadId)]);
          return { exitCode: 0, stdout: json ? JSON.stringify(result) : 'Отметка проверки записана. Файл плана сохранён.' };
        });
        if (command === 'save-plan') {
          if (input.target || input.phase !== 'unknown') throw new Error('save-plan сохраняет только последний готовый план из ответа, без --target и --phase.');
          const result = await saveCompletedPlan(input.threadId);
          if (!result) throw new Error('В последнем завершённом ответе нет готового плана или чат занят.');
          return { exitCode: 0, stdout: json ? JSON.stringify(result) : result.path };
        }
        if (command === 'reset' || command === 'reset-dispatch') {
          await context(input.threadId);
          await bb.storage.kv.delete(`${command === 'reset' ? 'selection' : 'deliveries'}:${input.threadId}`);
          if (command === 'reset') await bb.storage.kv.delete(`chat-plan:${input.threadId}`);
          cache.invalidate(key => !!watchers.get(key)?.has(input.threadId)); return { exitCode: 0, stdout: 'Состояние интерфейса сброшено; проект не изменён.' };
        }
        // `groups` and `checkpoint` were removed; a coordinator still holding the old managed block falls back to the one-worker flow.
        if (command === 'groups' || command === 'checkpoint') {
          const error = `Команда ${command} удалена: перечитайте блок параллельного режима в .ai-factory/skill-context/aif-implement/SKILL.md (откройте вкладку AI Factory), а до этого работайте одним исполнителем.`;
          return json ? { exitCode: 0, stdout: JSON.stringify({ error }) } : { exitCode: 1, stderr: error };
        }
        if (command === 'wait-worker') {
          // Any child of this chat: a parallel worker, the one-worker flow's thread or a research worker.
          const workerId = options['--worker'], after = options['--after'] ?? '0';
          if (!/^[\w-]{1,200}$/.test(workerId ?? '')) throw new Error('Укажите исполнителя: --worker <id треда>.');
          if (!/^\d{1,15}$/.test(after)) throw new Error('--after — номер события из прошлого ответа (seq).');
          const worker = await bb.sdk.threads.get({ threadId: workerId });
          if (worker.parentThreadId !== input.threadId) throw new Error(`Тред ${workerId} не исполнитель этого чата.`);
          const result = await waitWorker(bb.sdk.threads, workerId, Number(after));
          const text = `${result.state} seq=${result.seq} quietForMs=${result.quietForMs}\n${result.output ?? ''}`;
          return { exitCode: 0, stdout: json ? JSON.stringify(result) : text };
        }
        if (command === 'spawn-worker' || command === 'bring-back') {
          // Launches of one chat run one by one, so two at once cannot both pass the worker limit.
          const run = () => parallelCommand(command, input.threadId, input.target, options);
          const result = command === 'spawn-worker' ? await serial(`spawn-worker:${input.threadId}`, run) : await run();
          return { exitCode: result.ok ? 0 : 1, stdout: json ? JSON.stringify(result.data) : result.text };
        }
        if (!['status', 'show', 'check-updates'].includes(command)) throw new Error('Неизвестная команда.');
        if (command === 'show') {
          const result = await show(input);
          return { exitCode: 0, stdout: json ? JSON.stringify(result) : result.previewDirective };
        }
        const result = await status(input, command === 'check-updates', true);
        return { exitCode: 0, stdout: json ? JSON.stringify(result) : `AI Factory: global ${result.versions.globalCli ?? 'unknown'}, project ${result.versions.installed ?? 'unknown'}\n${result.profile} · ${result.target?.path ?? 'задача не выбрана'}\n${result.diagnostics.join('\n')}` };
      } catch (e: any) { return { exitCode: 1, stderr: String(e.message).slice(0, 1000) }; }
    },
  });
  for (const event of ['thread.active', 'thread.idle', 'thread.failed'] as const) bb.events.on(event, ({ thread }) => {
    if (event !== 'thread.active') {
      historyEpochs.set(thread.id, (historyEpochs.get(thread.id) ?? 0) + 1);
      for (const key of histories.keys()) if (key.includes(thread.id)) histories.delete(key);
      cache.invalidate(key => !!watchers.get(key)?.has(thread.id) || !!thread.environmentId && key.includes(thread.environmentId));
    }
    bb.rpc.experimental_invalidate([threadTag(thread.id), ...(thread.parentThreadId ? [threadTag(thread.parentThreadId)] : [])]);
  });
  bb.events.on('thread.idle', async ({ thread, lastAssistantText }) => {
    try { await saveCompletedPlan(thread.id); }
    catch { bb.log.warn('Could not save the completed plan; its response remains intact and the document view can retry.'); }
    const updating = await bb.storage.kv.get<{ key: string }>(`updating-versions:${thread.id}`);
    if (updating) {
      db.prepare('DELETE FROM local_versions WHERE key = ?').run(updating.key);
      await bb.storage.kv.delete(`updating-versions:${thread.id}`);
      cache.invalidate(key => !!watchers.get(key)?.has(thread.id));
      bb.rpc.experimental_invalidate([threadTag(thread.id)]);
    }
    const reply = analyzeReply(lastAssistantText ?? '');
    if (!enabled || !reply.gate || reply.error || reply.warning) return;
    // Only a live completion can establish a comparison baseline. Loading an
    // old report must never silently bind it to today's files.
    try {
      const { environment } = await context(thread.id);
      let snapshot = await status({ threadId: thread.id, target: '', phase: 'unknown' }, false, true);
      const storageKey = chatStorageKey(thread.id, environment.id, environment.hostId, snapshot.root);
      const records = await bb.storage.kv.get<ChatCheck[]>(storageKey) ?? [];
      const record = records.filter(r => JSON.stringify(r.result) === JSON.stringify(reply.gate))
        .sort((a, b) => b.seq - a.seq)[0];
      const age = record ? Date.now() - Date.parse(record.at) : Infinity;
      if (!record || record.inputFingerprint || age < 0 || age > 60000) return;
      if (snapshot.target?.path !== record.target) snapshot = await status({ threadId: thread.id, target: record.target, phase: 'unknown' }, false, true);
      const current = await context(thread.id);
      if (current.environment.id !== environment.id || current.environment.path !== snapshot.root || current.environment.hostId !== environment.hostId
        || snapshot.target?.path !== record.target || current.thread.status !== 'idle' || current.thread.queuedMessageCount || current.thread.activeBackgroundAgentCount || !snapshot.inputsFingerprint) return;
      await serial(`history:${storageKey}`, async () => {
        const latest = await bb.storage.kv.get<ChatCheck[]>(storageKey) ?? [];
        const found = latest.find(r => r.seq === record.seq && r.target === record.target);
        if (found && !found.inputFingerprint) {
          found.inputFingerprint = snapshot.inputsFingerprint!;
          found.observedAt = snapshot.collectedAt;
          await bb.storage.kv.set(storageKey, latest);
        }
      });
      for (const key of histories.keys()) if (key.includes(thread.id)) histories.delete(key);
      bb.rpc.experimental_invalidate([threadTag(thread.id)]);
    } catch { bb.log.warn('Could not bind completed gate to workspace inputs; repeat checks remain available.'); }
  });
  bb.events.on('thread.deleted', async ({ thread }) => {
    historyEpochs.delete(thread.id);
    threadEnvironments.delete(thread.id);
    for (const listeners of watchers.values()) listeners.delete(thread.id);
    await bb.storage.kv.delete(`selection:${thread.id}`); await bb.storage.kv.delete(`deliveries:${thread.id}`);
    await bb.storage.kv.delete(`inline-card:${thread.id}`);
    await bb.storage.kv.delete(`plan-document:${thread.id}`);
    await bb.storage.kv.delete(`chat-plan:${thread.id}`);
    await bb.storage.kv.delete(`session-brief:${thread.id}`);
    await bb.storage.kv.delete(`suggestions-dismissed:${thread.id}`);
    await bb.storage.kv.delete(`updating-versions:${thread.id}`); versionScopes.delete(thread.id);
  });
  bb.onDispose(() => { disposed = true; liveRoots.clear(); offFilesChanged(); offWatchLost(); offWorkerExit(); cache.dispose(); histories.clear(); historyLoads.clear(); historyEpochs.clear(); watchers.clear(); versionScopes.clear(); queues.clear(); });
}
