import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROUGHT_BACK, copyIndex, removePath, worktreesRoot } from './worktree.ts';

// Git steps of parallel /aif-implement that the coordinator used to type by hand. Paths never pass through a shell or
// an agent's copy and paste: git prints them NUL-separated and reads them back NUL-separated, so spaces, Cyrillic,
// `[]`, quotes and Windows separators reach git unchanged, and a rename or a deletion is just two more paths.

function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 32 << 20, encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 2000)));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
const nul = (list: string[]) => list.map(p => `${p}\0`).join('');
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

// git ends its answer with a newline; a path may itself start or end with a space, so nothing else is trimmed.
const line = (text: string) => text.replace(/\r?\n$/, '');

/**
 * Files and symlinks under `dir`, relative to it with `/` separators, without following symlinks; none when `dir` does
 * not exist. A folder that cannot be read throws: a file hidden there would otherwise be lost silently. Iterative, so
 * a folder with any number of files or levels never overflows the stack.
 */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [], pending: [string, string][] = [[dir, '']];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [at, prefix] = next;
    const entries = await readdir(at, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (at === dir && error.code === 'ENOENT') return [];
      throw unreadable(at, error);
    });
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push([path.join(at, entry.name), `${prefix}${entry.name}/`]);
      else found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

const unreadable = (at: string, error: NodeJS.ErrnoException) =>
  new Error(`Не удалось прочитать ${at} в копии исполнителя: ${error.code ?? error.message}`);

/**
 * What stands at a submodule's path in the worker's copy: nothing, a real folder, or something else (a symlink or a
 * file at that path or at any folder above it inside the copy) — then the first such entry is the change, and it is
 * never followed, so nothing outside the copy is read. Any error other than "not there" throws.
 */
async function submodulePath(top: string, rel: string): Promise<{ kind: 'none' } | { kind: 'dir' } | { kind: 'other'; at: string }> {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    const stat = await lstat(path.join(top, at)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw unreadable(path.join(top, at), error);
    });
    if (!stat) return { kind: 'none' };
    if (!stat.isDirectory()) return { kind: 'other', at };
  }
  return { kind: 'dir' };
}

/**
 * Files the worker changed inside submodules, which a patch of the parent never carries, so the caller refuses
 * instead of leaving them behind (a refusal can be acted on, a silently dropped file cannot):
 * - not checked out in the copy: every file the worker put in its folder. Git keeps that folder empty in the copy and
 *   the parent's `add -A` skips it as a gitlink, so none of it could come back, ignored or not;
 * - checked out in the copy, at any depth: tracked files that differ from the submodule's own HEAD (staged or not) and
 *   new files its ignore rules do not exclude. Each submodule is asked directly, so neither the parent's `status.*` or
 *   `diff.ignoreSubmodules` settings nor an `ignore = all` in a `.gitmodules` hides a change.
 * A submodule folder replaced by a symlink or a file is itself the change and is never followed, so nothing outside the
 * copy is read. A submodule that moved to another commit is the parent's gitlink change and is reported by the caller.
 */
async function submoduleChanges(top: string, shown = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await git(top, ['ls-files', '--stage', '-z'])).split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const rel = entry.slice(entry.indexOf('\t') + 1), dir = path.join(top, rel), name = `${shown}${rel}`;
    const where = await submodulePath(top, rel);
    if (where.kind === 'none') continue;
    if (where.kind === 'other') { found.push(`${shown}${where.at}`); continue; }
    if (!(await exists(path.join(dir, '.git')))) {
      for (const file of await filesUnder(dir)) found.push(`${name}/${file}`);
      continue;
    }
    // --ignore-submodules=dirty: a nested submodule that moved counts here, its own changes are found by the recursion.
    const tracked = await git(dir, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-relative', '--ignore-submodules=dirty', 'HEAD', '--']);
    const added = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name']);
    for (const file of tracked.split('\0').concat(added.split('\0'))) if (file) found.push(`${name}/${file}`);
    for (const file of await submoduleChanges(dir, `${name}/`)) found.push(file);
  }
  return found;
}

async function repo(root: string) {
  const top = line(await git(root, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error(`${root} не в git-репозитории`); }));
  const prefix = line(await git(root, ['rev-parse', '--show-prefix'])); // `sec/` or '' — always with `/`
  return { top, prefix };
}

const exists = (p: string) => lstat(p).then(() => true, () => false); // a dangling symlink exists too

export async function headCommit(input: { root: string }) {
  return { sha: line(await git(input.root, ['rev-parse', '--verify', 'HEAD^{commit}'])) };
}

