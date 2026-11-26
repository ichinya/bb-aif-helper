import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
// On Windows rmSync can silently keep a file whose path has Cyrillic in it; tests delete files with unlinkSync.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync, rmSync, unlinkSync, chmodSync, statSync, readdirSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree, removeWorktree, worktreesRoot } from '../worktree.ts';
import { bringBack } from '../parallel-git.ts';

const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'aif-wt-')));
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
process.env.HOME = process.env.USERPROFILE = path.join(sandbox, 'home');
const repo = path.join(sandbox, 'repo');
// Windows runners check out with core.autocrlf=true; the flow must work with it, so text is compared without CR.
const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
mkdirSync(path.join(repo, 'plugins', 'section'), { recursive: true });
writeFileSync(path.join(repo, 'plugins', 'section', 'a.txt'), 'A\n');
git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

test('a section inside a larger repository gets a copy of the repository and its own subfolder', async () => {
  const made = await createWorktree({ basePath: path.join(repo, 'plugins', 'section'), name: 'plan-1' });
  assert(made.root.startsWith(worktreesRoot() + path.sep));
  // No trailing separator on any OS: git prints the prefix as `plugins/section/`.
  assert.equal(made.path, path.join(made.root, 'plugins', 'section'));
  assert.ok(!/[\\/]$/.test(made.path), made.path);
  assert.equal(text(path.join(made.path, 'a.txt')), 'A\n');
  assert.equal(made.sha, git('rev-parse', 'HEAD'));
  await assert.rejects(createWorktree({ basePath: repo, name: 'plan-1' }), /уже существует/);
  assert.deepEqual(await removeWorktree({ basePath: repo, root: made.root }), { removed: true });
  assert.equal(existsSync(made.root), false);
  assert.deepEqual(await removeWorktree({ basePath: repo, root: made.root }), { removed: true });
});

test('a repository root is copied at the requested commit; foreign folders and bad names are refused', async () => {
  const first = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'b.txt'), 'B\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b');
  const made = await createWorktree({ basePath: repo, name: 'plan-2', ref: first });
  assert.equal(made.path, made.root);
  assert.equal(existsSync(path.join(made.path, 'b.txt')), false);
  await removeWorktree({ basePath: repo, root: made.root });
  await assert.rejects(removeWorktree({ basePath: repo, root: repo }), /не копия AI Factory/);
  await assert.rejects(createWorktree({ basePath: repo, name: '../x' }), /Недопустимое имя/);
  await assert.rejects(createWorktree({ basePath: sandbox, name: 'plan-3' }), /не в git-репозитории/);
  await assert.rejects(createWorktree({ basePath: 'repo', name: 'plan-3' }), /абсолютный путь/);
  await assert.rejects(createWorktree({ basePath: repo, name: 'plan-3', ref: '--output=x' }), /Недопустимая ссылка/);
  await assert.rejects(removeWorktree({ basePath: repo, root: worktreesRoot() }), /не копия AI Factory/);
  await assert.rejects(removeWorktree({ basePath: repo, root: path.join(worktreesRoot(), '..', 'x') }), /не копия AI Factory/);
});

test('a copy survives a failing checkout hook cleanly, and is removed even after its base folder is renamed', async () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  // A repository named `..odd`: its copies live in `..odd-<hash>`, which is still inside the copies folder.
  const odd = path.join(sandbox, '..odd');
  mkdirSync(path.join(odd, 'sec'), { recursive: true });
  writeFileSync(path.join(odd, 'sec', 'a.txt'), 'A\n');
  sh(odd, 'init', '-q'); sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'init');
  const hooks = path.join(sandbox, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  sh(odd, 'config', 'core.hooksPath', hooks);
  await assert.rejects(createWorktree({ basePath: path.join(odd, 'sec'), name: 'hooked' }));
  assert.equal(sh(odd, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1, 'no copy stays registered');
  sh(odd, 'config', '--unset', 'core.hooksPath');
  const made = await createWorktree({ basePath: path.join(odd, 'sec'), name: 'hooked' });
  // A section that is not in the requested commit yet: no copy is left behind.
  const first = sh(odd, 'rev-parse', 'HEAD');
  mkdirSync(path.join(odd, 'later'));
  writeFileSync(path.join(odd, 'later', 'b.txt'), 'B\n');
  sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'later');
  await assert.rejects(createWorktree({ basePath: path.join(odd, 'later'), name: 'early', ref: first }), /нет в коммите/);
  assert.equal(sh(odd, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 2);
  renameSync(path.join(odd, 'sec'), path.join(odd, 'sec-renamed'));
  await removeWorktree({ basePath: path.join(odd, 'sec'), root: made.root });
  assert.equal(existsSync(made.root), false);
  sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'rename');
  // Two launches with one name: exactly one copy, and the losing launch does not remove the winner's.
  const results = await Promise.allSettled([1, 2].map(() => createWorktree({ basePath: path.join(odd, 'sec-renamed'), name: 'race' })));
  const won = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ root: string; path: string }>[];
  assert.equal(won.length, 1, JSON.stringify(results.map(r => r.status === "rejected" ? String(r.reason) : "ok")));
  assert.equal(existsSync(path.join(won[0].value.path, 'a.txt')), true);
  // A copy deleted without git, while its base folder was renamed, does not block the next launch with that name.
  const { removePath } = await import('../worktree.ts');
  await removePath(won[0].value.root);
  // Windows may finish a delete a while after rmSync returns, while a scanner or indexer still holds a handle.
  for (let i = 0; i < 300 && existsSync(won[0].value.root); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const again = await createWorktree({ basePath: path.join(odd, 'sec-renamed'), name: 'race' });
  await removeWorktree({ basePath: path.join(odd, 'sec-renamed'), root: again.root });
});

