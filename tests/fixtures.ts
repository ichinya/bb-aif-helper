import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotSchema, type Snapshot } from '../model.ts';
export const skills = ['aif', 'aif-plan', 'aif-explore', 'aif-improve', 'aif-implement', 'aif-verify', 'aif-fix', 'aif-done', 'aif-rules-check', 'aif-security-checklist', 'aif-review', 'aif-qa', 'aif-qa-check', 'aif-quality-setup', 'aif-ci', 'aif-mode', 'aif-commit'];
export function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return snapshotSchema.parse({ schemaVersion: 'aif-chat/v1', collectedAt: '2026-11-02T00:00:00Z', fingerprint: 'a'.repeat(64), root: '/project', runtime: 'codex-app', configured: true,
    profile: 'upstream', phase: 'plan', phaseSource: 'declared', threadState: 'idle', pendingQuestions: 0,
    versions: { globalCli: '2.19.0', globalSource: null, installed: '2.12.0', sourceVersion: '2.21.0', sourceWorktreeVersion: '2.21.0', sourceSha: 'b'.repeat(40), sourceDirty: false },
    upstream: { version: null, ref: null, sha: null, checkedAt: null, error: null }, extensions: [], skills,
    candidates: [{ path: '.ai-factory/plans/demo.md', title: 'demo', kind: 'full' }],
    target: { path: '.ai-factory/plans/demo.md', title: 'Demo', id: 'demo', kind: 'full', tasks: [{ id: '1', title: '1. Implement', done: false }] },
    checks: [], actions: [], diagnostics: [], ...patch });
}
export async function fixture(hub = false, native = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-chat-test-'));
  async function write(rel: string, content: string | object) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  await write('.ai-factory.json', { version: '2.21.0', agents: [{ id: 'codex-app', skillsDir: '.agents/skills', installedSkills: skills }],
    extensions: hub ? [{ name: 'aifhub-extension', version: '1.8.1', source: 'https://user:secret@example.org/ext.git?token=private' }] : [] });
  for (const s of skills) await write(`.agents/skills/${s}/SKILL.md`, `---\nname: ${s}\n---\nSkill fixture`);
  if (hub) await write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '1.8.1', injections: [{ target: 'aif-plan' }] });
  await write('.ai-factory/config.yaml', native ? 'aifhub:\n  tools:\n    openspec: true\n' : 'language:\n  ui: ru\n');
  return { root, write, async cleanup() {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aif-chat-test-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(resolved, { recursive: true, force: true });
  } };
}
