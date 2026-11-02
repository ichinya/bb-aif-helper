import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { parseReplyGate } from './gate.ts';
import type { GateResult, Snapshot } from './model.ts';

export type ChatCheck = { seq: number; at: string; target: string; result: GateResult };
export type HistoryRow = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^@/, '').replace(/^\.\//, '');

// Only explicit canonical entrypoints associate a result with a plan. A selected
// tab, phase declaration, prose PASS or a command mention cannot establish it.
export function readChatChecks(rows: HistoryRow[], candidates: string[]): ChatCheck[] {
  const paths = candidates.map(normalize);
  const mentioned = (text: string) => {
    const tokens = text.match(/(?:\.?[\w.-]+\/)+[\w.-]+/g) ?? [];
    return paths.filter(path => tokens.map(normalize).includes(path));
  };
  let requested: string[] = [];
  const results: ChatCheck[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === 'client/turn/requested') {
      requested = mentioned(row.data.input.filter(i => i.type === 'text').map(i => i.text).join('\n'));
    } else if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) {
      const { gate, error } = parseReplyGate(row.data.item.text);
      if (!gate || error) continue;
      const direct = gate.affected_files.map(normalize).filter(file => paths.includes(file));
      // An explicitly different plan must not inherit the preceding launch's scope.
      if (!direct.length && gate.affected_files.some(file => /(?:^|\/)\.ai-factory\/plans\/.*\.md$|(?:^|\/)openspec\/changes\/.*\/(?:tasks|proposal)\.md$/.test(normalize(file)))) continue;
      const targets = direct.length ? direct : requested;
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
    if (record) check.chat = { ...record, freshness: 'unknown' };
  }
}
