import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { checkCommandGates } from './check-actions.ts';
import { parseReplyGate } from './gate.ts';
import type { GateResult, Snapshot } from './model.ts';

export type ChatCheck = { seq: number; at: string; target: string; result: GateResult; inputFingerprint?: string; observedAt?: string };
export type HistoryRow = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^@/, '').replace(/^\.\//, '');

// Scope comes from a canonical path or an explicit check command naming an OpenSpec change.
export function readChatChecks(rows: HistoryRow[], candidates: Pick<Snapshot['candidates'][number], 'path' | 'kind'>[]): ChatCheck[] {
  const plans = candidates.map(candidate => ({ path: normalize(candidate.path), kind: candidate.kind }));
  const paths = plans.map(plan => plan.path);
  const mentioned = (text: string) => {
    const tokens = new Set((text.match(/(?:\.?[\w.-]+\/)+[\w.-]+/g) ?? []).map(normalize));
    return paths.filter(path => tokens.has(path));
  };
  let requested: string[] = [];
  let changeRequest: { gate: GateResult['gate']; paths: string[] } | undefined;
  const results: ChatCheck[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === 'client/turn/requested') {
      const text = row.data.input.filter(i => i.type === 'text').map(i => i.text).join('\n');
      requested = mentioned(text);
      const command = /^[ \t]*[/$](aif(?:-[a-z0-9]+)*)[ \t]+(["']?)([\w-]+)\2[ \t]*(?:\r?\n|$)/.exec(text);
      const gate = command && checkCommandGates[command[1]];
      changeRequest = command && gate ? { gate, paths: plans.filter(plan => plan.kind === 'openspec'
        && plan.path.endsWith(`/${command[3]}/tasks.md`)).map(plan => plan.path) } : undefined;
    } else if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) {
      const { gate, error } = parseReplyGate(row.data.item.text);
      if (!gate || error) continue;
      const direct = gate.affected_files.map(normalize).filter(file => paths.includes(file));
      // An explicitly different plan must not inherit the preceding launch's scope.
      if (!direct.length && gate.affected_files.some(file => /(?:^|\/)\.ai-factory\/plans\/.*\.md$|(?:^|\/)openspec\/changes\/.*\/(?:tasks|proposal)\.md$/.test(normalize(file)))) continue;
      const targets = direct.length ? direct : [...new Set([...requested, ...(changeRequest?.gate === gate.gate ? changeRequest.paths : [])])];
      if (targets.length !== 1) continue;
      results.push({ seq: row.seq, at: new Date(row.createdAt).toISOString(), target: targets[0], result: gate });
    }
  }
  return results;
}

export function attachChatChecks(snapshot: Snapshot, records: ChatCheck[]) {
  if (!snapshot.target) return;
  for (const check of snapshot.checks) {
    const record = records.filter(r => r.target === normalize(snapshot.target!.path) && r.result.gate === check.id)
      .sort((a, b) => b.seq - a.seq)[0];
    if (record) check.chat = { ...record, freshness: record.inputFingerprint && snapshot.inputsFingerprint
      ? record.inputFingerprint === snapshot.inputsFingerprint ? 'unchanged' : 'changed' : 'unknown' };
  }
}