test('bringing results back: a conflicting patch changes nothing and earlier results survive', async () => {
  const top = path.join(sandbox, 'apply-repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(top, 'sec', 'b.txt'), 'b\n');
  // Same contents at the root: with diff.relative a patch made in `sec/` would name the root file instead.
  writeFileSync(path.join(top, 'a.txt'), 'one\ntwo\nthree\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'diff.relative', 'true'); sh(top, 'config', 'diff.noprefix', 'true'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  const sha = sh(top, 'rev-parse', 'HEAD');
  const [one, two] = [await createWorktree({ basePath: base, name: 'apply-1', ref: sha }), await createWorktree({ basePath: base, name: 'apply-2', ref: sha })];
  writeFileSync(path.join(one.path, 'a.txt'), 'one\nTASK1\nthree\n');
  writeFileSync(path.join(one.path, 'logo.bin'), Buffer.from([0, 255, 1, 254, 0]));
  writeFileSync(path.join(two.path, 'a.txt'), 'one\nTASK2\nthree\n');
  writeFileSync(path.join(two.path, 'b.txt'), 'b changed\n');
  writeFileSync(path.join(two.path, 'new.txt'), 'new\n');
  // A worker's real edit of an instruction file travels like any other file.
  mkdirSync(path.join(one.path, '.ai-factory', 'skill-context'), { recursive: true });
  writeFileSync(path.join(one.path, '.ai-factory', 'skill-context', 'notes.md'), 'owner text\n');
  assert.deepEqual((await bringBack({ root: base, copy: one.path })).applied, true);
  assert.equal(text(path.join(base, '.ai-factory', 'skill-context', 'notes.md')), 'owner text\n');
  assert.equal(text(path.join(base, 'a.txt')), 'one\nTASK1\nthree\n');
  assert.equal(text(path.join(top, 'a.txt')), 'one\ntwo\nthree\n', 'the root file with the same contents is untouched');
  assert.deepEqual([...readFileSync(path.join(base, 'logo.bin'))], [0, 255, 1, 254, 0]);
  const snapshot = () => [sh(top, 'status', '--porcelain=v1', '-uall'), sh(top, 'ls-files', '-s'), sh(top, 'diff', '--binary'),
    readFileSync(path.join(base, 'a.txt'), 'utf8'), readFileSync(path.join(base, 'b.txt'), 'utf8')];
  const before = snapshot();
  const refused = await bringBack({ root: base, copy: two.path });
  assert.equal(refused.applied, false);
  // A conflict, not an empty transfer; git's own text depends on its language, so it is not matched.
  assert.deepEqual([refused.empty, refused.files.length > 0, !!refused.error], [false, true, true]);
  assert.deepEqual(snapshot(), before);
  assert.equal(sh(top, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.equal(existsSync(path.join(base, 'new.txt')), false);
  for (const made of [one, two]) await removeWorktree({ basePath: base, root: made.root });
  assert.equal(existsSync(one.root) || existsSync(two.root), false);
});

test('bring-back carries renames, deletions and awkward names, and refuses a folder that is not a copy', async () => {
  const top = path.join(sandbox, 'names repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'раздел'), { recursive: true });
  writeFileSync(path.join(top, 'раздел', 'old.txt'), 'old\n');
  writeFileSync(path.join(top, 'раздел', 'gone.txt'), 'gone\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'раздел');
  const copy = await createWorktree({ basePath: base, name: 'names-1' });
  sh(copy.path, 'mv', 'old.txt', 'new name.txt');
  unlinkSync(path.join(copy.path, 'gone.txt'));
  writeFileSync(path.join(copy.path, 'todo[1].txt'), 'bracket\n');
  // `"` cannot be in a Windows file name; a `'` and Cyrillic can.
  const quoted = process.platform === 'win32' ? "it's тест.txt" : "it's \"quoted\" тест.txt";
  writeFileSync(path.join(copy.path, quoted), 'q\n');
  const result = await bringBack({ root: base, copy: copy.path });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(existsSync(path.join(base, 'old.txt')) || existsSync(path.join(base, 'gone.txt')), false);
  for (const f of ['new name.txt', 'todo[1].txt', quoted]) assert.equal(existsSync(path.join(base, f)), true, f);
  const twice = sh(top, 'status', '--porcelain');
  assert.equal((await bringBack({ root: base, copy: copy.path })).empty, true, 'a second bring-back has nothing new to bring');
  assert.equal(sh(top, 'status', '--porcelain'), twice);
  await assert.rejects(bringBack({ root: base, copy: top }), /не копия AI Factory/);
  await removeWorktree({ basePath: base, root: copy.root });
});

test('bring-back puts files back when writing fails, brings a worker\'s fix again, and a copy never refreshes the plugin blocks', async (t) => {
  const { insideWorktrees } = await import('../worktree.ts');
  const { readDelegation, writeDelegation, CONTEXT_PATH } = await import('../delegation.ts');
  const top = path.join(sandbox, 'resume repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'locked'), { recursive: true });
  writeFileSync(path.join(top, 'a.txt'), 'a\n');
  writeFileSync(path.join(top, 'locked', 'z.txt'), 'z\n');
  writeFileSync(path.join(top, 'z.txt'), 'last\n');
  writeFileSync(path.join(top, '.ai-factory.json'), '{}\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'core.autocrlf', 'false'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  await writeDelegation(top, { mode: 'bb', providerId: 'codex', model: 'm', parallel: 2 });
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'delegation');
  const copy = await createWorktree({ basePath: top, name: 'resume-1' });
  assert.equal(insideWorktrees(copy.path), true);
  // An old block in the copy stays as it is: reading the copy's settings does not rewrite it.
  const block = path.join(copy.path, CONTEXT_PATH);
  writeFileSync(block, readFileSync(block, 'utf8').replace('bring-back --worker', 'OLD --worker'));
  await readDelegation(copy.path);
  assert.ok(readFileSync(block, 'utf8').includes('OLD --worker'));
  sh(copy.path, 'checkout', '--', CONTEXT_PATH);
  writeFileSync(path.join(copy.path, 'a.txt'), 'A\n');
  writeFileSync(path.join(copy.path, 'locked', 'z.txt'), 'Z\n');
  writeFileSync(path.join(copy.path, 'z.txt'), 'LAST\n');
  const { chmodSync } = await import('node:fs');
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.diagnostic('read-only folders need a POSIX non-root user'); }
  else {
    chmodSync(path.join(top, 'locked'), 0o555);
    try {
      const stopped = await bringBack({ root: top, copy: copy.path });
      assert.equal(stopped.applied, false);
      assert.equal((stopped as { partial?: boolean }).partial, undefined, JSON.stringify(stopped));
    } finally { chmodSync(path.join(top, 'locked'), 0o755); }
    // git apply had removed or rewritten files before it failed; they are back as they were.
    assert.equal(text(path.join(top, 'a.txt')), 'a\n');
    assert.equal(text(path.join(top, 'z.txt')), 'last\n');
    assert.equal(sh(top, 'status', '--porcelain'), '');
  }
  const again = await bringBack({ root: top, copy: copy.path });
  assert.equal(again.applied, true, JSON.stringify(again));
  assert.equal(text(path.join(top, 'a.txt')), 'A\n');
  assert.equal(text(path.join(top, 'locked', 'z.txt')), 'Z\n');
  assert.equal(text(path.join(top, 'z.txt')), 'LAST\n');
  // The worker is asked to fix its work: the next bring-back carries just the fix.
  writeFileSync(path.join(copy.path, 'a.txt'), 'A fixed\n');
  const fix = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([fix.applied, fix.files], [true, ['a.txt']]);
  assert.equal(text(path.join(top, 'a.txt')), 'A fixed\n');
  assert.equal((await bringBack({ root: top, copy: copy.path })).empty, true);
  await removeWorktree({ basePath: top, root: copy.root });
});

test('a brief saved by Windows PowerShell 5.1 (UTF-16 with BOM) is read; other bytes are refused', async () => {
  const { readBrief } = await import('../parallel-git.ts');
  const file = path.join(sandbox, 'brief ё.md');
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Задача 2\r\n', 'utf16le')]));
  assert.equal((await readBrief({ path: file })).text, 'Задача 2\r\n');
  writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Задача 3')]));
  assert.equal((await readBrief({ path: file })).text, 'Задача 3');
  writeFileSync(file, Buffer.from([0xd0, 0x00, 0xff, 0x41]));
  await assert.rejects(readBrief({ path: file }), /UTF-8/);
  await assert.rejects(readBrief({ path: 'brief.md' }), /абсолютный путь/);
});

test('bring-back ignores the project diff.context setting', async () => {
  const top = path.join(sandbox, 'context repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'three.txt'), 'one\ntwo\nthree\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'diff.context', '0'); sh(top, 'config', 'core.autocrlf', 'false'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const copy = await createWorktree({ basePath: top, name: 'context-1' });
  writeFileSync(path.join(copy.path, 'three.txt'), 'one\nTWO\nthree\n');
  const result = await bringBack({ root: top, copy: copy.path });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(text(path.join(top, 'three.txt')), 'one\nTWO\nthree\n');
  await removeWorktree({ basePath: top, root: copy.root });
});

test('removePath deletes files and folders with Cyrillic and spaces in the path, and says when it cannot', async () => {
  const { removePath } = await import('../worktree.ts');
  const dir = path.join(sandbox, 'удаление ё', 'раздел');
  mkdirSync(path.join(dir, 'вложенная папка'), { recursive: true });
  writeFileSync(path.join(dir, 'файл.txt'), 'x');
  writeFileSync(path.join(dir, 'вложенная папка', 'ещё.txt'), 'y');
  await removePath(path.join(dir, 'файл.txt'));
  assert.equal(existsSync(path.join(dir, 'файл.txt')), false);
  await removePath(dir);
  assert.equal(existsSync(dir), false);
  await removePath(dir); // already gone is fine
});

test('bring-back: a submodule move is refused, a renamed section still comes back, whitespace and an unwritable receipt', async () => {
  const top = path.join(sandbox, 'moves repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'a.md'), 'line\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'core.autocrlf', 'false'); sh(top, 'config', 'apply.whitespace', 'fix');
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  // A Markdown hard line break (two trailing spaces) survives apply.whitespace=fix.
  const zero = await createWorktree({ basePath: base, name: 'moves-0' });
  writeFileSync(path.join(zero.path, 'a.md'), 'line  \nnext\n');
  assert.equal((await bringBack({ root: base, copy: zero.path })).applied, true);
  assert.equal(text(path.join(base, 'a.md')), 'line  \nnext\n');
  await removeWorktree({ basePath: top, root: zero.root });
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'break');
  // The worker renames the very folder this chat works in: refused, nothing changes.
  const one = await createWorktree({ basePath: base, name: 'moves-1' });
  renameSync(one.path, path.join(one.root, 'moved'));
  const moved = await bringBack({ root: base, copy: one.path });
  assert.equal(moved.applied, false);
  assert.match(moved.error ?? '', /переименовал или удалил папку sec\//);
  assert.equal(existsSync(path.join(base, 'a.md')), true);
  // Done by hand, as the message says: the rest of this test runs from the repository root.
  await removeWorktree({ basePath: top, root: one.root });
  renameSync(base, path.join(top, 'moved'));
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'moved');
  // A submodule in the worker's copy moved to another commit: refused with a reason.
  const sub = path.join(sandbox, 'moves sub');
  mkdirSync(sub, { recursive: true });
  sh(sub, 'init', '-q');
  for (const n of ['A', 'B']) { writeFileSync(path.join(sub, 'f.txt'), n); sh(sub, 'add', '-A'); sh(sub, 'commit', '-qm', n); }
  sh(top, 'submodule', 'add', '-q', sub, 'mod'); sh(top, 'commit', '-qm', 'submodule');
  const two = await createWorktree({ basePath: top, name: 'moves-2' });
  sh(two.path, 'submodule', 'update', '-q', '--init');
  sh(path.join(two.path, 'mod'), 'checkout', '-q', 'HEAD~1');
  sh(two.path, 'config', 'submodule.mod.ignore', 'all'); // hidden from a plain diff, still refused
  writeFileSync(path.join(two.path, 'moved', 'a.md'), 'also\n');
  const refused = await bringBack({ root: top, copy: two.path });
  assert.equal(refused.applied, false);
  assert.match(refused.error ?? '', /подмодуль: mod/);
  await removeWorktree({ basePath: top, root: two.root });
  // Tracked edits inside a checked-out submodule (another repository) are refused, not reported as brought back.
  const four = await createWorktree({ basePath: top, name: 'moves-4' });
  sh(four.path, 'submodule', 'update', '-q', '--init');
  writeFileSync(path.join(four.path, 'mod', 'f.txt'), 'edited inside the submodule');
  writeFileSync(path.join(four.path, 'moved', 'a.md'), 'parent edit\n');
  const inside = await bringBack({ root: top, copy: four.path });
  assert.equal(inside.applied, false);
  assert.match(inside.error ?? '', /внутри подмодуля[\s\S]*"mod\/f\.txt"/);
  assert.notEqual(text(path.join(top, 'moved', 'a.md')), 'parent edit\n', 'nothing is brought back');
  // A new file inside the submodule is a change a patch cannot carry either (a source file the parent now imports,
  // or build output): refused with the file named; once the worker's copy no longer has it, the parent edit comes back.
  writeFileSync(path.join(four.path, 'mod', 'f.txt'), 'B');
  mkdirSync(path.join(four.path, 'mod', 'dist'), { recursive: true });
  writeFileSync(path.join(four.path, 'mod', 'dist', 'index.js'), 'built');
  const added = await bringBack({ root: top, copy: four.path });
  assert.equal(added.applied, false);
  assert.match(added.error ?? '', /"mod\/dist\/index\.js"/);
  unlinkSync(path.join(four.path, 'mod', 'dist', 'index.js'));
  const back = await bringBack({ root: top, copy: four.path });
  assert.deepEqual([back.applied, back.files], [true, ['moved/a.md']]);
  assert.equal(text(path.join(top, 'moved', 'a.md')), 'parent edit\n');
  await removeWorktree({ basePath: top, root: four.root });
  sh(top, 'checkout', '-q', '--', 'moved/a.md');
  // A submodule the copy never checked out: a file the worker put in its empty folder is skipped by the parent's
  // `add -A` (the path is a gitlink), so it is refused by name instead of a transfer that leaves it behind.
  const six = await createWorktree({ basePath: top, name: 'moves-6' });
  mkdirSync(path.join(six.path, 'mod', 'gen'), { recursive: true });
  writeFileSync(path.join(six.path, 'mod', 'gen', 'generated.mjs'), 'export const x = 1;\n');
  writeFileSync(path.join(six.path, 'moved', 'a.md'), 'imports mod/gen/generated.mjs\n');
  const unchecked = await bringBack({ root: top, copy: six.path });
  assert.equal(unchecked.applied, false);
  assert.match(unchecked.error ?? '', /внутри подмодуля[\s\S]*"mod\/gen\/generated\.mjs"/);
  assert.notEqual(text(path.join(top, 'moved', 'a.md')), 'imports mod/gen/generated.mjs\n', 'nothing is brought back');
  // Build output there is refused too, even when the coordinator's submodule ignores it: no patch can carry it, and a
  // tracked file under an ignored path would otherwise be dropped silently. Once removed, the parent edit comes back.
  rmSync(path.join(six.path, 'mod', 'gen'), { recursive: true });
  const exclude = path.resolve(top, 'mod', sh(path.join(top, 'mod'), 'rev-parse', '--git-path', 'info/exclude'));
  mkdirSync(path.dirname(exclude), { recursive: true });
  writeFileSync(exclude, 'dist/\n');
  mkdirSync(path.join(six.path, 'mod', 'dist'), { recursive: true });
  writeFileSync(path.join(six.path, 'mod', 'dist', 'generated.mjs'), 'built\n');
  const built = await bringBack({ root: top, copy: six.path });
  assert.equal(built.applied, false);
  assert.match(built.error ?? '', /"mod\/dist\/generated\.mjs"/);
  rmSync(path.join(six.path, 'mod', 'dist'), { recursive: true });
  const parent = await bringBack({ root: top, copy: six.path });
  assert.deepEqual([parent.applied, parent.files], [true, ['moved/a.md']], parent.error);
  sh(top, 'checkout', '-q', '--', 'moved/a.md');
  // A folder that cannot be read refuses instead of hiding what is inside it (root reads everything; Windows has no modes).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    mkdirSync(path.join(six.path, 'mod', 'locked'));
    writeFileSync(path.join(six.path, 'mod', 'locked', 'x.mjs'), 'x\n');
    chmodSync(path.join(six.path, 'mod', 'locked'), 0o311);
    writeFileSync(path.join(six.path, 'moved', 'a.md'), 'second edit\n');
    await assert.rejects(bringBack({ root: top, copy: six.path }), /Не удалось прочитать/);
    chmodSync(path.join(six.path, 'mod', 'locked'), 0o755);
    rmSync(path.join(six.path, 'mod', 'locked'), { recursive: true });
    assert.notEqual(text(path.join(top, 'moved', 'a.md')), 'second edit\n', 'nothing is brought back');
  }
  // The submodule folder replaced by a symlink is itself the change; nothing outside the copy is listed.
  if (process.platform !== 'win32') {
    const outside = mkdtempSync(path.join(tmpdir(), 'aif-outside-'));
    sh(outside, 'init', '-q'); // another git checkout: its files must not be reported as the worker's
    writeFileSync(path.join(outside, 'external-only.txt'), 'x');
    rmSync(path.join(six.path, 'mod'), { recursive: true });
    symlinkSync(outside, path.join(six.path, 'mod'));
    const linked = await bringBack({ root: top, copy: six.path });
    assert.equal(linked.applied, false);
    assert.match(linked.error ?? '', /внутри подмодуля[\s\S]*"mod"/);
    assert.doesNotMatch(linked.error ?? '', /external-only/);
    rmSync(outside, { recursive: true, force: true });
  }
  rmSync(exclude, { force: true });
  await removeWorktree({ basePath: top, root: six.root });
  // A nested submodule that its parent marks `ignore = all`: an edit two levels down is still found.
  const inner = path.join(sandbox, 'moves inner');
  mkdirSync(inner, { recursive: true }); sh(inner, 'init', '-q');
  writeFileSync(path.join(inner, 'g.txt'), 'G'); sh(inner, 'add', '-A'); sh(inner, 'commit', '-qm', 'G');
  sh(sub, 'submodule', 'add', '-q', inner, 'inner');
  sh(sub, 'config', '-f', '.gitmodules', 'submodule.inner.ignore', 'all'); sh(sub, 'add', '-A'); sh(sub, 'commit', '-qm', 'nested');
  sh(path.join(top, 'mod'), 'pull', '-q', 'origin', 'HEAD'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'nested submodule');
  const five = await createWorktree({ basePath: top, name: 'moves-5' });
  sh(five.path, 'submodule', 'update', '-q', '--init', '--recursive');
  writeFileSync(path.join(five.path, 'mod', 'inner', 'g.txt'), 'edited two levels down');
  writeFileSync(path.join(five.path, 'moved', 'a.md'), 'parent edit\n');
  assert.match((await bringBack({ root: top, copy: five.path })).error ?? '', /"mod\/inner\/g\.txt"/);
  await removeWorktree({ basePath: top, root: five.root });
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const { chmodSync } = await import('node:fs');
    const three = await createWorktree({ basePath: top, name: 'moves-3' });
    writeFileSync(path.join(three.path, 'moved', 'a.md'), 'changed\n');
    const mark = sh(three.path, 'rev-parse', '--path-format=absolute', '--git-path', 'aif-brought-back');
    writeFileSync(mark, ''); chmodSync(mark, 0o444);
    try { await assert.rejects(bringBack({ root: top, copy: three.path }), /недоступна для записи/); }
    finally { chmodSync(mark, 0o644); }
    assert.equal(text(path.join(top, 'moved', 'a.md')), 'line  \nnext\n', 'nothing changed before the refusal');
    await removeWorktree({ basePath: top, root: three.root });
  }
});

test('bring-back keeps the chat folder: a later move out of it is undone, a deletion next to a new file is fine', async () => {
  const top = path.join(sandbox, 'folder repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'a.txt'), 'a\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'core.autocrlf', 'false'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  // Two workers: one adds b.txt, the other deletes a.txt. Together the folder stays, so both come back.
  const [one, two] = [await createWorktree({ basePath: base, name: 'folder-1' }), await createWorktree({ basePath: base, name: 'folder-2' })];
  writeFileSync(path.join(one.path, 'b.txt'), 'b\n');
  unlinkSync(path.join(two.path, 'a.txt'));
  assert.equal((await bringBack({ root: base, copy: one.path })).applied, true);
  assert.equal((await bringBack({ root: base, copy: two.path })).applied, true);
  assert.deepEqual([existsSync(path.join(base, 'a.txt')), existsSync(path.join(base, 'b.txt'))], [false, true]);
  // The first worker then moves b.txt out of the folder: that would empty it, so it is undone and refused.
  renameSync(path.join(one.path, 'b.txt'), path.join(one.root, 'b.txt'));
  if (process.platform !== 'win32') chmodSync(base, 0o700);
  const folder = statSync(base);
  const out = await bringBack({ root: base, copy: one.path });
  if (process.platform !== 'win32') {
    assert.equal(statSync(base).ino, folder.ino, 'the refused patch did not recreate the folder');
    assert.equal(statSync(base).mode & 0o777, 0o700);
  }
  assert.equal(out.applied, false);
  assert.match(out.error ?? '', /переименовал или удалил папку sec\//);
  assert.equal(text(path.join(base, 'b.txt')), 'b\n', 'nothing was touched');
  assert.equal(existsSync(path.join(top, 'b.txt')), false);
  // An untracked file the owner keeps in the folder keeps it alive: then the move is fine.
  writeFileSync(path.join(base, 'notes.local'), 'mine\n');
  assert.equal((await bringBack({ root: base, copy: one.path })).applied, true);
  assert.equal(existsSync(path.join(top, 'b.txt')), true);
  for (const made of [one, two]) await removeWorktree({ basePath: base, root: made.root });
});

test('bring-back keeps the chat folder: renaming its only file keeps its permissions, an empty subfolder, an untouched empty folder', async () => {
  const top = path.join(sandbox, 'keep repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'old.txt'), 'a\n');
  writeFileSync(path.join(top, 'root.txt'), 'r\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'core.autocrlf', 'false'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  // Renaming the only file: git may make the folder again, and it gets the chat folder's permissions back.
  if (process.platform !== 'win32') chmodSync(base, 0o700);
  const one = await createWorktree({ basePath: base, name: 'keep-1' });
  renameSync(path.join(one.path, 'old.txt'), path.join(one.path, 'new.txt'));
  assert.equal((await bringBack({ root: base, copy: one.path })).applied, true);
  assert.deepEqual(readdirSync(base), ['new.txt']);
  if (process.platform !== 'win32') assert.equal(statSync(base).mode & 0o777, 0o700, 'the folder keeps its permissions');
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'renamed');
  // The owner has emptied the folder on disk; a worker that only edits a root file did not remove it.
  const three = await createWorktree({ basePath: base, name: 'keep-3' });
  unlinkSync(path.join(base, 'new.txt'));
  writeFileSync(path.join(three.root, 'root.txt'), 'r2\n');
  assert.equal((await bringBack({ root: base, copy: three.path })).applied, true);
  assert.equal(text(path.join(top, 'root.txt')), 'r2\n');
  sh(top, 'checkout', '--', 'sec'); sh(top, 'commit', '-qam', 'root');
  // An empty subfolder the patch does not touch keeps the folder: moving the file out is fine.
  mkdirSync(path.join(base, 'empty'));
  const two = await createWorktree({ basePath: base, name: 'keep-2' });
  renameSync(path.join(two.path, 'new.txt'), path.join(two.root, 'moved.txt'));
  assert.equal((await bringBack({ root: base, copy: two.path })).applied, true);
  assert.equal(existsSync(path.join(top, 'moved.txt')), true);
  for (const made of [one, two, three]) await removeWorktree({ basePath: base, root: made.root });
});


test('a seeded copy holds the coordinator\'s uncommitted work, and bring-back returns only the worker\'s changes', async () => {
  const top = path.join(sandbox, 'seed repo ё');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'done.txt'), 'old\n');
  writeFileSync(path.join(top, 'sec', 'gone.txt'), 'gone\n');
  writeFileSync(path.join(top, 'sec', 'staged.txt'), 's0\n');
  writeFileSync(path.join(top, '.gitignore'), 'node_modules/\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  // Results of earlier tasks, never committed: an edit, a new file in a new folder, a deletion, a staged edit.
  writeFileSync(path.join(base, 'done.txt'), 'task 1\n');
  mkdirSync(path.join(base, 'новая папка'), { recursive: true });
  writeFileSync(path.join(base, 'новая папка', 'файл [1].txt'), 'new\n');
  unlinkSync(path.join(base, 'gone.txt'));
  writeFileSync(path.join(base, 'staged.txt'), 's1\n'); sh(top, 'add', 'sec/staged.txt');
  mkdirSync(path.join(base, 'node_modules'), { recursive: true });
  writeFileSync(path.join(base, 'node_modules', 'x.js'), 'ignored\n');
  const index = () => sh(top, 'ls-files', '-s');
  const before = [index(), sh(top, 'status', '--porcelain=v1', '-uall'), sh(top, 'rev-parse', 'HEAD')];
  const copy = await createWorktree({ basePath: base, name: 'seed-1', seed: true });
  assert.deepEqual([index(), sh(top, 'status', '--porcelain=v1', '-uall'), sh(top, 'rev-parse', 'HEAD')], before, 'the coordinator\'s workspace and index are untouched');
  assert.equal(text(path.join(copy.path, 'done.txt')), 'task 1\n');
  assert.equal(text(path.join(copy.path, 'новая папка', 'файл [1].txt')), 'new\n');
  assert.equal(text(path.join(copy.path, 'staged.txt')), 's1\n');
  assert.equal(existsSync(path.join(copy.path, 'gone.txt')), false);
  assert.equal(existsSync(path.join(copy.path, 'node_modules')), false, 'ignored files stay out');
  // The copy's index holds the work (staged), so what the worker stages lands on top of it.
  assert.equal(sh(copy.root, 'diff', '--name-only'), '', 'files and index of the copy agree');
  assert.equal(sh(copy.root, 'rev-parse', 'HEAD'), before[2]);
  // Nothing done by the worker: nothing comes back, the coordinator's work is not echoed.
  assert.deepEqual(await bringBack({ root: base, copy: copy.path }), { applied: false, empty: true, files: [] });
  writeFileSync(path.join(copy.path, 'done.txt'), 'task 1\ntask 2\n');
  writeFileSync(path.join(copy.path, 'worker.txt'), 'w\n');
  const back = await bringBack({ root: base, copy: copy.path });
  assert.deepEqual([back.applied, [...back.files].sort()], [true, ['sec/done.txt', 'sec/worker.txt']]);
  assert.equal(text(path.join(base, 'done.txt')), 'task 1\ntask 2\n');
  assert.equal(text(path.join(base, 'новая папка', 'файл [1].txt')), 'new\n');
  assert.equal(sh(top, 'diff', '--cached', '--name-only'), 'sec/staged.txt', 'the coordinator\'s staged edit stays staged');
  await removeWorktree({ basePath: base, root: copy.root });
});

test('a seeded copy works for a section that exists only as uncommitted files; without seed it is refused', async () => {
  const top = path.join(sandbox, 'seed-new-section');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'root.txt'), 'r\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'fresh');
  mkdirSync(base); writeFileSync(path.join(base, 'a.txt'), 'a\n');
  await assert.rejects(createWorktree({ basePath: base, name: 'fresh-1' }), /Папки fresh\/ нет в коммите/);
  const copy = await createWorktree({ basePath: base, name: 'fresh-2', seed: true });
  assert.equal(text(path.join(copy.path, 'a.txt')), 'a\n');
  await removeWorktree({ basePath: base, root: copy.root });
});

test('review of e497ba0: an ignore rule, a force-added file, a submodule the copy never checked out', async () => {
  const top = path.join(sandbox, 'seed-review');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
  const lib = path.join(sandbox, 'seed-review-lib');
  mkdirSync(lib, { recursive: true }); writeFileSync(path.join(lib, 'l.txt'), 'A\n');
  sh(lib, 'init', '-q'); sh(lib, 'add', '-A'); sh(lib, 'commit', '-qm', 'A');
  writeFileSync(path.join(lib, 'l.txt'), 'B\n'); sh(lib, 'commit', '-qam', 'B');
  const libB = sh(lib, 'rev-parse', 'HEAD'); // no branch name: init.defaultBranch may be main or master
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, '.gitignore'), '*.env\n');
  sh(top, 'init', '-q'); sh(top, 'submodule', 'add', '-q', lib, 'lib'); sh(path.join(top, 'lib'), 'checkout', '-q', 'HEAD~1');
  sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  // Coordinator's work: an untracked file, a force-added ignored file, a submodule moved without a commit.
  writeFileSync(path.join(top, 'local.txt'), 'mine\n');
  writeFileSync(path.join(top, 'config.env'), 'KEY=1\n'); sh(top, 'add', '-f', 'config.env');
  sh(path.join(top, 'lib'), 'checkout', '-q', libB);
  const copy = await createWorktree({ basePath: top, name: 'seed-review-1', seed: true });
  assert.equal(text(path.join(copy.path, 'config.env')), 'KEY=1\n', 'a force-added file is part of the work');
  // The worker ignores the coordinator's file and adds its own: only its own file comes back.
  writeFileSync(path.join(copy.path, '.gitignore'), '*.env\nlocal.txt\n');
  writeFileSync(path.join(copy.path, 'worker.txt'), 'w\n');
  const back = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([back.error, back.applied, [...back.files].sort()], [undefined, true, ['.gitignore', 'worker.txt']]);
  assert.equal(text(path.join(top, 'local.txt')), 'mine\n', 'the coordinator\'s file survives');
  await removeWorktree({ basePath: top, root: copy.root });
});

test('review of 9f6867b, 8fa0a42 and af77a9d: a coordinator\'s case-only rename, gc between bring-backs, a lost seed is refused', async () => {
  const top = path.join(sandbox, 'seed-review-2');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'Hello.txt'), 'h\n');
  writeFileSync(path.join(top, 'Keep.txt'), 'k\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  writeFileSync(path.join(top, 'previous.txt'), 'p\n');
  // A case-insensitive disk (Windows, macOS): the coordinator has staged a case-only rename.
  writeFileSync(path.join(top, 'Probe.tmp'), ''); const folds = existsSync(path.join(top, 'probe.tmp')); unlinkSync(path.join(top, 'Probe.tmp'));
  if (folds) sh(top, 'mv', 'Hello.txt', 'hello.txt');
  const copy = await createWorktree({ basePath: top, name: 'seed-review-2', seed: true });
  if (folds) assert.ok(readdirSync(copy.path).includes('hello.txt'), 'the coordinator\'s case-only rename reaches the copy');
  writeFileSync(path.join(copy.path, 'other.txt'), 'o\n');
  const back = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([back.error, back.applied, back.files], [undefined, true, ['other.txt']]);
  // A git the worker left running holds the copy's index: refused before anything changes, then a normal retry.
  writeFileSync(path.join(copy.path, 'locked.txt'), 'l\n');
  const lock = sh(copy.root, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
  writeFileSync(lock, '');
  const locked = await bringBack({ root: top, copy: copy.path });
  unlinkSync(lock);
  assert.match(locked.error ?? '', /Индекс копии исполнителя занят/);
  assert.equal(existsSync(path.join(top, 'locked.txt')), false, 'nothing changed');
  const retried = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([retried.error, retried.applied, retried.files], [undefined, true, ['locked.txt']]);
  // A refused transfer (the coordinator has the same new file) keeps the baseline: gc does not prune it, and a file the
  // worker later ignores is not deleted on retry.
  writeFileSync(path.join(copy.path, 'collision.txt'), 'w\n');
  writeFileSync(path.join(top, 'collision.txt'), 'c\n');
  const collided = await bringBack({ root: top, copy: copy.path });
  assert.equal(collided.applied, false);
  assert.deepEqual([collided.empty, collided.files.includes('collision.txt'), !!collided.error], [false, true, true]);
  unlinkSync(path.join(top, 'collision.txt'));
  writeFileSync(path.join(copy.path, '.gitignore'), 'previous.txt\n');
  sh(top, 'gc', '-q', '--prune=now');
  const afterRefusal = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([afterRefusal.error, afterRefusal.applied, [...afterRefusal.files].sort()], [undefined, true, ['.gitignore', 'collision.txt']]);
  assert.equal(text(path.join(top, 'previous.txt')), 'p\n', 'the coordinator\'s file survives the retry');
  // gc in the coordinator's folder between two bring-backs keeps the baseline of the worker's fix.
  writeFileSync(path.join(copy.path, 'other.txt'), 'o fixed\n');
  sh(top, 'gc', '-q', '--prune=now');
  const fix = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([fix.error, fix.applied, fix.files], [undefined, true, ['other.txt']]);
  assert.equal(text(path.join(top, 'other.txt')), 'o fixed\n');
  // A receipt naming a tree git no longer has: refused, the coordinator's own work is not sent back as the worker's.
  const mark = sh(copy.root, 'rev-parse', '--path-format=absolute', '--git-path', 'aif-brought-back');
  writeFileSync(mark, 'f'.repeat(40) + '\n');
  writeFileSync(path.join(copy.path, 'more.txt'), 'm\n');
  assert.match((await bringBack({ root: top, copy: copy.path })).error ?? '', /Базовое состояние копии исполнителя потеряно/);
  assert.equal(existsSync(path.join(top, 'more.txt')), false);
  await removeWorktree({ basePath: top, root: copy.root });
});


test('review of 71dce6b: a submodule below a folder — unreadable, symlinked or huge, never a silent transfer', async () => {
  const top = path.join(sandbox, 'deep-sub');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
  const lib = path.join(sandbox, 'deep-sub-lib');
  mkdirSync(lib, { recursive: true }); writeFileSync(path.join(lib, 'l.txt'), 'A\n');
  sh(lib, 'init', '-q'); sh(lib, 'add', '-A'); sh(lib, 'commit', '-qm', 'A');
  mkdirSync(top, { recursive: true }); writeFileSync(path.join(top, 'p.txt'), 'parent\n');
  sh(top, 'init', '-q'); sh(top, 'submodule', 'add', '-q', lib, 'deps/mod'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const copy = await createWorktree({ basePath: top, name: 'deep-1', seed: true });
  writeFileSync(path.join(copy.path, 'p.txt'), 'parent edit\n');
  const unchanged = () => assert.equal(readFileSync(path.join(top, 'p.txt'), 'utf8'), 'parent\n', 'nothing is brought back');
  // A folder above the submodule that cannot be read refuses instead of reading as "no submodule there".
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    writeFileSync(path.join(copy.path, 'deps', 'mod', 'generated.js'), 'x\n');
    chmodSync(path.join(copy.path, 'deps'), 0o600);
    await assert.rejects(bringBack({ root: top, copy: copy.path }), /Не удалось прочитать/);
    chmodSync(path.join(copy.path, 'deps'), 0o755);
    unlinkSync(path.join(copy.path, 'deps', 'mod', 'generated.js'));
    unchanged();
  }
  // A symlink in place of a folder above the submodule is the change itself; nothing behind it is listed.
  if (process.platform !== 'win32') {
    const outside = mkdtempSync(path.join(tmpdir(), 'aif-outside-'));
    mkdirSync(path.join(outside, 'mod')); writeFileSync(path.join(outside, 'mod', 'external-only.txt'), 'x');
    renameSync(path.join(copy.path, 'deps'), path.join(copy.path, 'deps-real'));
    symlinkSync(outside, path.join(copy.path, 'deps'));
    const linked = await bringBack({ root: top, copy: copy.path });
    assert.equal(linked.applied, false);
    assert.match(linked.error ?? '', /внутри подмодуля[\s\S]*"deps"/);
    assert.doesNotMatch(linked.error ?? '', /external-only/);
    unlinkSync(path.join(copy.path, 'deps')); renameSync(path.join(copy.path, 'deps-real'), path.join(copy.path, 'deps'));
    rmSync(outside, { recursive: true, force: true });
    unchanged();
  }
  // Very many files are listed without overflowing the stack and refused by count.
  const many = path.join(copy.path, 'deps', 'mod');
  for (let i = 0; i < 130_000; i++) writeFileSync(path.join(many, `f${i}`), '');
  const huge = await bringBack({ root: top, copy: copy.path });
  assert.equal(huge.applied, false);
  assert.match(huge.error ?? '', /и ещё 129992/);
  unchanged();
  rmSync(many, { recursive: true }); mkdirSync(many);
  const back = await bringBack({ root: top, copy: copy.path });
  assert.deepEqual([back.applied, back.files], [true, ['p.txt']], back.error);
  await removeWorktree({ basePath: top, root: copy.root });
});

test('a seeded copy is refused while the coordinator has uncommitted edits inside a submodule, naming it', async () => {
  const top = path.join(sandbox, 'seed-submodule-edit');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
  const lib = path.join(sandbox, 'seed-submodule-edit-lib');
  mkdirSync(lib, { recursive: true }); writeFileSync(path.join(lib, 'l.txt'), 'committed\n');
  sh(lib, 'init', '-q'); sh(lib, 'add', '-A'); sh(lib, 'commit', '-qm', 'A');
  mkdirSync(top, { recursive: true });
  sh(top, 'init', '-q'); sh(top, 'submodule', 'add', '-q', lib, 'vendor/lib'); sh(top, 'commit', '-qm', 'init');
  // A clean submodule never blocks a copy.
  const clean = await createWorktree({ basePath: top, name: 'seed-submodule-clean', seed: true });
  await removeWorktree({ basePath: top, root: clean.root });
  // The worker would test the committed text, not this edit: refused, and no copy is left behind.
  writeFileSync(path.join(top, 'vendor', 'lib', 'l.txt'), 'edited by the coordinator\n');
  sh(top, 'config', 'submodule.vendor/lib.ignore', 'all'); // hidden from a plain status, still found
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-submodule-edit', seed: true }), /подмодул[а-я]* vendor\/lib/);
  assert.equal(existsSync(path.join(worktreesRoot(), path.basename(path.dirname(clean.root)), 'seed-submodule-edit')), false);
  // A new file inside the submodule is such an edit too.
  sh(path.join(top, 'vendor', 'lib'), 'checkout', '-q', '--', 'l.txt');
  writeFileSync(path.join(top, 'vendor', 'lib', 'new.ts'), 'export {}\n');
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-submodule-new', seed: true }), /vendor\/lib/);
  // ... even when the submodule hides untracked files from its status.
  sh(path.join(top, 'vendor', 'lib'), 'config', 'status.showUntrackedFiles', 'no');
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-submodule-hidden', seed: true }), /vendor\/lib/);
  unlinkSync(path.join(top, 'vendor', 'lib', 'new.ts'));
  // A staged rename with spaces in the parent does not break the check, and the check leaves the index as it was.
  writeFileSync(path.join(top, '1 draft.md'), 'd\n'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'draft');
  sh(top, 'mv', '1 draft.md', '2 draft.md');
  const indexFile = path.join(top, '.git', 'index');
  const before = readFileSync(indexFile);
  const later = new Date(Date.now() + 5000); utimesSync(path.join(top, 'vendor', 'lib', 'l.txt'), later, later);
  const renamed = await createWorktree({ basePath: top, name: 'seed-submodule-rename', seed: true });
  assert.ok(existsSync(path.join(renamed.path, '2 draft.md')));
  assert.ok(readFileSync(indexFile).equals(before), 'the coordinator\'s index is not rewritten');
  await removeWorktree({ basePath: top, root: renamed.root });
});

test('a seeded copy is refused while a nested submodule sits on a commit its parent submodule has not committed', async () => {
  const top = path.join(sandbox, 'seed-nested-gitlink');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
  const inner = path.join(sandbox, 'seed-nested-gitlink-inner'), lib = path.join(sandbox, 'seed-nested-gitlink-lib');
  mkdirSync(inner, { recursive: true }); writeFileSync(path.join(inner, 'i.txt'), 'A\n');
  sh(inner, 'init', '-q'); sh(inner, 'add', '-A'); sh(inner, 'commit', '-qm', 'A');
  mkdirSync(lib, { recursive: true }); sh(lib, 'init', '-q'); sh(lib, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'inner'); sh(lib, 'commit', '-qm', 'lib');
  mkdirSync(top, { recursive: true }); sh(top, 'init', '-q'); sh(top, 'submodule', 'add', '-q', lib, 'lib'); sh(top, 'commit', '-qm', 'init');
  sh(top, 'submodule', 'update', '-q', '--init', '--recursive');
  // The coordinator moves the nested submodule to a newer commit and stages it in lib, without committing lib.
  const nested = path.join(top, 'lib', 'inner');
  writeFileSync(path.join(nested, 'i.txt'), 'B\n'); sh(nested, 'commit', '-qam', 'B');
  sh(path.join(top, 'lib'), 'add', 'inner');
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-nested-staged', seed: true }), /подмодул[а-я]* lib/);
  // Unstaged, the move is the same uncommitted change.
  sh(path.join(top, 'lib'), 'reset', '-q', 'inner');
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-nested-unstaged', seed: true }), /подмодул[а-я]* lib/);
});

test('a seeded copy is refused for an edit inside a just-added submodule taken back out of the index', async () => {
  const top = path.join(sandbox, 'seed-unstaged-submodule');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
  const lib = path.join(sandbox, 'seed-unstaged-submodule-lib');
  mkdirSync(lib, { recursive: true }); writeFileSync(path.join(lib, 'l.txt'), 'committed\n');
  sh(lib, 'init', '-q'); sh(lib, 'add', '-A'); sh(lib, 'commit', '-qm', 'A');
  mkdirSync(top, { recursive: true }); writeFileSync(path.join(top, 'a.txt'), 'a\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  sh(top, 'submodule', 'add', '-q', lib, 'vendor/lib'); sh(top, 'restore', '--staged', '.');
  writeFileSync(path.join(top, 'vendor', 'lib', 'l.txt'), 'edited by the coordinator\n');
  await assert.rejects(createWorktree({ basePath: top, name: 'seed-unstaged-edit', seed: true }), /подмодул[а-я]* vendor\/lib/);
});
