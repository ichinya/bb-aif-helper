import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { snapshotSchema, type HostInput, type Snapshot } from './model.ts';
import { workflowActions } from './workflow.ts';
import { BUILD_FILES, DOCKER_FILES, readinessSteps, type ReadinessFacts } from './readiness.ts';
import { BASIC_PLAN_ROOTS, usesBasicWorkflow, isCompletedPlan } from './basic-workflow.ts';
import { planVerification } from './plan-verification.ts';
import { planSettings, supportsAif222 } from './aif222.ts';

const exec = promisify(execFile);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 200;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
export function safeRelative(value: string): string {
  if (!value || value.length > 1000 || path.isAbsolute(value) || /^[A-Za-z]:|[\x00-\x1f]/.test(value)) throw new Error('Нужен относительный путь внутри проекта.');
  // config.yaml writes directory paths with a trailing slash (`docs/`, `.ai-factory/plans/`).
  const normalized = value.replaceAll('\\', '/').replace(/(?<=[^/])\/+$/, '');
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
  let fence = '';
  let comment = false;
  const tasks: NonNullable<Snapshot['target']>['tasks'] = [];
  let index = 0;
  let commitNext = false;
  // Frontmatter, comments, code samples and deeply-indented examples are not progress.
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/);
  const section = lines.findIndex(v => /^#{1,6}\s+(?:Tasks|Task List|Implementation Tasks|Задачи|План выполнения)\s*$/i.test(v));
  const sectionLevel = section >= 0 ? lines[section].match(/^#+/)![0].length : 0;
  let listActive = false;
  for (let line = section >= 0 ? section + 1 : 0; line < lines.length; line++) {
    const original = lines[line];
    const marker = !comment ? original.match(/^ {0,3}(`{3,}|~{3,})/) : null;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !original.slice(marker[0].length).trim()) fence = '';
      commitNext = false; continue;
    }
    if (fence) continue;
    if (!comment && /^<!-- aif:task-kind:commit -->\s*$/.test(original)) { commitNext = true; continue; }
    const isCommit = commitNext; commitNext = false;
    let rest = original; let raw = '';
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->');
        if (end < 0) break;
        comment = false; rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) { raw += rest; break; }
        raw += rest.slice(0, start); rest = rest.slice(start + 4); comment = true;
      }
    }
    if (sectionLevel && new RegExp(`^#{1,${sectionLevel}}\\s`).test(raw)) break;
    // `[~]` (in progress) and `[!]` (failed) are implement-coordinator's marks: still open tasks.
    const m = raw.match(/^( *)[-*+] \[([ xX~!])\]\s+(.+)$/);
    if (m) {
      if (m[1].length >= 4 && !listActive) continue;
      listActive = true;
      const title = m[3].trim().slice(0, 500);
      const skipped = m[2].toLowerCase() === 'x' && /<!-- aif:(?:task-outcome:skipped|commit-outcome:skipped-no-op)(?:\s|-->)/.test(original);
      tasks.push({ id: title.match(/^(?:Task\s+)?(\d+(?:\.\d+)*)\b/i)?.[1] ?? `task-${++index}`, title, done: m[2].toLowerCase() === 'x',
        ...(isCommit ? { kind: 'commit' as const } : {}), ...(skipped ? { outcome: 'skipped' as const } : {}) });
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
  async artifact(rel: string): Promise<boolean | null> {
    const directory = rel.endsWith('/');
    try {
      if (directory) return (await this.list(rel.slice(0, -1))).some(entry => !entry.name.startsWith('.'));
      const stat = await fs.stat(await this.resolve(rel));
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
    }
  }
  async skill(rel: string, meta: Record<string, any>): Promise<string | null> {
    const directory = path.posix.dirname(safeRelative(rel));
    const parent = await this.resolve(path.posix.dirname(directory));
    const link = path.join(parent, path.posix.basename(directory));
    let stat;
    try { stat = await fs.lstat(link); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (!stat?.isSymbolicLink()) return this.read(rel);
    const destination = `.agents/skills/${path.posix.basename(directory)}`;
    if (meta.useSymlinks !== true || obj(obj(meta.skillSymlinks).links)[directory] !== destination
      || !/^[a-f0-9]{64}$/i.test(obj(obj(meta.skillSymlinks).shared)[destination] ?? '')) throw new Error('Незарегистрированная ссылка skill.');
    const canonical = await this.resolve(destination);
    if (await fs.realpath(link) !== canonical) throw new Error('Ссылка skill не совпадает с общей установкой.');
    // Read the validated physical destination, never traverse an arbitrary link.
    const text = await this.read(`${destination}/SKILL.md`);
    this.seen.set(rel, hash(JSON.stringify([await fs.readlink(link), destination])));
    return text;
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
    threadState: 'unknown', worktree: { hasUncommitted: null },
    pendingQuestions: null, pendingConfirmation: null,
    versions: { globalCli: null, globalSource: null, installed: null, sourceVersion: null, sourceWorktreeVersion: null, sourceSha: null, sourceDirty: null },
    upstream: { version: null, sha: null, ref: null, checkedAt: null, error: null },
    extensions: [], skills: [], candidates: [], target: null, checks: [], actions: [], readiness: [], diagnostics: [],
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
  if (supportsAif222(s.versions.installed)) {
    const workflow = obj(config.workflow);
    const mode = ['ask', 'now', 'plan'].includes(workflow.fix_mode) ? workflow.fix_mode : 'ask';
    const patch = typeof workflow.fix_patch === 'boolean' ? workflow.fix_patch : true;
    s.fixDefaults = { mode, patch };
    if ('fix_mode' in workflow && mode !== workflow.fix_mode) s.diagnostics.push('workflow.fix_mode некорректен; AI Factory использует ask.');
    if ('fix_patch' in workflow && typeof workflow.fix_patch !== 'boolean') s.diagnostics.push('workflow.fix_patch должен быть boolean; AI Factory использует true.');
  }
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
      try { if (await read.skill(`${safeRelative(agent.skillsDir)}/${skill}/SKILL.md`, meta)) s.skills.push(skill); }
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
    const commands: string[] = [];
    for (const declaration of (Array.isArray(installed?.commands) ? installed.commands.slice(0, 80) : [])) {
      const command = obj(declaration);
      if (!str(command.name) || command.name.length > 100 || !/^[a-z0-9-]+$/.test(command.name) || !str(command.module)) continue;
      try {
        if (await read.read(`.ai-factory/extensions/${name}/${safeRelative(command.module.replace(/^\.\//, ''))}`)) commands.push(command.name);
        else s.diagnostics.push(`Расширение ${name}: файл команды ${command.name} не найден.`);
      } catch { s.diagnostics.push(`Расширение ${name}: файл команды ${command.name} недоступен.`); }
    }
    s.extensions.push({ name, recordedVersion: str(entry.version), installedVersion: str(installed?.version), source: sourceLabel(entry.source), state, contributions, commands });
    if (name === 'aifhub-extension' && state === 'present') hub = true;
    // Custom extension skills are installed independently of the base installedSkills list.
    if (state === 'present' && agent && str(agent.skillsDir) && Array.isArray(installed?.skills)) {
      for (const declared of installed.skills.slice(0, 40)) {
        if (typeof declared !== 'string') continue;
        try {
          const skill = path.posix.basename(safeRelative(declared));
          if (!/^[a-z0-9-]+$/.test(skill) || s.skills.includes(skill) || installed.replaces?.[declared]) continue;
          if (await read.skill(`${safeRelative(agent.skillsDir)}/${skill}/SKILL.md`, meta)) s.skills.push(skill);
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
  // Directory paths in config.yaml usually end with `/`; normalize separators and strip
  // trailing slashes so joined paths match candidate paths. Reader still validates traversal and links.
  const directory = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '');
  const dir = (v: unknown, fallback: string) => directory(str(v) ?? fallback);
  const planRoot = dir(paths.plans, '.ai-factory/plans');
  const qaRoot = dir(paths.qa, '.ai-factory/qa');
  const openRoot = dir(obj(aifhub.openspec).root, 'openspec');
  // Readiness probes share Reader limits and the fingerprint's seen set; a failed path is a false fact, not a failed snapshot.
  const files: Record<string, boolean> = {};
  const probe = async (rel: string) => {
    try { files[rel] = (await read.read(rel)) !== null; }
    catch { files[rel] = false; s.diagnostics.push(`Подготовка проекта: ${rel} недоступен.`); }
  };
  const probeDir = async (rel: string, keep?: (item: { name: string; directory: boolean }) => boolean) => {
    const target = rel.replace(/\/+$/, '');
    try { for (const item of await read.list(target)) if (!keep || keep(item)) files[`${target}/${item.name}`] = true; }
    catch { s.diagnostics.push(`Подготовка проекта: каталог ${target} недоступен.`); }
  };
  const description = str(paths.description) ?? '.ai-factory/DESCRIPTION.md';
  const architecture = str(paths.architecture) ?? '.ai-factory/ARCHITECTURE.md';
  const rulesBase = str(obj(config.rules).base) ?? '.ai-factory/rules/base.md';
  const docs = str(paths.docs) ?? 'docs';
  const rulesFile = str(paths.rules_file) ?? '.ai-factory/RULES.md';
  for (const rel of [description, '.ai-factory/config.yaml', architecture, rulesBase, 'AGENTS.md',
    'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml',
    '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml',
    rulesFile, ...BUILD_FILES, ...DOCKER_FILES]) await probe(rel);
  await probeDir('.husky');
  await probeDir(docs);
  await probeDir('.github/workflows', item => !item.directory && /\.ya?ml$/i.test(item.name));
  const readinessFacts: ReadinessFacts = { configured: s.configured,
    contextSkill: s.skills.includes('aif') || s.skills.includes('aif-analyze'),
    files, paths: { description, architecture, rulesBase, docs, rulesFile } };
  if (s.profile !== 'invalid') {
    const rules = dir(paths.rules, '.ai-factory/rules');
    const artifacts = [
      { id: 'describe', label: 'Описать проект', paths: [str(paths.description) ?? '.ai-factory/DESCRIPTION.md'], optional: false },
      { id: 'architecture', label: 'Описать архитектуру', paths: [str(paths.architecture) ?? '.ai-factory/ARCHITECTURE.md'], optional: false },
      { id: 'roadmap', label: 'Составить roadmap', paths: [str(paths.roadmap) ?? '.ai-factory/ROADMAP.md'], optional: true },
      { id: 'quality', label: 'Настроить проверки', paths: ['.husky/pre-commit', 'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml'], optional: true },
      { id: 'ci', label: 'Настроить CI', paths: ['.github/workflows/', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'], optional: true },
      { id: 'rules', label: 'Настроить правила проекта', paths: [`${rules}/`], optional: true },
      { id: 'docs', label: 'Создать документацию', paths: ['README.md', dir(paths.docs, 'docs') + '/'], optional: true },
      { id: 'build', label: 'Настроить сборку', paths: ['Makefile', 'Taskfile.yml', 'justfile', 'magefile.go'], optional: true },
      { id: 'docker', label: 'Настроить Docker', paths: ['Dockerfile', 'compose.yml', 'compose.yaml', 'docker-compose.yml'], optional: true },
    ];
    s.preparation = [
      { id: 'install', label: 'Установить AI Factory', paths: ['.ai-factory.json'], optional: false, state: s.configured ? 'found' : 'missing' },
      ...await Promise.all(artifacts.map(async step => {
        const observed = await Promise.all(step.paths.map(file => read.artifact(file)));
        const found = step.paths.filter((_, index) => observed[index] === true);
        const state = found.length ? 'found' : observed.includes(null) ? 'unknown' : 'missing';
        return { ...step, state, paths: found.length ? found : step.paths } as const;
      })),
    ];
  }
  const branch = await git(root, ['branch', '--show-current'], signal);
  const head = await git(root, ['rev-parse', 'HEAD'], signal);
  const dirtyDiff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.'], signal);
  const status = await git(root, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], signal);
  s.worktree.hasUncommitted = status === null ? null : status.length > 0;
  try {
    const documents = new Map<string, string | null>();
    const readPlan = async (rel: string) => {
      if (documents.has(rel)) return documents.get(rel) ?? null;
      const text = await read.read(rel); documents.set(rel, text); return text;
    };
    if (native) {
      for (const item of await read.list(`${safeRelative(openRoot)}/changes`)) {
        if (!item.directory || item.name === 'archive') continue;
        const rel = `${openRoot}/changes/${item.name}/tasks.md`;
        if (await readPlan(rel)) s.candidates.push({ path: rel, title: item.name, kind: 'openspec' });
      }
    } else if (usesBasicWorkflow(s)) {
      for (const basicRoot of BASIC_PLAN_ROOTS) for (const item of await read.list(basicRoot)) {
        if (item.directory || !item.name.endsWith('.md')) continue;
        const rel = `${basicRoot}/${item.name}`;
        if (await readPlan(rel)) s.candidates.push({ path: rel, title: item.name.slice(0, -3), kind: 'basic' });
      }
    } else {
      for (const rel of [str(paths.plan) ?? '.ai-factory/PLAN.md', str(paths.fix_plan) ?? '.ai-factory/FIX_PLAN.md']) {
        if (await readPlan(rel)) s.candidates.push({ path: rel, title: path.posix.basename(rel), kind: rel === (str(paths.fix_plan) ?? '.ai-factory/FIX_PLAN.md') ? 'fix' : 'fast' });
      }
      for (const item of await read.list(planRoot)) {
        const rel = `${planRoot}/${item.name}`;
        if (!item.directory && item.name.endsWith('.md')) s.candidates.push({ path: rel, title: item.name.replace(/\.md$/, ''), kind: hub ? 'classic' : 'full' });
        if (item.directory) {
          const entry = await readPlan(`${rel}/index.md`);
          if (entry && /^<!-- aif:plan-mode:ultra -->\s*$/m.test(entry)) s.candidates.push({ path: `${rel}/index.md`, title: item.name, kind: 'ultra' });
        }
      }
    }
    if (s.candidates.length > 80) throw new Error('Более 80 планов: укажите конкретный путь.');
    for (const candidate of s.candidates) {
      const document = await readPlan(candidate.path);
      if (document === null) continue;
      if (candidate.kind === 'basic') candidate.title = document.match(/^#\s+(.+)$/m)?.[1]?.slice(0, 200) ?? candidate.title;
      if (candidate.kind === 'classic') {
        const id = path.posix.basename(candidate.path, '.md');
        try {
          const companion = await readPlan(`${planRoot}/${id}/status.yaml`);
          if (companion) {
            const legacy = parseYaml(companion);
            const references = [legacy.plan_file, obj(legacy.artifacts).plan].filter(value => value !== undefined);
            const bound = legacy.plan_id === id && references.every(value => value === candidate.path);
            if (legacy.status === 'done' && bound) candidate.closed = true;
            else if (legacy.status === 'done' && !bound) s.diagnostics.push(`Статус закрытия ${id} не привязан к этому плану; он остаётся в списке.`);
          }
        } catch { s.diagnostics.push(`Не удалось прочитать статус закрытия ${id}; план остаётся в списке.`); }
      }
      let tasks: NonNullable<Snapshot['target']>['tasks'];
      try { tasks = taskList(document); }
      catch { s.diagnostics.push(`Не удалось посчитать пункты плана ${candidate.path}; проверьте выбранный артефакт.`); continue; }
      candidate.progress = { completed: tasks.filter(task => task.done).length, total: tasks.length,
        verified: candidate.kind === 'basic' && planVerification(document).verified };
    }
    const matching = input.target ? s.candidates.filter(v => v.path === input.target || v.title === input.target
      || v.kind === 'basic' && path.posix.basename(v.path, '.md') === input.target) : [];
    if (matching.length > 1) throw new Error('Несколько планов с таким названием: укажите точный путь.');
    let selected: Snapshot['candidates'][number] | undefined = matching[0];
    if (input.target && !selected) {
      const rel = safeRelative(input.target.replace(/^@/, ''));
      selected = s.candidates.find(v => v.path === rel || v.path === `${rel}/index.md` || v.path === `${rel}/tasks.md`);
      if (!selected) {
        let archived = false;
        const changeRoot = native ? `${safeRelative(openRoot)}/changes/` : '';
        if (native && s.profile !== 'invalid' && rel.startsWith(changeRoot)) {
          const entry = rel.slice(changeRoot.length);
          const direct = entry.match(/^archive\/(\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9._-]{0,199})(?:\/tasks\.md)?$/);
          if (direct) archived = await readPlan(`${changeRoot}archive/${direct[1]}/tasks.md`) !== null;
          else {
            const active = entry.match(/^([a-z0-9][a-z0-9._-]{0,199})(?:\/tasks\.md)?$/);
            if (active && active[1] !== 'archive') {
              const matches = (await read.list(`${changeRoot}archive`)).filter(item => item.directory
                && /^\d{4}-\d{2}-\d{2}-/.test(item.name) && item.name.slice(11) === active[1]);
              if (matches.length > 1) throw new Error('Change найден в нескольких архивах; укажите точный архивный путь.');
              if (matches.length === 1) archived = await readPlan(`${changeRoot}archive/${matches[0].name}/tasks.md`) !== null;
            }
          }
        }
        if (!archived && !usesBasicWorkflow(s)) throw new Error('Выбранный план/change не найден в допустимых артефактах.');
        s.selectionReset = true;
        s.diagnostics.push(archived
          ? 'Выбранный change найден в архиве; выбор сброшен. Архив не подтверждает актуальный PASS.'
          : 'Ранее выбранный план не найден; выбор сброшен. Доступно исследование и составление нового плана.');
      }
    }
    if (!selected && !input.target && branch && !usesBasicWorkflow(s)) {
      const stem = branch.replaceAll('/', '-');
      const matching = s.candidates.filter(v => !isCompletedPlan(v) && (v.title === stem || v.title.replace(/^\d{4}_/, '') === stem));
      if (matching.length === 1) selected = matching[0];
    }
    const active = s.candidates.filter(v => !isCompletedPlan(v));
    if (!selected && !input.target && active.length === 1) selected = active[0];
    if (selected) {
      if (s.candidates.some(v => v.path !== selected!.path && v.title === selected!.title && (v.kind === 'ultra' || selected!.kind === 'ultra'))) throw new Error('Collision classic/ultra: требуется разрешить противоречивые артефакты.');
      const text = await readPlan(selected.path);
      if (text === null) throw new Error('Выбранный артефакт исчез.');
      const markerCount = text.split(/^<!-- aif:plan-mode:ultra -->\s*$/m).length - 1;
      if (selected.kind === 'ultra' && markerCount !== 1) throw new Error('Некорректный marker ultra.');
      const id = selected.kind === 'openspec' ? selected.path.split('/').at(-2)! : selected.kind === 'basic' ? path.posix.basename(selected.path, '.md') : selected.title;
      s.target = { path: selected.path, title: text.match(/^#\s+(.+)$/m)?.[1]?.slice(0, 200) ?? selected.title, id,
        kind: selected.kind as NonNullable<Snapshot['target']>['kind'], tasks: taskList(text), settings: planSettings(text),
        ...(selected.kind === 'basic' ? { verification: planVerification(text) } : {}) };
      if (hub && selected.kind === 'ultra') s.profile = 'aifhub-ultra';
      if (hub && selected.kind === 'fast') s.profile = 'upstream';
      if (selected.kind === 'classic') {
        const companion = await readPlan(`${planRoot}/${id}/status.yaml`);
        if (!companion) s.diagnostics.push('Classic companion status.yaml отсутствует; владелец workflow проверит миграцию.');
        else {
          const legacy = parseYaml(companion);
          if (legacy.verification?.verdict) s.diagnostics.push(`Classic verification: ${String(legacy.verification.verdict).slice(0, 60)}; актуальность отдельно не подтверждена.`);
        }
      }
      if (selected.kind !== 'basic') {
        const evidenceDir = selected.kind === 'classic' ? `${planRoot}/${id}` : `${qaRoot}/${id}`;
        const policy = obj(aifhub.openspec);
        for (const [gate, label] of [['verify', 'Соответствие плану'], ['rules', 'Правила проекта'], ['security', 'Безопасность'], ['review', 'Code review']]) {
          const rel = `${evidenceDir}/${gate === 'rules' && selected.kind === 'classic' ? 'gates/rules' : gate}.md`;
          const report = await read.read(rel);
          const parsed = report ? lastGate(report, gate) : null;
          s.checks.push({ id: gate, label, state: parsed ? parsed.status === 'pass' ? 'reported-pass' : parsed.status as 'warn' | 'fail' : report ? 'unknown' : 'notrun',
            detail: parsed ? `${parsed.status.toUpperCase()} в отчёте; привязка к текущим inputs не подтверждена` : report ? 'Отчёт есть, валидный gate block не найден' : 'Отчёт проверки не найден',
            path: report ? rel : null, required: native && (gate === 'verify' || gate === 'rules' && policy.requireRulesPassForDone !== false) });
        }
        // coverage.json and done-readiness.json are written only by the AIFHub extension.
        const artifacts = [['qa-plan', 'QA-сценарии', 'test-cases.md'], ['qa', 'Прохождение QA', 'qa-check.md'],
          ...(hub ? [['coverage', 'Spec coverage', 'coverage.json'], ['readiness', 'Done readiness', 'done-readiness.json']] : [])];
        for (const [id, label, filename] of artifacts) {
          const rel = `${evidenceDir}/${filename}`;
          const report = await read.read(rel);
          s.checks.push({ id, label, state: report ? 'unknown' : 'notrun', detail: report ? 'Артефакт существует; результат и актуальность проверяет владелец' : 'Артефакт не найден', path: report ? rel : null,
            required: native && id === 'coverage' && policy.requireSpecCoverageForDone !== false });
        }
        s.checks.push({ id: 'quality', label: 'Качество кода', state: 'unknown', detail: 'Выберите существующие команды lint/types/tests/build по стеку проекта', path: null, required: false },
          { id: 'ci', label: 'CI', state: 'unknown', detail: 'Нужен фактический run для текущего commit; pipeline-файл не означает PASS', path: null, required: false });
        if (native) s.checks.push({ id: 'mode', label: 'Конфигурация и артефакты', state: 'unknown',
          detail: 'Read-only doctor выбранного change; не запускает sync, init или исправления. Результат проверяет владелец workflow.', path: null, required: false });
      }
    } else if (active.length > 1) s.diagnostics.push('Несколько планов/change: выберите цель, автоматического выбора по времени нет.');
    else if (!active.length && s.candidates.length) s.diagnostics.push('Все планы завершены. Включите «Показать завершённые», чтобы открыть их.');
  } catch (e: any) { s.profile = 'invalid'; s.diagnostics.push(String(e.message).slice(0, 300)); }
  if (s.configured && s.profile !== 'invalid' && supportsAif222(s.versions.installed)) {
    s.checks.push({ id: 'coupling', label: 'Архитектурная связанность', state: 'unknown', detail: 'Опциональный review +coupling; наличие кнопки не означает выполненный анализ.', path: null, required: false });
    s.checks.push({ id: 'worktree', label: 'Ресурсы worktree', state: 'unknown', detail: 'Статическая диагностика; окружения не запускаются, runtime-изоляция не подтверждается.', path: null, required: false });
    const approvalPath = '.ai-factory/completion-hook/approval.json';
    let approval: Record<string, any> | null = null;
    try { approval = await read.json(approvalPath); } catch { s.diagnostics.push('Completion hook: approval.json недоступен или некорректен.'); }
    s.checks.push({ id: 'completion-hook', label: 'Completion hook', state: approval ? 'unknown' : 'notrun',
      detail: approval ? 'Есть декларация approval; запуск verifier, актуальность receipt и PASS не подтверждены.' : 'Не настроен. Opt-in для Claude Code 2.1.318 на Linux/macOS; автоматическое включение не выполняется.',
      path: approval ? approvalPath : null, required: false });
  }
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
  s.fingerprint = hash(JSON.stringify([s.fingerprint, s.inputsFingerprint, s.preparation]));
  s.readiness = s.profile === 'invalid' ? [] : readinessSteps(readinessFacts, []);
  s.actions = workflowActions(s);
  return snapshotSchema.parse(s);
}
