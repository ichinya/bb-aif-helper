import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RESEARCH_ROLES } from './model.ts';
import { insideWorktrees } from './worktree.ts';
import type { DelegationChoice, DelegationRole, DelegationState, ResearchRole } from './model.ts';
export { DELEGATION_ROLES, RESEARCH_ROLES, delegationChoiceSchema, delegationDefaultsSchema, delegationRoleSchema, delegationStateSchema } from './model.ts';
export type { DelegationChoice, DelegationDefaults, DelegationRole, DelegationState, ResearchRole } from './model.ts';

// Code delegation: /aif-implement hands each plan task to a BB thread on the
// model the owner picked in the panel. `.ai-factory.json` → phases.implement is
// the single source of truth (AI Factory's own dispatch config); the
// skill-context block is a managed copy derived from it. Workers are spawned
// with native `bb thread` commands described in that block — no project script.

export const CONTEXT_PATH = '.ai-factory/skill-context/aif-implement/SKILL.md';
const START = '<!-- bb-aif-helper:delegation:start -->';
const END = '<!-- bb-aif-helper:delegation:end -->';
export const PLAN_CONTEXT_PATH = '.ai-factory/skill-context/aif-plan/SKILL.md';
const PLAN_START = '<!-- bb-aif-helper:plan:start -->';
const PLAN_END = '<!-- bb-aif-helper:plan:end -->';
// Research: every AI Factory skill reads the global skill-context, so Explore-style
// subagents of /aif-plan, /aif-fix, /aif-qa… run as BB threads on the chosen model.
// The block itself is the source of truth: its first lines record the model spec
// of each of the three research workers (the /aif-plan Explore agents 1-3).
export const RESEARCH_PATH = '.ai-factory/skill-context/global-skill-context.md';
const RESEARCH_START = '<!-- bb-aif-helper:research:start -->';
const RESEARCH_END = '<!-- bb-aif-helper:research:end -->';
const MARKERS: [string, string][] = [[START, END], [PLAN_START, PLAN_END], [RESEARCH_START, RESEARCH_END]];
/** The text with every managed block emptied: two versions that differ only inside the plugin's blocks become equal. */
export function withoutManagedBlocks(text: string): string {
  let out = text.replace(/\r\n/g, '\n');
  for (const [a, b] of MARKERS) {
    const i = out.indexOf(a), j = out.indexOf(b, i);
    if (i >= 0 && j >= 0) out = out.slice(0, i + a.length) + out.slice(j);
  }
  return out;
}
const RESEARCH_MARK: Record<ResearchRole, string> = { research: 'research-model', research2: 'research-model-2', research3: 'research-model-3' };
const AGENT = 'bb';
const TIMEOUT_MS = 4 * 60 * 60 * 1000;