// The project's own git settings (diff.relative, diff.noprefix, diff.context, color.diff, renames, external diff
// tools, text conversion) stay out of the patch.
const DIFF = ['diff', '--cached', '--binary', '-U3', '--no-color', '--no-relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

type Saved = { file: string; data: Buffer | null; mode: number; link: string | null };
async function save(top: string, file: string): Promise<Saved> {
  const full = path.join(top, file);
  const info = await lstat(full).catch(() => null);
  if (!info) return { file, data: null, mode: 0, link: null };
  if (info.isSymbolicLink()) return { file, data: null, mode: 0, link: await readlink(full) };
  return { file, data: info.isFile() ? await readFile(full) : null, mode: info.mode & 0o777, link: null };
}
const same = (a: Saved, b: Saved) => a.link === b.link && a.mode === b.mode
  && (a.data === null ? b.data === null : b.data !== null && a.data.equals(b.data));
async function restore(top: string, s: Saved) {
  if (same(s, await save(top, s.file))) return; // untouched by the failed apply
  const full = path.join(top, s.file);
  await removePath(full);
  if (s.link !== null) { await mkdir(path.dirname(full), { recursive: true }); await symlink(s.link, full); }
  else if (s.data !== null) { await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, s.data, { mode: s.mode }); }
}

/**
 * Brings one worker's result into the coordinator's workspace: what the worker changed in its copy since the last
 * bring-back of this worker (tracked, new and deleted files; ignored files such as node_modules stay out), so a
 * worker asked to fix its work is brought back again with just the fix. Without --3way `git apply` never touches the
 * index and refuses a patch that does not fit before writing anything; if writing then fails (a locked or read-only
 * file), the files it already touched are put back, so the workspace stays as it was and a retry is a normal one.
 */
