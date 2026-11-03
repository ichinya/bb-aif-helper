import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { snapshotSchema, type HostInput, type Snapshot } from './model.ts';
import { workflowActions } from './workflow.ts';

const exec = promisify(execFile);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 200;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
export function safeRelative(value: string): string {
  if (!value || value.length > 1000 || path.isAbsolute(value) || /^[A-Za-z]:|[\x00-\x1f]/.test(value)) throw new Error('Нужен относительный путь внутри проекта.');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(p => !p || p === '..' || p === '.' || p === '.git' || p.includes(':'))) throw new Error('Недопустимый путь артефакта.');
  return normalized;
}
export function parseYaml(text: string): Record<string, any> {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Некорректный YAML или повторяющиеся ключи.');
  const value = doc.toJS({ maxAliasCount: 20 });
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Корень YAML должен быть mapping.');
  return obj(value);
}
export function taskList(text: string): NonNullable<Snapshot['target']>['tasks'] {
  let fenced = false;
  let comment = false;
  const tasks: NonNullable<Snapshot['target']>['tasks'] = [];
  let index = 0;
  // Frontmatter, comments, code samples and deeply-indented examples are not progress.
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/);
  const section = lines.findIndex(v => /^#{1,6}\s+(?:Tasks|Task List|Implementation Tasks|Задачи|План выполнения)\s*$/i.test(v));
  const sectionLevel = section >= 0 ? lines[section].match(/^#+/)![0].length : 0;
  let listActive = false;
  for (let line = section >= 0 ? section + 1 : 0; line < lines.length; line++) {
    const raw = lines[line];
    if (raw.includes('<!--')) comment = true;
    if (comment) { if (raw.includes('-->')) comment = false; continue; }
    if (/^\s{0,3}(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (sectionLevel && new RegExp(`^#{1,${sectionLevel}}\\s`).test(raw)) break;
    const m = raw.match(/^( *)[-*+] \[([ xX])\]\s+(.+)$/);
    if (m) {
      if (m[1].length >= 4 && !listActive) continue;
      listActive = true;
      const title = m[3].trim().slice(0, 500);
      tasks.push({ id: title.match(/^(?:Task\s+)?(\d+(?:\.\d+)*)\b/i)?.[1] ?? `task-${++index}`, title, done: m[2].toLowerCase() === 'x' });
    } else if (/^\S/.test(raw)) listActive = false;
  }
  if (tasks.length > 300) throw new Error('Более 300 задач: выберите меньший scope.');
  return tasks;
}
export function lastGate(text: string, gate: string): { status: string; blocking: boolean } | null {
  const blocks = [...text.matchAll(/^```aif-gate-result[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
  if (!blocks.length) return null;
  try {
    const value = JSON.parse(blocks.at(-1)![1]);
    if (value.schema_version !== 1 || value.gate !== gate || !['pass', 'warn', 'fail'].includes(value.status) || typeof value.blocking !== 'boolean' || !Array.isArray(value.blockers) || !Array.isArray(value.affected_files)) return null;
    if (value.status === 'pass' && (value.blocking || value.blockers.length)) return null;
    if (value.status === 'fail' && !value.blocking) return null;
    return { status: value.status, blocking: value.blocking };
  } catch { return null; }
}

class Reader {
  readonly seen = new Map<string, string>();
  constructor(readonly root: string) {}
  async resolve(rel: string): Promise<string> {
    rel = safeRelative(rel);
    let current = this.root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Ссылка или junction в пути артефакта.'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    return current;
  }
  async read(rel: string): Promise<string | null> {
    if (this.seen.size >= MAX_FILES && !this.seen.has(rel)) throw new Error('Превышен лимит чтения metadata.');
    const filename = await this.resolve(rel);
    try {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error(`Артефакт не является файлом или больше 1 MiB: ${rel}`);
      const text = await fs.readFile(filename, 'utf8');
      this.seen.set(rel, hash(text));
      return text;
    } catch (e: any) { if (e.code === 'ENOENT') { this.seen.set(rel, 'missing'); return null; } throw e; }
  }
  async json(rel: string): Promise<Record<string, any> | null> {
    const text = await this.read(rel);
    return text === null ? null : obj(JSON.parse(text));
  }
  async list(rel: string): Promise<{ name: string; directory: boolean }[]> {
    try {
      const items = await fs.readdir(await this.resolve(rel), { withFileTypes: true });
      if (items.length > 300) throw new Error(`Слишком много записей: ${rel}`);
      return items.filter(e => !e.isSymbolicLink()).map(e => ({ name: e.name, directory: e.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  }
}

async function git(root: string, args: string[], signal?: AbortSignal, trim = true): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor=false', '-C', root, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
    return trim ? stdout.trim() : stdout;
  } catch { return null; }
}
function sourceLabel(value: unknown): string {
  if (typeof value !== 'string') return 'не указан';
  if (/^[A-Za-z]:|^\.{0,2}[\\/]|^file:/.test(value)) return 'локальный источник';
  return value.replace(/(https?:\/\/)[^/@]+@/g, '$1').split(/[?#]/)[0].slice(0, 200);
}
async function globalPackage(): Promise<{ version: string | null; source: string | null }> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const shims = process.platform === 'win32' ? ['ai-factory.cmd', 'ai-factory.ps1'] : ['ai-factory'];
      let found = false;
      for (const shim of shims) { try { await fs.access(path.join(dir, shim)); found = true; break; } catch { /* next */ } }
      if (!found) continue;
      const candidates = [path.join(dir, 'node_modules/ai-factory/package.json'), path.resolve(dir, '../lib/node_modules/ai-factory/package.json')];
      // Unix npm links can point directly at the package bin.
      try { const resolved = await fs.realpath(path.join(dir, 'ai-factory')); candidates.push(path.resolve(resolved, '../../package.json')); } catch { /* optional link */ }
      for (const file of candidates) {
        try { const p = JSON.parse(await fs.readFile(file, 'utf8')); if (p.name === 'ai-factory') return { version: str(p.version), source: file }; } catch { /* not this layout */ }
      }
    } catch { /* inspect next PATH entry without running the shim */ }
  }
  return { version: null, source: null };
}
async function sourceVersion(root: string, signal?: AbortSignal): Promise<Snapshot['versions']> {
  const empty: Snapshot['versions'] = { globalCli: null, globalSource: null, installed: null, sourceVersion: null, sourceWorktreeVersion: null, sourceSha: null, sourceDirty: null };
  if (!root) return empty;
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'ai-factory') throw new Error('Source checkout не является AI Factory.');
  empty.sourceWorktreeVersion = str(pkg.version);
  empty.sourceSha = await git(root, ['rev-parse', 'HEAD'], signal);
  const headPkg = await git(root, ['show', 'HEAD:package.json'], signal);
  if (headPkg) empty.sourceVersion = str(JSON.parse(headPkg).version);
  const status = await git(root, ['status', '--porcelain', '--untracked-files=no'], signal);
  empty.sourceDirty = status === null ? null : status.length > 0;
  return empty;
}
async function upstream(repo: string, ref: string, signal?: AbortSignal): Promise<Snapshot['upstream']> {
  const result: Snapshot['upstream'] = { version: null, sha: null, ref: null, checkedAt: new Date().toISOString(), error: null };
  async function json(url: string): Promise<any> {
    const deadline = AbortSignal.timeout(5000);
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bb-aif-chat' }, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_FILE) throw new Error('Ответ upstream слишком велик.');
    return JSON.parse(text);
  }
  try {
    if (!ref) {
      const release = await json(`https://api.github.com/repos/${repo}/releases/latest`);
      if (typeof release.tag_name !== 'string' || release.prerelease || release.draft) throw new Error('Стабильный релиз не найден.');
      ref = release.tag_name;
    }
    const commit = await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Неизвестная ревизия upstream.');
    result.sha = commit.sha; result.ref = ref;
    const pkg = await json(`https://raw.githubusercontent.com/${repo}/${commit.sha}/package.json`);
    if (pkg.name !== 'ai-factory') throw new Error('Upstream package не является AI Factory.');
    result.version = str(pkg.version);
  } catch (e: any) { result.error = String(e.message).slice(0, 200); }
  return result;
}

export async function collectSnapshot(input: HostInput, signal?: AbortSignal): Promise<Snapshot> {
  const root = await fs.realpath(input.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Рабочая папка недоступна.');
  const read = new Reader(root);
  const s: Snapshot = {
    schemaVersion: 'aif-chat/v1', collectedAt: new Date().toISOString(), fingerprint: '', inputsFingerprint: null, root, runtime: input.runtime, configured: false,
    profile: 'none', phase: input.phase, phaseSource: input.phase === 'unknown' ? 'Этап не указан; состояние файлов не доказывает активный вызов' : 'Этап указан агентом в карточке; выполнение проверяется BB',
    threadState: 'unknown',
    pendingQuestions: null,
    versions: { globalCli: null, globalSource: null, installed: null, sourceVersion: null, sourceWorktreeVersion: null, sourceSha: null, sourceDirty: null },
    upstream: { version: null, sha: null, ref: null, checkedAt: null, error: null },
    extensions: [], skills: [], candidates: [], target: null, checks: [], actions: [], diagnostics: [],
  };
  if (input.cachedVersions) {
    Object.assign(s.versions, input.cachedVersions.versions, { installed: null });
    s.versionsCheckedAt = input.cachedVersions.checkedAt;
    if (input.sourceRepo && !s.versions.sourceVersion) s.diagnostics.push('Указанный checkout исходников AI Factory недоступен или некорректен.');
  } else {
    const global = await globalPackage();
    s.versions.globalCli = global.version; s.versions.globalSource = global.source;
    try { Object.assign(s.versions, await sourceVersion(input.sourceRepo, signal), { globalCli: global.version, globalSource: global.source }); }
    catch { s.diagnostics.push('Указанный checkout исходников AI Factory недоступен или некорректен.'); }
    s.versionsCheckedAt = new Date().toISOString();
  }
  if (input.checkUpdates) s.upstream = await upstream(input.upstreamRepo, input.upstreamRef, signal);
  let meta: Record<string, any> = {};
  let config: Record<string, any> = {};
  try {
    meta = await read.json('.ai-factory.json') ?? {};
    const yaml = await read.read('.ai-factory/config.yaml');
    if (yaml) config = parseYaml(yaml);
    s.configured = Object.keys(meta).length > 0;
    s.versions.installed = str(meta.version);
    if (!s.configured) s.diagnostics.push('В рабочей папке нет проектной установки .ai-factory.json.');
  } catch { s.profile = 'invalid'; s.diagnostics.push('Не удалось разобрать конфигурацию проекта. Действия отключены.'); }
  const installs = Array.isArray(meta.agents) ? meta.agents : meta.agent ? [{ id: meta.agent, skillsDir: meta.skillsDir, installedSkills: meta.installedSkills }] : [];
  let agent = installs.find((v: any) => v.id === input.runtime);
  // AI Factory can register the shared .agents/skills target as codex or universal,
  // while BB exposes the same Codex installation as codex-app. Prefer exact IDs;
  // never borrow another runtime's private skill directory.
  if (!agent && ['codex', 'codex-app'].includes(input.runtime)) {
    const sibling = input.runtime === 'codex-app' ? 'codex' : 'codex-app';
    const shared = installs.filter((v: any) => [sibling, 'universal'].includes(v.id)
      && str(v.skillsDir)?.replaceAll('\\', '/') === '.agents/skills');
    agent = shared.find((v: any) => v.id === sibling) ?? shared.find((v: any) => v.id === 'universal');
    if (agent) s.diagnostics.push(`Для ${input.runtime} используется общая установка ${agent.id} в .agents/skills.`);
  }
  if (!agent && installs.length === 1) { agent = installs[0]; s.runtime = String(agent.id); }
  if (!agent && installs.length > 1) s.diagnostics.push('Для текущего runtime установка не найдена: выберите runtime в настройках плагина.');
  const requestedSkills = Array.isArray(agent?.installedSkills) ? agent.installedSkills.filter((v: unknown) => typeof v === 'string') : [];
  // Resolve actual skill files. Registration alone is not enough for a runnable action.
  if (agent && str(agent.skillsDir)) {
    for (const skill of requestedSkills.slice(0, 80)) {
      if (!/^[a-z0-9-]+$/.test(skill)) continue;
      try { if (await read.read(`${safeRelative(agent.skillsDir)}/${skill}/SKILL.md`)) s.skills.push(skill); }
      catch { s.diagnostics.push(`Skill ${skill}: путь недоступен, ссылка или файл слишком велик.`); }
    }
  }
  let hub = false;
  for (const entry of (Array.isArray(meta.extensions) ? meta.extensions : []).slice(0, 30)) {
    const name = str(entry.name);
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) { s.diagnostics.push('Некорректное имя зарегистрированного расширения.'); continue; }
    let installed: Record<string, any> | null = null;
    let state: Snapshot['extensions'][number]['state'] = 'present';
    try {
      installed = await read.json(`.ai-factory/extensions/${name}/extension.json`);
      if (!installed) state = 'missing';
      else if (installed.name !== name || !str(installed.version)) state = 'invalid';
      else if (installed.version !== entry.version) state = 'version_mismatch';
    } catch { state = 'invalid'; }
    const contributions: string[] = Array.isArray(installed?.injections) ? installed.injections.map((v: any) => str(v.target)).filter((v: string | null): v is string => v !== null) : [];
    s.extensions.push({ name, recordedVersion: str(entry.version), installedVersion: str(installed?.version), source: sourceLabel(entry.source), state, contributions });
    if (name === 'aifhub-extension' && state === 'present') hub = true;
    // Custom extension skills are installed independently of the base installedSkills list.
    if (state === 'present' && agent && str(agent.skillsDir) && Array.isArray(installed?.skills)) {
      for (const declared of installed.skills.slice(0, 40)) {
        if (typeof declared !== 'string') continue;
        try {
          const skill = path.posix.basename(safeRelative(declared));
          if (!/^[a-z0-9-]+$/.test(skill) || s.skills.includes(skill) || installed.replaces?.[declared]) continue;
          if (await read.read(`${safeRelative(agent.skillsDir)}/${skill}/SKILL.md`)) s.skills.push(skill);
        } catch { s.diagnostics.push(`Расширение ${name}: путь custom skill недоступен.`); }
      }
    }
  }
  if (s.profile !== 'invalid') s.profile = hub ? 'aifhub-classic' : s.configured ? 'upstream' : 'none';
  const aifhub = obj(config.aifhub);
  const tools = obj(aifhub.tools);
  if ('tools' in aifhub && (!aifhub.tools || typeof aifhub.tools !== 'object' || Array.isArray(aifhub.tools))) {
    s.profile = 'invalid'; s.diagnostics.push('aifhub.tools должен быть mapping с boolean-переключателями.');
  }
  for (const name of ['openspec', 'hlv', 'lekalo']) if (name in tools && typeof tools[name] !== 'boolean') {
    s.profile = 'invalid'; s.diagnostics.push(`aifhub.tools.${name} должен быть boolean.`);
  }
  const native = hub && (Object.keys(tools).length ? tools.openspec === true : aifhub.artifactProtocol === 'openspec-native');
  if (native && s.profile !== 'invalid') s.profile = 'aifhub-openspec';
  const paths = obj(config.paths);
  const planRoot = str(paths.plans) ?? '.ai-factory/plans';
  const qaRoot = str(paths.qa) ?? '.ai-factory/qa';
  const openRoot = str(obj(aifhub.openspec).root) ?? 'openspec';
  const branch = await git(root, ['branch', '--show-current'], signal);
  const head = await git(root, ['rev-parse', 'HEAD'], signal);
  const dirtyDiff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.'], signal);
  const status = await git(root, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], signal);
  try {
    if (native) {
      for (const item of await read.list(`${safeRelative(openRoot)}/changes`)) {
        if (!item.directory || item.name === 'archive') continue;
        const rel = `${openRoot}/changes/${item.name}/tasks.md`;
        if (await read.read(rel)) s.candidates.push({ path: rel, title: item.name, kind: 'openspec' });
      }
    } else {
      for (const rel of [str(paths.plan) ?? '.ai-factory/PLAN.md', str(paths.fix_plan) ?? '.ai-factory/FIX_PLAN.md']) {
        if (await read.read(rel)) s.candidates.push({ path: rel, title: path.posix.basename(rel), kind: rel === (str(paths.fix_plan) ?? '.ai-factory/FIX_PLAN.md') ? 'fix' : 'fast' });
      }
      for (const item of await read.list(planRoot)) {
        const rel = `${planRoot}/${item.name}`;
        if (!item.directory && item.name.endsWith('.md')) s.candidates.push({ path: rel, title: item.name.replace(/\.md$/, ''), kind: hub ? 'classic' : 'full' });
        if (item.directory) {
          const entry = await read.read(`${rel}/index.md`);
          if (entry && /^<!-- aif:plan-mode:ultra -->\s*$/m.test(entry)) s.candidates.push({ path: `${rel}/index.md`, title: item.name, kind: 'ultra' });
        }
      }
    }
    if (s.candidates.length > 80) throw new Error('Более 80 планов: укажите конкретный путь.');
    let selected = input.target ? s.candidates.find(v => v.path === input.target || v.title === input.target) : undefined;
    if (input.target && !selected) {
      const rel = safeRelative(input.target.replace(/^@/, ''));
      selected = s.candidates.find(v => v.path === rel || v.path === `${rel}/index.md` || v.path === `${rel}/tasks.md`);
      if (!selected) throw new Error('Выбранный план/change не найден в допустимых артефактах.');
    }
    if (!selected && !input.target && branch) {
      const stem = branch.replaceAll('/', '-');
      const matching = s.candidates.filter(v => v.title === stem || v.title.replace(/^\d{4}_/, '') === stem);
      if (matching.length === 1) selected = matching[0];
    }
    if (!selected && !input.target && s.candidates.length === 1) selected = s.candidates[0];
    if (selected) {
      if (s.candidates.some(v => v.path !== selected!.path && v.title === selected!.title && (v.kind === 'ultra' || selected!.kind === 'ultra'))) throw new Error('Collision classic/ultra: требуется разрешить противоречивые артефакты.');
      const text = await read.read(selected.path);
      if (text === null) throw new Error('Выбранный артефакт исчез.');
      const markerCount = text.split(/^<!-- aif:plan-mode:ultra -->\s*$/m).length - 1;
      if (selected.kind === 'ultra' && markerCount !== 1) throw new Error('Некорректный marker ultra.');
      const id = selected.kind === 'openspec' ? selected.path.split('/').at(-2)! : selected.title;
      s.target = { path: selected.path, title: text.match(/^#\s+(.+)$/m)?.[1]?.slice(0, 200) ?? selected.title, id,
        kind: selected.kind as NonNullable<Snapshot['target']>['kind'], tasks: taskList(text) };
      if (hub && selected.kind === 'ultra') s.profile = 'aifhub-ultra';
      if (hub && selected.kind === 'fast') s.profile = 'upstream';
      if (selected.kind === 'classic') {
        const companion = await read.read(`${planRoot}/${id}/status.yaml`);
        if (!companion) s.diagnostics.push('Classic companion status.yaml отсутствует; владелец workflow проверит миграцию.');
        else {
          const legacy = parseYaml(companion);
          if (legacy.verification?.verdict) s.diagnostics.push(`Classic verification: ${String(legacy.verification.verdict).slice(0, 60)}; актуальность отдельно не подтверждена.`);
        }
      }
      const evidenceDir = selected.kind === 'classic' ? `${planRoot}/${id}` : `${qaRoot}/${id}`;
      const policy = obj(aifhub.openspec);
      for (const [gate, label] of [['verify', 'Соответствие плану'], ['rules', 'Правила проекта'], ['security', 'Безопасность'], ['review', 'Code review']]) {
        const rel = `${evidenceDir}/${gate === 'rules' && selected.kind === 'classic' ? 'gates/rules' : gate}.md`;
        const report = await read.read(rel);
        const parsed = report ? lastGate(report, gate) : null;
        s.checks.push({ id: gate, label, state: parsed ? parsed.status === 'pass' ? 'reported-pass' : parsed.status as 'warn' | 'fail' : report ? 'unknown' : 'notrun',
          detail: parsed ? `${parsed.status.toUpperCase()} в отчёте; привязка к текущим inputs не подтверждена` : report ? 'Отчёт есть, валидный gate block не найден' : 'Evidence не найдено; факт запуска неизвестен',
          path: report ? rel : null, required: native && (gate === 'verify' || gate === 'rules' && policy.requireRulesPassForDone !== false) });
      }
      for (const [id, label, filename] of [['qa-plan', 'QA-сценарии', 'test-cases.md'], ['qa', 'Прохождение QA', 'qa-check.md'], ['coverage', 'Spec coverage', 'coverage.json'], ['readiness', 'Done readiness', 'done-readiness.json']]) {
        const rel = `${evidenceDir}/${filename}`;
        const report = await read.read(rel);
        s.checks.push({ id, label, state: report ? 'unknown' : 'notrun', detail: report ? 'Артефакт существует; результат и актуальность проверяет владелец' : 'Артефакт не найден', path: report ? rel : null,
          required: native && id === 'coverage' && policy.requireSpecCoverageForDone !== false });
      }
      s.checks.push({ id: 'quality', label: 'Качество кода', state: 'unknown', detail: 'Выберите существующие команды lint/types/tests/build по стеку проекта', path: null, required: false },
        { id: 'ci', label: 'CI', state: 'unknown', detail: 'Нужен фактический run для текущего commit; pipeline-файл не означает PASS', path: null, required: false });
      if (native) s.checks.push({ id: 'mode', label: 'Конфигурация и артефакты', state: 'unknown',
        detail: 'Read-only doctor выбранного change; не запускает sync, init или исправления. Результат проверяет владелец workflow.', path: null, required: false });
    } else if (s.candidates.length > 1) s.diagnostics.push('Несколько планов/change: выберите цель, автоматического выбора по времени нет.');
  } catch (e: any) { s.profile = 'invalid'; s.diagnostics.push(String(e.message).slice(0, 300)); }
  if (s.extensions.some(e => e.name === 'aifhub-extension' && e.state !== 'present')) {
    s.profile = 'invalid'; s.diagnostics.push('Установка AIFHub противоречива; восстановите metadata перед выбором workflow.');
  }
  if (s.versions.globalCli && s.versions.installed && s.versions.globalCli !== s.versions.installed) s.diagnostics.push('Версии глобального CLI и установки проекта различаются. Для обновления нажмите «Обновить AI Factory».');
  s.fingerprint = hash(JSON.stringify({ root, runtime: s.runtime, profile: s.profile, target: s.target?.path, phase: s.phase, versions: s.versions, head, branch, dirty: hash(dirtyDiff ?? 'unknown'), status, files: [...read.seen].sort() }));
  // Separate from the card fingerprint: phase, clock, thread activity and
  // upstream lookup do not represent changed verification inputs.
  try {
    if (!head || dirtyDiff === null || status === null || s.profile === 'invalid') throw new Error('Unknown Git inputs');
    const [others, index] = await Promise.all([
      git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], signal, false),
      git(root, ['ls-files', '--stage', '-z', '--', '.'], signal, false),
    ]);
    if (others === null || index === null || /(?:^|\x00)160000 /.test(index)) throw new Error('Unknown inputs or submodules');
    const untracked = others.split('\0').filter(Boolean).sort();
    if (untracked.length > MAX_FILES) throw new Error('Too many untracked files');
    const extra = new Reader(root);
    let bytes = 0;
    for (const filename of untracked) {
      const absolute = await extra.resolve(filename);
      const stat = await fs.stat(absolute);
      bytes += stat.size;
      if (!stat.isFile() || stat.size > MAX_FILE || bytes > 32 * MAX_FILE) throw new Error('Untracked inputs exceed limit');
      extra.seen.set(filename, hash(await fs.readFile(absolute)));
    }
    s.inputsFingerprint = hash(JSON.stringify({ root, runtime: s.runtime, profile: s.profile, target: s.target?.path,
      versions: s.versions, head, branch, dirty: hash(dirtyDiff), status, index: hash(index),
      files: [...read.seen].sort(), untracked: [...extra.seen].sort() }));
  } catch { s.inputsFingerprint = null; }
  s.fingerprint = hash(JSON.stringify([s.fingerprint, s.inputsFingerprint]));
  s.actions = workflowActions(s);
  return snapshotSchema.parse(s);
}