// AI Factory keeps only agent/model/timeoutMs of a phase, so the whole BB
// selection lives in `model`: provider/model?reasoning=high&tier=fast.
// The model part may itself contain "/" or ":" (OpenRouter, Ollama ids).
export function modelSpec(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const query = [c.reasoning && `reasoning=${c.reasoning}`, c.tier && `tier=${c.tier}`, c.parallel && `parallel=${c.parallel}`].filter(Boolean).join('&');
  return `${c.providerId}/${c.model}${query ? `?${query}` : ''}`;
}
export function parseSpec(value: unknown): DelegationChoice | null {
  const m = typeof value === 'string' ? /^([\w.-]{1,100})\/([^\s?&#]{1,200})(?:\?([\w.=&-]{1,200}))?$/.exec(value) : null;
  if (!m) return null;
  const params = new URLSearchParams(m[3] ?? '');
  const reasoning = params.get('reasoning'), tier = params.get('tier'), parallel = params.get('parallel');
  const ok = (v: string | null) => v === null || /^[\w.-]{1,100}$/.test(v);
  if (!ok(reasoning) || !ok(tier) || (parallel !== null && !/^[2-4]$/.test(parallel))) return null;
  return { mode: 'bb', providerId: m[1], model: m[2], ...(reasoning ? { reasoning } : {}), ...(tier ? { tier } : {}), ...(parallel ? { parallel: Number(parallel) } : {}) };
}

// parallel workers are an implement-only setting: research choices never keep it.
const stripParallel = (c: BbChoice): BbChoice => {
  const { parallel: _p, ...rest } = c;
  return rest;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

async function readConfig(root: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
    if (!isObject(parsed)) throw new Error('.ai-factory.json is not an object');
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

export type ResearchSlots = Record<ResearchRole, DelegationChoice>;
const selfSlots = (): ResearchSlots => ({ research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' } });

/** The research choices recorded in the managed block of the global skill-context; self when absent or malformed. */
export function parseResearch(text: string): ResearchSlots {
  const slots = selfSlots();
  const start = text.indexOf(RESEARCH_START), end = text.indexOf(RESEARCH_END);
  if (start < 0 || end < start) return slots;
  const block = text.slice(start, end);
  for (const role of RESEARCH_ROLES) {
    const spec = new RegExp(`<!-- ${RESEARCH_MARK[role]}: (\\S{1,400}) -->`).exec(block)?.[1];
    const c = parseSpec(spec);
    slots[role] = c?.mode === 'bb' ? stripParallel(c) : c ?? { mode: 'self' };
  }
  return slots;
}

// Panel reads, status refreshes and saves of one project write the same files; one at a time per folder,
// so a refresh started before a save never puts the old model back after it.
const queues = new Map<string, Promise<unknown>>();
export function serialByRoot<T>(root: string, job: () => Promise<T>): Promise<T> {
  const key = resolve(root); // `/repo` and `/repo/` are one folder
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

export function readDelegation(root: string): Promise<DelegationState> {
  return serialByRoot(root, () => readDelegationNow(root));
}

async function readDelegationNow(root: string): Promise<DelegationState> {
  let research = selfSlots();
  try { research = parseResearch(await readText(join(root, RESEARCH_PATH))); } catch { /* unreadable context: research stays self */ }
  const base = await readImplement(root);
  // Best effort: a folder that cannot be written (read-only checkout, permissions) still answers the read.
  // A parallel worker's copy is left alone: its patch must carry the worker's edits, not a refreshed block.
  if (!insideWorktrees(root)) await refreshBlocks(root, base.choice, research).catch(() => undefined);
  return { ...base, ...research };
}

/**
 * The managed blocks are text the agent follows, written when the owner saved the choice. After a plugin update
 * they would keep the old commands (for example `git apply --3way`) until the next save, so every read rewrites a
 * block that differs from what this version generates. Text outside the markers is never touched.
 */
async function refreshBlocks(root: string, choice: DelegationChoice, research: ResearchSlots) {
  if (choice.mode === 'bb') {
    await replaceBetweenMarkers(join(root, CONTEXT_PATH), contextBlock(choice), START, END, codeSettings);
    if (choice.parallel) await replaceBetweenMarkers(join(root, PLAN_CONTEXT_PATH), planRuleBlock(), PLAN_START, PLAN_END, () => '');
  }
  const researchText = researchBlock(research);
  if (researchText) await replaceBetweenMarkers(join(root, RESEARCH_PATH), researchText, RESEARCH_START, RESEARCH_END, researchSettings);
}

// The owner's settings a block carries, all of them (provider, model, reasoning, tier, parallel), as modelSpec writes them.
const codeSettings = (text: string) => /The project owner chose `([^`]*)`/.exec(text)?.[1] ?? '';
const researchSettings = (text: string) => (text.match(/<!-- research-model[\w-]*: [^>]* -->/g) ?? []).join('\n');

/**
 * Only the text between existing markers changes: a BOM, indentation and everything else of the owner stay byte for byte.
 * `settings` reads the owner's settings a block carries.
 */
async function replaceBetweenMarkers(file: string, block: string, start_: string, end_: string, settings: (text: string) => string) {
  const linked = (await lstat(file).catch(() => null))?.isSymbolicLink() ?? false;
  const text = await readText(file);
  const start = text.indexOf(start_);
  const end = text.indexOf(end_, start);
  if (start < 0 || end < 0) return;
  // A linked file may be shared by projects: a read never writes through the link. While its block carries this
  // project's settings the link stays, older wording and all; once its model, tier, reasoning or parallel mode differ,
  // this project gets its own file (writeAtomic replaces the link), so it never runs on settings it does not show.
  if (linked && settings(text.slice(start, end)) === settings(block)) return;
  // A file checked out with CRLF (core.autocrlf on Windows) gets the block in CRLF too, so git sees no change.
  const eol = text.slice(start, end).includes('\r\n') ? '\r\n' : '\n';
  const next = `${text.slice(0, start)}${start_}${eol}${block.trim().replace(/\r?\n/g, eol)}${eol}${text.slice(end)}`;
  if (next !== text) await writeAtomic(file, next);
}

async function readImplement(root: string): Promise<Omit<DelegationState, ResearchRole>> {
  let config: Json | null;
  try { config = await readConfig(root); } catch (e) {
    return { choice: { mode: 'self' }, configured: false, foreign: null, error: `Не читается .ai-factory.json: ${(e as Error).message.slice(0, 200)}` };
  }
  if (!config) return { choice: { mode: 'self' }, configured: false, foreign: null, error: null };
  const phase = isObject(config.phases) && isObject(config.phases.implement) ? config.phases.implement : null;
  if (!phase) return { choice: { mode: 'self' }, configured: true, foreign: null, error: null };
  if (phase.agent !== AGENT) return { choice: { mode: 'self' }, configured: true, foreign: String(phase.agent ?? 'unknown'), error: null };
  const choice = parseSpec(phase.model);
  return choice
    ? { choice, configured: true, foreign: null, error: null }
    : { choice: { mode: 'self' }, configured: true, foreign: null, error: `phases.implement.model не в формате provider/model?reasoning=…&tier=…: ${String(phase.model).slice(0, 100)}` };
}

// An owner's save writes this project's own file: renaming over a symbolic link replaces the link, so a file shared
// with other projects never takes this project's choice.
async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // A new file gets the umask's mode; an existing one keeps its own (a private 0600 file stays private).
  const mode = await stat(path).then(s => s.mode & 0o777, () => undefined);
  await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  if (mode !== undefined) await chmod(tmp, mode); // writeFile's mode is masked by the umask
  await rename(tmp, path);
}

/** Replace or remove the managed block; text outside the markers is the owner's. */
export function mergeContextBlock(existing: string, block: string | null, start_ = START, end_ = END): string {
  const start = existing.indexOf(start_);
  const end = existing.indexOf(end_);
  const outside = start >= 0 && end > start ? existing.slice(0, start) + existing.slice(end + end_.length) : existing;
  const rest = outside.replace(/\n{3,}/g, '\n\n').trim();
  if (!block) return rest ? rest + '\n' : '';
  return `${rest ? rest + '\n\n' : ''}${start_}\n${block.trim()}\n${end_}\n`;
}

// parseSpec lets ', ", $, ` and ; through the model id; the block embeds the
// values in shell commands, so every substitution is single-quoted.
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const spawnFlags = (c: Extract<DelegationChoice, { mode: 'bb' }>) => [
  `--provider ${shellQuote(c.providerId)}`,
  `--model ${shellQuote(c.model)}`,
  ...(c.reasoning ? [`--reasoning-level ${shellQuote(c.reasoning)}`] : []),
  // Always explicit, default too: without it BB starts the worker on the coordinator's tier (Fast included).
  `--service-tier ${shellQuote(c.tier || 'default')}`,
].join(' ');

type BbChoice = Extract<DelegationChoice, { mode: 'bb' }>;
const workerText: Record<ResearchRole, string> = {
  research: 'Research worker 1 — the first or only research subagent (in /aif-plan: architecture & affected modules)',
  research2: 'Research worker 2 — the second subagent (in /aif-plan: existing patterns & conventions)',
  research3: 'Research worker 3 — the third and any further subagents (in /aif-plan: dependencies & integration points)',
};

/** Managed block for the three research workers; null when every worker stays the agent's own subagent. Workers 2 and 3 fall back to worker 1. */
export function researchBlock(slots: ResearchSlots): string | null {
  const effective = (role: ResearchRole): DelegationChoice => slots[role].mode === 'bb' ? slots[role] : slots.research;
  if (!RESEARCH_ROLES.some(r => effective(r).mode === 'bb')) return null;
  const marks = RESEARCH_ROLES.flatMap(r => { const c = slots[r]; return c.mode === 'bb' ? [`<!-- ${RESEARCH_MARK[r]}: ${modelSpec(c)} -->`] : []; });
  const lines = RESEARCH_ROLES.map(r => { const c = effective(r);
    return `- ${workerText[r]}: ${c.mode === 'bb' ? `\`${modelSpec(c)}\` → spawn flags \`${spawnFlags(c as BbChoice)}\`` : 'your own native subagent, exactly as the skill says'}`; });
  return `${marks.join('\n')}
## Research delegation (managed by BB AIF Helper)

The project owner chose models (BB provider/model?reasoning&tier) for research subagents. Whenever an AI Factory skill tells you to launch exploration or research subagents — for example \`Task(subagent_type: Explore, …)\` in /aif-plan, /aif-fix or /aif-qa — or you would use your own native subagents for read-only codebase research, number them in the order the skill lists them and run each one as assigned below. Ignore any model the skill names for those subagents.

${lines.join('\n')}

For each worker on a BB model:

1. Write its research prompt to its own temporary file. It starts with these rules (replace \`<thread-id>\` with your own \`BB_THREAD_ID\`), then gives the exact question, the paths to look at and the thoroughness the skill asked for:

\`\`\`
You are a read-only research worker for an AI Factory skill run by BB thread <thread-id>.
Investigate the current workspace and answer the question below. Do not create, edit or delete files, do not commit, and do not start AI Factory skills.
Finish with a concise structured report: the relevant files and symbols with paths, the patterns and integration points you found, and open questions. No full file contents.
\`\`\`

Write each prompt file in UTF-8 whose name has only letters, digits, \`-\`, \`_\` and \`.\`, in a folder whose path has no \`'\`: the path goes inside single quotes, which keep \`$\`, spaces and \`\\\` as they are in bash and PowerShell alike (in Windows PowerShell 5.1 use \`Set-Content -Encoding utf8\`, not \`Out-File\` or \`>\`).

2. Spawn all research workers at once — they only read, so they may run in parallel — with that worker's spawn flags, and take each thread id from the JSON answer:

\`\`\`bash
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off <spawn flags> --title 'AIF research · <skill> · <topic>' --prompt-file '<prompt>' --json
\`\`\`

3. Wait for each: Wait with \`bb plugin run aif-chat wait-worker --worker <id> --json\`, then call it again with \`--after <seq>\` from its previous answer: it answers within two minutes with \`state\`, \`seq\`, \`quietForMs\` (time since the worker's last event) and \`output\` (the worker's latest report) and sees everything that happened between two calls. \`working\`: call again. \`idle\`: a complete final report in the form its brief asks for means done; an empty or interim one (\"waiting for the tests\") means it still works in the background (some agents pause while a command runs and resume by themselves), so call again. Whatever the state, once \`quietForMs\` passes 480000 and the worker is not done (\`working\`, or \`idle\` with such a report), send it nothing and ask the owner whether to keep waiting, restart the task or do it yourself; a worker waiting for an approval shows up this way too. \`stopped\`: someone stopped it; ask the owner. \`failed\`: its run failed; handle it as a BB failure. Before you restart a task or do it yourself, run \`bb thread stop <id>\` and archive the old worker, so it never writes into the files later.
4. Use the reports exactly as the skill uses its subagent results and continue the skill. Its rules on artifacts, questions and approvals do not change.

If \`bb thread spawn\` fails, say so and do that research yourself; do not repeat the same error. Use no \`node\` commands in this flow. In PowerShell the BB variables are \`$env:BB_PROJECT_ID\`, \`$env:BB_THREAD_ID\` and \`$env:BB_ENVIRONMENT_ID\`, not \`$BB_PROJECT_ID\`.`;
}

// Workers check only their own files; the full suite runs once at the coordinator (thr_ds3i5seh7r: three workers ran it in parallel).
const WORKER_CHECKS = 'Run only narrow checks: the typecheck and the tests of the files you changed, or the narrow tests the task names. Do not run the full test suite, the project\'s full check script or a push gate, even when the task names them: the coordinator runs them once; write "full suite: coordinator" in the report.';

function parallelSection(n: number): string {
  return `## Parallel mode (managed by BB AIF Helper)

The owner allowed up to ${n} workers at once. You run the plan as AI Factory's \`implement-coordinator\` does: you read the plan and decide what runs in parallel; BB threads with the owner's model are your workers, each in its own git worktree copy of the project. The plugin commands below do the copy, launch and transfer steps, so no path or JSON passes through your shell. This applies to an ordinary plan or an ultra bundle (\`index.md\` holds the checkboxes); a fix plan or OpenSpec change uses the one-worker flow above.

Every worker's copy already holds all your uncommitted work, so the results of earlier tasks need no commit, branch or worktree of yours. Re-read this section before each layer: after a context compaction your summary of it is not enough.

### Layers

1. Read the whole plan. Open tasks are \`[ ]\` and \`[~]\` (an interrupted run left it in progress: redo it); \`[!]\` failed earlier and counts as not done. For each task take its number, phase (\`### Phase N\`) and its dependencies in whatever form the plan writes them (\`(depends on X, Y)\`, \`Depends on X\`, a dependency line under the task); when you are unsure whether one task needs another, treat it as dependent. Tasks of the same phase without explicit dependencies are independent; a later phase depends on every earlier phase unless its tasks say otherwise. Keep apart, in different layers, tasks you can see will change the same file (from their \`Files:\` hints or text). Commit tasks (\`<!-- aif:task-kind:commit -->\`), commit checkpoints from \`## Commit Plan\`, and push or deploy steps are yours alone: never give them to a worker.
2. Before the first worker, write \`<!-- parallel: tasks N, M -->\` on its own line above each group of independent tasks in the plan, once.
3. The layer loop. \`ready\` = open tasks whose dependencies are all done. If none is ready while tasks remain, stop and report the circular or missing dependency. Check each ready task against the requirements as the skill's requirement-consistency step says. One ready task: the one-worker flow. Several: up to ${n} per layer, the rest in the next batch.
4. Mark the layer's tasks \`- [~] Task N: … <!-- in-progress -->\` in the plan, then run the steps below. A task is \`[x]\` only after its changes are brought back and verified; then remove the \`in-progress\` comment.

### One layer

1. For each task write its brief to a temporary file in UTF-8 whose name has only letters, digits, \`-\`, \`_\` and \`.\`, in a folder whose path has no \`'\`: the path goes inside single quotes, which keep \`$\`, spaces and \`\\\` as they are in bash and PowerShell alike. It starts with the worker contract below, then the plan path, the task number and full text (for an ultra bundle the whole \`## Task N\` section of its phase file), the relevant files and project rules, the verification commands and what done means. Start the worker: \`bb plugin run aif-chat spawn-worker --target <plan name> --task <task number, e.g. 3 or 1.2> --brief '<absolute brief path>' --json\` → \`{ id }\`. \`<plan name>\` is only a label for the worker's title: the plan's file name without \`.md\`, with every character other than Latin letters, digits, \`-\`, \`_\` and \`.\` replaced by \`-\` and leading \`-\` and \`.\` dropped (\`plan\` if nothing is left), so it needs no quotes and is never read as an option. The plugin starts it with the owner's model on a fresh copy of this workspace, as a child of this chat: the last commit plus your uncommitted work (changed, new and deleted files, not ignored ones), so it sees the results of earlier tasks without any commit. The copy holds the files git tracks (a force-added one too) and your new files that git does not ignore (\`.gitignore\`, \`.git/info/exclude\` and global excludes all count). Untracked ignored files (\`node_modules\`, build output, a local \`.env\`, \`.bb/\` when the project ignores it) and anything outside the repository are not there: if the task needs such a file as input, give its absolute path in your workspace in the brief. Submodules are not checked out in the copy, and \`spawn-worker\` refuses while you have uncommitted changes inside one (it names the submodule): a task that changes a submodule's files or needs their uncommitted state, do yourself. A folder inside a larger repository works too. Every launch gets its own copy.
2. Wait for every worker: Wait with \`bb plugin run aif-chat wait-worker --worker <id> --json\`, then call it again with \`--after <seq>\` from its previous answer: it answers within two minutes with \`state\`, \`seq\`, \`quietForMs\` (time since the worker's last event) and \`output\` (the worker's latest report) and sees everything that happened between two calls. \`working\`: call again. \`idle\`: a complete final report in the form its brief asks for means done; an empty or interim one (\"waiting for the tests\") means it still works in the background (some agents pause while a command runs and resume by themselves), so call again. Whatever the state, once \`quietForMs\` passes 480000 and the worker is not done (\`working\`, or \`idle\` with such a report), send it nothing and ask the owner whether to keep waiting, restart the task or do it yourself; a worker waiting for an approval shows up this way too. \`stopped\`: someone stopped it; ask the owner. \`failed\`: its run failed; handle it as a BB failure. Before you restart a task or do it yourself, run \`bb thread stop <id>\` and archive the old worker, so it never writes into the files later.
3. Bring the results back one worker at a time: \`bb plugin run aif-chat bring-back --worker <id> --json\`. It moves everything the worker changed (new, changed, renamed and deleted files; ignored files stay out) into this workspace. Answers:
   - \`{ applied: true, files }\`: compare \`files\` with the worker's report and the task, review the diff and run the task's narrow checks.
   - \`{ applied: false, empty: true }\`: the worker changed nothing. That is right for a task that only checks something, or one whose changes are already in this workspace (a resumed task brought back earlier): it is done when its narrow checks pass here and its full ones pass in the layer check (step 4), which runs them once. Otherwise the task is not done.
   - \`{ applied: false, error }\`: the changes do not fit, and nothing was changed; the results of earlier tasks are intact. Do not run \`git apply\`, \`git checkout\`, \`git reset\` or \`git stash\` yourself: there is nothing to undo. Usually another task of the layer changed the same lines (see Failures). If writing failed half way (a locked or read-only file), the plugin put back what it wrote; once the cause is fixed, run the same \`bring-back\` again.
   - \`{ applied: false, partial: true, files, error }\`: those files could not be put back. Stop and report them to the owner.
   \`bring-back\` takes only what changed since the worker's last bring-back, so a worker asked to fix its work is brought back again with just the fix.
4. After the whole layer is back, run once for the whole layer every check its tasks name that the workers skipped: the build, the full test suite, the project's full check script (if one was red before, compare it with one baseline taken before the layer, not one per task); a task is verified only when its named checks pass. Then archive the layer's workers (\`bb thread archive <id>\`; BB removes its copy five minutes later). Then continue with the next layer.

### Commits

You alone commit, exactly where the plan says (its commit tasks, its \`## Commit Plan\`, the final commit of \`single-commit\`), with the plan's message, through the skill's own commit flow (commit-task handler and receipts, as without workers); you never push without the owner. Parallel layers need no commits of their own: every copy starts from your current workspace.

### The worker contract — the mandatory start of every brief (replace \`<thread-id>\` with your own \`BB_THREAD_ID\`)

\`\`\`
You are an implement-worker of an AI Factory /aif-implement coordinator (BB thread <thread-id>).
Do exactly the one task below in the current workspace, then stop. Do not edit the plan or phase files or their checkboxes, do not commit, push or switch branches, do not start AI Factory skills or other agents. This workspace is your own copy of the repository. Change files only inside it (folders above the current one included); a path outside it is input you read and never change. Untracked ignored files (dependencies, build output) stay in the copy and never reach the coordinator: install dependencies here if the checks need them. Do not change or add files inside a git submodule: it is another repository, its changes do not come back and the coordinator's transfer refuses them; say in the report what it needs. Use no git command that changes the index or history (add, rm, mv, stash, reset, checkout, restore).
If the task contradicts the plan, the requirements or the code, change nothing and answer "handoff_outcome: blocked_external" with the conflict.
${WORKER_CHECKS} Review your own diff once and fix what you find.
Finish with a report: what changed; the list of files you modified; the checks you ran with their results; warnings and anything left open.
\`\`\`

### Failures

Find the cause before you act; never repeat the same step unchanged.
- A check failed or the work has a gap: fix a small one yourself, or write the exact error to a temporary UTF-8 file whose name has only letters, digits, \`-\`, \`_\` and \`.\`, in a folder whose path has no \`'\` and send it with \`bb thread tell <id> --message-file '<file>'\` (the error itself never goes on the command line: an apostrophe or \`$\` in it breaks the shell), wait, and bring the worker back again.
- Two workers changed the same lines (\`bring-back\` error): keep what is already back, then redo that task after the layer with a fresh worker, whose copy then holds the other task's changes.
- BB failed (\`spawn-worker\` error, a host that is not connected, \`wait-worker\` answering \`failed\`): retry once, then do that task yourself with the one-worker flow. A \`stopped\` worker is not a failure: someone stopped it, so ask the owner.
- A task fails for the same cause three times: mark it \`- [!] Task N: … <!-- failed: <reason> -->\`, finish the tasks that do not depend on it, and ask the owner, naming the cause and the assumption you doubt.
- Stop and ask the owner at once when a worker answers \`blocked_external\` or the requirements conflict, when a worker changed files outside its task that other tasks also change, or when a step needs secrets, a production server or deleting data.

Update the plan right before and after each layer, so another session can continue. For an ultra bundle edit only \`index.md\`. When the plan is done, report \`Status: complete\`, \`partial\`, \`failed\` or \`blocked_external\`, and continue as the skill says (verification, commit).`;
}

export function planRuleBlock(): string {
  return `## Task hints for parallel execution (managed by BB AIF Helper)

The project runs independent plan tasks in parallel. Keep AI Factory's task format and make it complete:
- end each task line with \`(depends on 1, 2)\` when it needs earlier tasks; tasks of one phase without it run side by side;
- give every task a \`Files:\` hint with the files it creates or changes;
- tasks that change the same file depend on each other or are merged into one; commit and deploy tasks stay last.`;
}

export function contextBlock(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const flags = spawnFlags(c);
  const base = `## Code delegation (managed by BB AIF Helper)

The project owner chose \`${modelSpec(c)}\` (BB provider/model?reasoning&tier) to write the code of plan tasks. The source of truth is \`.ai-factory.json\` → \`phases.implement\`; re-read it before each task. If it no longer has \`"agent": "bb"\`, implement tasks yourself as usual.

You stay the coordinator: you own the plan, its checkboxes, verification and commits. Plan tasks run only on BB workers started by the commands below — never your own subagents (the Task or Agent tool, \`implement-worker\` or \`implement-coordinator\`), your own git worktrees or a branch built with \`commit-tree\`, even when AI Factory's skill or agent files suggest them or a BB step looks broken: then follow the failure rule at the end. Re-read this block before each task: after a context compaction your summary of it is not enough.

For each plan task, instead of editing the code yourself:

1. Write the task brief to a temporary file in UTF-8 whose name has only letters, digits, \`-\`, \`_\` and \`.\`, in a folder whose path has no \`'\` (the path goes inside single quotes, which keep \`$\`, spaces and \`\\\` as they are; in Windows PowerShell 5.1 \`Out-File\` and \`>\` write UTF-16: use \`Set-Content -Encoding utf8\` there). It starts with the worker rules below, then gives the plan path, the task id and its full text, the relevant files and project rules, the verification commands, and what done means for this task.

The worker rules — the mandatory start of every brief (replace \`<thread-id>\` with your own \`BB_THREAD_ID\`):

\`\`\`
You are an implementation worker delegated by an AI Factory /aif-implement coordinator (BB thread <thread-id>).
Do exactly the one task below in the current workspace. Do not edit the plan file or its checkboxes, do not commit, push or switch branches, and do not start AI Factory skills.
${WORKER_CHECKS} Finish with a short report: what changed, the files you touched, the checks you ran with their results, and anything left open.
\`\`\`

2. Deduplicate: run \`bb thread list --parent-thread "$BB_THREAD_ID" --json\`. If a non-archived thread has \`title\` = \`AIF · <plan> · <taskId>\`, take its id and go to step 4.
3. Spawn the worker and take the thread id from the JSON answer:

\`\`\`bash
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off ${flags} --title 'AIF · <plan> · <taskId>' --prompt-file '<brief>' --json
\`\`\`

4. Wait: Wait with \`bb plugin run aif-chat wait-worker --worker <id> --json\`, then call it again with \`--after <seq>\` from its previous answer: it answers within two minutes with \`state\`, \`seq\`, \`quietForMs\` (time since the worker's last event) and \`output\` (the worker's latest report) and sees everything that happened between two calls. \`working\`: call again. \`idle\`: a complete final report in the form its brief asks for means done; an empty or interim one (\"waiting for the tests\") means it still works in the background (some agents pause while a command runs and resume by themselves), so call again. Whatever the state, once \`quietForMs\` passes 480000 and the worker is not done (\`working\`, or \`idle\` with such a report), send it nothing and ask the owner whether to keep waiting, restart the task or do it yourself; a worker waiting for an approval shows up this way too. \`stopped\`: someone stopped it; ask the owner. \`failed\`: its run failed; handle it as a BB failure. Before you restart a task or do it yourself, run \`bb thread stop <id>\` and archive the old worker, so it never writes into the files later.
5. Review \`git diff\` and run the task's verification yourself (the full suite too when the task names it). Fix a small gap yourself, or write what to fix to a temporary UTF-8 file whose name has only letters, digits, \`-\`, \`_\` and \`.\`, in a folder whose path has no \`'\` and send \`bb thread tell <id> --message-file '<file>'\` (the text itself never goes on the command line: an apostrophe or \`$\` in it breaks the shell), then wait again (step 4).
6. Only after that mark the task done in the plan and move to the next task. One worker at a time: workers share this workspace.

If \`bb thread spawn\` returns an error, report it and implement that task yourself; do not repeat the same error. Use no \`node\` commands in this flow. In PowerShell the BB variables are \`$env:BB_PROJECT_ID\`, \`$env:BB_THREAD_ID\` and \`$env:BB_ENVIRONMENT_ID\`, not \`$BB_PROJECT_ID\`.`;
  if (!c.parallel) return base;
  return base.replace('One worker at a time: workers share this workspace.', 'Outside parallel groups (below), run one worker at a time: workers in this workspace share it.') + '\n\n' + parallelSection(c.parallel);
}

export function writeDelegation(root: string, choice: DelegationChoice, role: DelegationRole = 'implement'): Promise<DelegationState> {
  return serialByRoot(root, () => writeDelegationNow(root, choice, role));
}

async function writeDelegationNow(root: string, choice: DelegationChoice, role: DelegationRole): Promise<DelegationState> {
  const config = await readConfig(root);
  if (!config) throw new Error('В проекте нет .ai-factory.json: сначала установите AI Factory.');
  if (role !== 'implement') {
    const file = join(root, RESEARCH_PATH);
    const text = await readText(file);
    const picked = choice.mode === 'bb' ? stripParallel(choice) : choice;
    const next = mergeContextBlock(text, researchBlock({ ...parseResearch(text), [role]: picked }), RESEARCH_START, RESEARCH_END);
    if (next) await writeAtomic(file, next); else await rm(file, { force: true });
    return readDelegationNow(root);
  }
  const phases: Json = isObject(config.phases) ? { ...config.phases } : {};
  const agents: Json = isObject(config.dispatchAgents) ? { ...config.dispatchAgents } : {};
  const current = isObject(phases.implement) ? phases.implement : null;
  if (current && current.agent !== AGENT) throw new Error(`phases.implement уже настроен на агента «${String(current.agent)}». Измените его вручную в .ai-factory.json.`);
  if (choice.mode === 'bb') phases.implement = { agent: AGENT, model: modelSpec(choice), timeoutMs: TIMEOUT_MS };
  else delete phases.implement;
  // The runner script and its dispatchAgents entry belonged to the previous
  // delegation scheme; `dispatch` stays only while other phases may use it.
  delete agents[AGENT];
  if (Object.keys(phases).length) config.phases = phases; else delete config.phases;
  if (Object.keys(agents).length) config.dispatchAgents = agents; else delete config.dispatchAgents;
  if (!Object.keys(phases).some((key) => key !== 'implement')) delete config.dispatch;
  const contextFile = join(root, CONTEXT_PATH);
  let context = '';
  try { context = await readFile(contextFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const nextContext = mergeContextBlock(context, choice.mode === 'bb' ? contextBlock(choice) : null);
  if (nextContext) await writeAtomic(contextFile, nextContext); else await rm(contextFile, { force: true });
  const planFile = join(root, PLAN_CONTEXT_PATH);
  const planText = await readText(planFile);
  const nextPlan = mergeContextBlock(planText, choice.mode === 'bb' && choice.parallel ? planRuleBlock() : null, PLAN_START, PLAN_END);
  if (nextPlan) await writeAtomic(planFile, nextPlan); else await rm(planFile, { force: true });
  let removedLegacy = false;
  try { await rm(join(root, '.ai-factory/bin/bb-aif-run.mjs')); removedLegacy = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await writeAtomic(join(root, '.ai-factory.json'), JSON.stringify(config, null, 2) + '\n');
  const state = await readDelegationNow(root);
  return removedLegacy ? { ...state, removedLegacy } : state;
}