export async function bringBack(input: { root: string; copy: string }) {
  const copy = path.resolve(input.copy);
  const inside = path.relative(worktreesRoot(), copy);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${copy} не копия AI Factory`);
  const mine = await repo(input.root);
  // The worker may have renamed its own section: git still works from the nearest folder of the copy that exists.
  let probe = copy;
  while (!(await exists(probe)) && path.relative(worktreesRoot(), path.dirname(probe)).split(path.sep).length >= 2) probe = path.dirname(probe);
  const theirs = await repo(probe);
  const common = async (dir: string) => path.resolve(line(await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  if (await common(mine.top) !== await common(theirs.top)) throw new Error(`${copy} — копия другого репозитория`);
  // The copy's own git folder (one per worktree) remembers the tree that was brought back last, or the coordinator's
  // work the copy was seeded with: only the worker's own changes come back.
  const mark = line(await git(theirs.top, ['rev-parse', '--path-format=absolute', '--git-path', BROUGHT_BACK]));
  const last = (await readFile(mark, 'utf8').catch(() => '')).trim();
  // No receipt: a copy made without a seed, whose base is its commit. A receipt whose tree git no longer has (pruned)
  // is refused: diffing from HEAD would send the coordinator's own work back as the worker's.
  if (last && !(/^[0-9a-f]{40,64}$/.test(last) && await git(theirs.top, ['cat-file', '-e', `${last}^{tree}`]).then(() => true, () => false)))
    return { applied: false as const, empty: false as const, files: [], error: 'Базовое состояние копии исполнителя потеряно: перезапустите задачу новым исполнителем.' };
  const base = last || 'HEAD';
  // The worker's state is staged in a temporary index that starts as a copy of the copy's own index (the seed tree
  // plus whatever the worker staged: `add -f`, a case-only `git mv`): a file of the base stays tracked even if the
  // worker's .gitignore now matches it, and a submodule the copy never checked out keeps its commit, so neither reads
  // as a change of the worker. The copy's own index is not touched.
  const dir = await mkdtemp(path.join(tmpdir(), 'aif-patch-'));
  try {
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  const inCopy = (args: string[]) => git(theirs.top, args, undefined, env);
  const index = line(await git(theirs.top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
  await copyIndex(index, env.GIT_INDEX_FILE).catch(() => inCopy(['read-tree', base]));
  await inCopy(['-c', 'core.fsmonitor=false', 'add', '-A']);
  const tree = line(await inCopy(['write-tree']));
  const files = (await inCopy(['diff', '--cached', '--name-only', '-z', '--no-relative', '--no-renames', '--ignore-submodules=none', base])).split('\0').filter(Boolean);
  // Edits inside a checked-out submodule belong to another repository: neither the tree nor a patch carries them, so
  // refuse instead of reporting a transfer (or nothing to transfer) while they are left behind.
  const insideSubmodules = await submoduleChanges(theirs.top);
  if (insideSubmodules.length) {
    const shown = insideSubmodules.slice(0, 8).map(f => `"${f}"`).join(', ') + (insideSubmodules.length > 8 ? ` и ещё ${insideSubmodules.length - 8}` : '');
    return { applied: false as const, empty: false as const, files, error: `Исполнитель изменил файлы внутри подмодуля (это другой репозиторий, патч их не переносит): ${shown}. Если это собранные файлы, удалите их в копии исполнителя и повторите перенос; иначе сделайте эту задачу сами.` };
  }
  if (!files.length) return { applied: false as const, empty: true as const, files };
  // `git apply` without --index cannot move a submodule: say so instead of reporting a transfer that did not happen.
  const raw = await inCopy(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none', base]);
  const tokens = raw.split('\0'), gitlinks: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (/^:(160000 \S+|\S+ 160000) /.test(tokens[i])) gitlinks.push(tokens[i + 1]);
  if (gitlinks.length) return { applied: false as const, empty: false as const, files, error: `Исполнитель изменил подмодуль: ${gitlinks.join(', ')}. Его не перенести патчем — перенесите вручную.` };
  // A patch that would empty the folder this chat works in (the worker renamed or removed it) is refused before
  // anything changes. Only a patch that deletes something in the folder can empty it; the folder survives if an entry
  // on disk stays (a file the patch does not delete, a subfolder it does not touch) or the patch adds a file to it.
  if (mine.prefix) {
    const deleted = new Set<string>(), added: string[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      if (/ D$/.test(tokens[i])) deleted.add(tokens[i + 1]); else added.push(tokens[i + 1]);
    }
    const touches = (rel: string) => [...deleted].some(f => f.startsWith(rel));
    const keeps = async (dir: string, rel: string): Promise<boolean> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const r = rel + entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) { if (!touches(r + '/') || await keeps(path.join(dir, entry.name), r + '/')) return true; }
        else if (!deleted.has(r)) return true;
      }
      return false;
    };
    if (touches(mine.prefix) && !added.some(f => f.startsWith(mine.prefix)) && !(await keeps(path.resolve(input.root), mine.prefix)))
      return { applied: false as const, empty: false as const, files,
        error: `Исполнитель переименовал или удалил папку ${mine.prefix}, в которой работает этот чат: перенесите это вручную, после остальных задач.` };
  }
  // The receipt is written after the apply; a copy where it cannot be written is refused before anything changes.
  await writeFile(mark, last ? `${last}\n` : '').catch((cause: Error) => { throw new Error(`Копия исполнителя недоступна для записи: ${cause.message}`); });
  const patch = path.join(dir, `${randomUUID()}.patch`);
  {
    await inCopy([...DIFF, base, `--output=${patch}`]);
    try { await git(mine.top, ['apply', '--check', '--whitespace=nowarn', patch]); }
    catch (cause) { return { applied: false as const, empty: false as const, files, error: (cause as Error).message }; }
    // Only now, with the patch known to fit, the copy's index becomes the tree being brought back: git keeps every
    // object an index names, so `git gc` never prunes the baseline of the worker's next fix. A locked index (a git the
    // worker left running) refuses while nothing has changed; a failed apply below puts the index back on the base.
    try { await git(theirs.top, ['read-tree', tree]); }
    catch (cause) { return { applied: false as const, empty: false as const, files, error: `Индекс копии исполнителя занят, перенос не сделан: ${(cause as Error).message}` }; }
    const saved = await Promise.all(files.map(f => save(mine.top, f)));
    // --whitespace=nowarn: `apply.whitespace=fix` in the project would strip the trailing spaces of a Markdown line break.
    const undo = async (error: string) => {
      const lost: string[] = [];
      for (const s of saved) await restore(mine.top, s).catch(() => lost.push(s.file));
      return lost.length
        ? { applied: false as const, empty: false as const, partial: true as const, files: lost, error }
        : { applied: false as const, empty: false as const, files, error };
    };
    // git apply removes a folder a deletion leaves empty and makes it again for an added file (renaming the chat
    // folder's only file): the new folder gets the chat folder's permissions back.
    const folder = mine.prefix ? await stat(path.resolve(input.root)).catch(() => null) : null;
    try { await git(mine.top, ['apply', '--whitespace=nowarn', patch]); }
    catch (cause) { await git(theirs.top, ['read-tree', base]).catch(() => undefined); return undo((cause as Error).message); }
    if (folder) await chmod(path.resolve(input.root), folder.mode & 0o7777).catch(() => undefined);
    await writeFile(mark, `${tree}\n`);
    return { applied: true as const, files };
  }
  } finally { await removePath(dir).catch(() => undefined); }
}

/**
 * The brief the coordinator wrote for a worker: an absolute path to a text file of at most 200 KB. Windows
 * PowerShell 5.1 writes UTF-16 with a BOM by default (`Out-File`, `>`), so that is read too; anything else that is
 * not UTF-8 is refused rather than sent to the worker as garbage.
 */
export async function readBrief(input: { path: string }) {
  if (!path.isAbsolute(input.path)) throw new Error(`Нужен абсолютный путь к файлу задания: ${input.path}`);
  const info = await stat(input.path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Файла задания нет: ${input.path}`);
  if (info.size > 200_000) throw new Error('Файл задания больше 200 КБ.');
  const bytes = await readFile(input.path);
  let text: string | null = null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
  } catch { /* not valid in its encoding */ }
  if (text === null || text.includes('\0')) throw new Error('Файл задания не в UTF-8 и не в UTF-16 с BOM: сохраните его в UTF-8.');
  return { text };
}
