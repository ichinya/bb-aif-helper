import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Copies for parallel /aif-implement workers. The base folder may be a project root, a section folder with its
// own repository, or a subfolder of a larger repository: the copy forks the whole repository and the worker's
// folder is the same subfolder inside it. BB core forks only a project root that is itself a git checkout.

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 4 << 20 })).stdout.trim();
const exists = (p: string) => stat(p).then(() => true, () => false);
const present = (p: string) => lstat(p).then(() => true, () => false);

/**
 * Deletes a file or folder and checks it is gone. On Windows Node's `rm` can return without an error and leave a
 * file whose path has non-ASCII characters (`раздел\a.txt`); `unlink` and `rmdir` delete it. A file another process
 * holds open stays visible for a moment, so the check waits up to about two seconds.
 */
export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  const walk = async (q: string): Promise<void> => {
    const info = await lstat(q).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(q).catch(() => [] as string[])) await walk(path.join(q, entry));
      await rmdir(q).catch(() => undefined);
    } else await unlink(q).catch(() => undefined);
  };
  for (let i = 0; i < 10 && await present(p); i++) {
    await walk(p);
    if (await present(p)) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (await present(p)) throw new Error(`Не удалось удалить ${p}: его держит другой процесс`);
}

/** Every copy lives here, so removal never touches a folder this plugin did not make. */
export const worktreesRoot = () => path.join(homedir(), '.bb-aif-helper', 'worktrees');
export const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
/** True for a path inside a copy made here: such a folder belongs to a parallel worker. */
export function insideWorktrees(p: string): boolean {
  const inside = path.relative(worktreesRoot(), path.resolve(p));
  return !!inside && inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside);
}

export type CreatedWorktree = { root: string; path: string; sha: string };

/** In a copy's own git folder: the tree of its last bring-back, or of the coordinator's work it was seeded with. */
export const BROUGHT_BACK = 'aif-brought-back';

/**
 * A git index copied to a temporary file keeps its modification time: git trusts a file's cached stat only when the
 * file is older than the index, so a fresh time would hide an edit made in the same second that kept the size.
 */
export async function copyIndex(from: string, to: string) {
  const info = await stat(from);
  await copyFile(from, to);
  await utimes(to, info.atime, info.mtime);
}

/**
 * Gives a fresh copy the coordinator's uncommitted work: changed, new (not ignored) and deleted files, so a worker
 * sees the results of earlier tasks without a commit. The tree is built in a temporary index, so the coordinator's
 * index stays as it was. The copy's index and files become exactly that tree (the work shows as staged changes),
 * and the tree is recorded, so bring-back moves only what the worker changed on top of it.
 */
async function seed(top: string, root: string, sha: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aif-seed-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  const inTemp = (args: string[]) => run('git', ['-C', top, ...args], { timeout: 120_000, maxBuffer: 4 << 20, env });
  try {
    if ((await git(top, ['ls-files', '-u'])).length) throw new Error('В рабочей папке не разрешён конфликт слияния: разрешите его до запуска исполнителей');
    const dirty = await dirtySubmodules(top);
    if (dirty.length) throw new Error(`Незакоммиченные изменения внутри подмодуля ${dirty.join(', ')}: копия исполнителя их не получит. Закоммитьте их в подмодуле или сделайте эту задачу сами`);
    // The temporary index starts as a copy of the coordinator's own: what it staged by hand (a force-added ignored
    // file, a case-only rename, a removal from the index) is part of its work too.
    const index = await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    await copyIndex(index, env.GIT_INDEX_FILE).catch(() => inTemp(['read-tree', sha]));
    await inTemp(['-c', 'core.fsmonitor=false', 'add', '-A']);
    const tree = (await inTemp(['write-tree'])).stdout.trim();
    // --reset, not a two-tree merge: the fresh copy has nothing to keep, and a merge refuses a case-only rename on a
    // case-insensitive disk (`hello.txt` "would be overwritten" by itself).
    await git(root, ['read-tree', '--reset', '-u', tree]);
    await writeFile(await git(root, ['rev-parse', '--path-format=absolute', '--git-path', BROUGHT_BACK]), `${tree}\n`);
  } finally { await removePath(dir).catch(() => undefined); }
}

/**
 * Checked-out submodules (nested ones too) with uncommitted edits or new files. A copy carries a submodule only as
 * its commit, so the worker would test other code. Each submodule is asked itself, with flags that override its own
 * `ignore` and `status.showUntrackedFiles`; `--no-optional-locks` keeps the coordinator's index untouched.
 */
async function dirtySubmodules(repo: string, prefix = ''): Promise<string[]> {
  // The whole index is listed: no buffer cap, so a repository with hundreds of thousands of files launches as before.
  const entries = (await run('git', ['-C', repo, 'ls-files', '-s', '-z'], { timeout: 120_000, maxBuffer: Infinity })).stdout.split('\0');
  const subs = entries.flatMap(entry => { const tab = entry.indexOf('\t'); return entry.startsWith('160000 ') && tab >= 0 ? [entry.slice(tab + 1)] : []; });
  // A repository inside the folder that the index does not list (a `submodule add` taken back out of the index, a plain
  // nested clone) reaches the copy only as a commit too: git lists it as one untracked entry ending in `/`.
  const untracked = (await run('git', ['-C', repo, 'ls-files', '-o', '--exclude-standard', '-z'], { timeout: 120_000, maxBuffer: Infinity })).stdout.split('\0');
  subs.push(...untracked.filter(rel => rel.endsWith('/')).map(rel => rel.slice(0, -1)));
  const found: string[] = [];
  for (const rel of subs) {
    const sub = path.join(repo, rel);
    // A submodule never checked out is an empty folder: git there would answer for the parent repository.
    if (!(await present(path.join(sub, '.git')))) continue;
    // `dirty`: a nested submodule moved to another commit, staged or not, is this submodule's uncommitted change; edits
    // inside the nested one are found by the recursion below.
    const changes = (await run('git', ['--no-optional-locks', '-C', sub, 'status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { timeout: 120_000, maxBuffer: Infinity })).stdout;
    if (changes) found.push(prefix + rel);
    found.push(...await dirtySubmodules(sub, `${prefix}${rel}/`));
  }
  return found;
}

export async function createWorktree(input: { basePath: string; name: string; ref?: string; seed?: boolean }): Promise<CreatedWorktree> {
  if (!WORKTREE_NAME.test(input.name)) throw new Error(`Недопустимое имя копии: ${input.name}`);
  if (!path.isAbsolute(input.basePath)) throw new Error(`Нужен абсолютный путь: ${input.basePath}`);
  if (input.ref?.startsWith('-')) throw new Error(`Недопустимая ссылка: ${input.ref}`);
  const top = await git(input.basePath, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${input.basePath} не в git-репозитории`);
  });
  // `git` trims its answer; a section name may start with a space, so the prefix is read untrimmed.
  const prefix = (await run('git', ['-C', input.basePath, 'rev-parse', '--show-prefix'], { timeout: 120_000 })).stdout.replace(/\r?\n$/, '');
  const sha = await git(top, ['rev-parse', '--verify', `${input.ref || 'HEAD'}^{commit}`]);
  const repoKey = `${path.basename(top)}-${createHash('sha256').update(top).digest('hex').slice(0, 8)}`;
  const root = path.join(worktreesRoot(), repoKey, input.name);
  await mkdir(path.dirname(root), { recursive: true });
  // mkdir without `recursive` claims the name atomically: of two launches with one name only one gets past here,
  // so the cleanup below never removes a copy another launch made.
  await mkdir(root).catch((cause: NodeJS.ErrnoException) => {
    throw cause.code === 'EEXIST' ? new Error(`Копия ${root} уже существует`) : cause;
  });
  // A copy deleted earlier without git may still be registered and would block `worktree add` for this name.
  await git(top, ['worktree', 'prune']).catch(() => '');
  // A copy that fails after git registered it (a post-checkout hook, a full disk, a missing section) is removed:
  // nothing else would ever remove it, and the next try with the same name would say it already exists.
  const discard = async () => {
    await git(top, ['worktree', 'remove', '--force', root]).catch(() => '');
    await removePath(root).catch(() => undefined);
    await git(top, ['worktree', 'prune']).catch(() => '');
  };
  try {
    await git(top, ['worktree', 'add', '--detach', root, sha]);
    if (input.seed) await seed(top, root, sha);
  } catch (cause) { await discard(); throw cause; }
  // git prints the prefix with `/` and a trailing slash; resolve gives the machine's own separators without it.
  const worker = path.resolve(root, prefix);
  if (!(await stat(worker).then(s => s.isDirectory(), () => false))) {
    await discard();
    throw new Error(input.seed
      ? `Папки ${prefix} нет ни в коммите ${sha.slice(0, 12)}, ни среди незакоммиченных файлов: в ней нет ни одного файла, который видит git`
      : `Папки ${prefix} нет в коммите ${sha.slice(0, 12)}: закоммитьте раздел перед запуском исполнителей`);
  }
  return { root, path: worker, sha };
}

/** Removes a copy made by createWorktree; a copy that is already gone counts as removed. */
export async function removeWorktree(input: { basePath: string; root: string }): Promise<{ removed: true }> {
  const root = path.resolve(input.root);
  const inside = path.relative(worktreesRoot(), root);
  // `..demo-1a2b3c4d` (a repository named `..demo`) is inside; only `..` itself or `../…` leaves the folder.
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${root} не копия AI Factory`);
  if (!(await exists(root))) {
    await git(input.basePath, ['worktree', 'prune']).catch(() => '');
    return { removed: true };
  }
  // The copy names its main repository, so a renamed or deleted base folder does not leak it. The removing git runs
  // with --git-dir, not inside the copy: on Windows a git whose folder is the copy cannot delete it (Permission denied).
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  if (common) {
    await run('git', ['--git-dir', common, 'worktree', 'remove', '--force', root], { timeout: 120_000 }).catch(async cause => {
      // git may drop the registration and fail on a file it cannot delete; a later retry would get
      // "is not a working tree". Once git no longer knows the folder, it is ours to delete.
      if (await git(root, ['rev-parse', '--git-dir']).then(() => true, () => false)) throw cause;
    });
  } else await git(input.basePath, ['worktree', 'remove', '--force', root]).catch(() => '');
  await removePath(root);
  return { removed: true };
}
