import { gateResultSchema, type GateResult } from './model.ts';

const allowed: Record<GateResult['gate'], readonly string[]> = {
  verify: ['/aif-fix', '/aif-rules', '/aif-architecture', '/aif-roadmap', '/aif-commit', '/aif-verify'],
  review: ['/aif-fix', '/aif-rules', '/aif-architecture', '/aif-roadmap', '/aif-commit', '/aif-review'],
  security: ['/aif-fix', '/aif-security-checklist'],
  rules: ['/aif-rules', '/aif-fix', '/aif-rules-check', '/aif-mode'],
};
export const blockedByGate = (id: string, gate: GateResult | null) => !!gate?.blocking
  && ['aif-commit', 'aif-done', 'aif-archive', 'aif-implement'].includes(id);

/** Parse the last real, terminal gate fence. Quoted/nested examples are not results. */
export function parseReplyGate(text: string): { gate: GateResult | null; error: string | null; prose: string } {
  const lines = text.slice(0, 1024 * 1024).split(/\r?\n/);
  const prose: string[] = [];
  let fence: { char: string; size: number; gate: boolean } | null = null;
  let last: { body: string[]; end: number; closed: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) {
        if (fence.gate) { last!.closed = true; last!.end = i; }
        else prose.push(line);
        fence = null;
      } else if (fence.gate) last!.body.push(line);
      else prose.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (open) {
      const isGate = open[1] === '```' && open[2].trim() === 'aif-gate-result';
      fence = { char: open[1][0], size: open[1].length, gate: isGate };
      if (isGate) last = { body: [], end: -1, closed: false };
      else prose.push(line);
    } else prose.push(line);
  }
  const result = (gate: GateResult | null, error: string | null) => ({ gate, error, prose: prose.join('\n') });
  if (!last) return result(null, null);
  if (text.length > 1024 * 1024) return result(null, 'Ответ с gate превышает лимит 1 MiB.');
  if (!last.closed) return result(null, 'Последний блок aif-gate-result не закрыт.');
  let value: unknown;
  try { value = JSON.parse(last.body.join('\n')); }
  catch { return result(null, 'Последний блок aif-gate-result содержит некорректный JSON.'); }
  const parsed = gateResultSchema.safeParse(value);
  if (!parsed.success) return result(null, 'Gate не соответствует схеме v1: проверьте gate, status, blockers и suggested_next.');
  const gate = parsed.data;
  if (lines.slice(last.end + 1).join('\n').trim()) return result(gate, 'Gate должен быть завершающим блоком ответа; текст после него не считается handoff.');
  if (gate.blocking !== (gate.status === 'fail') || (gate.status === 'fail' ? !gate.blockers.length : !!gate.blockers.length)) {
    return result(gate, 'Противоречивые status, blocking и blockers. Следующий шаг не подтверждён.');
  }
  if (gate.status === 'pass' && gate.suggested_next?.command != null) return result(gate, 'При PASS suggested_next.command должен быть null; следующий шаг указывается в тексте ответа.');
  const next = gate.suggested_next?.command;
  if (next && (!allowed[gate.gate].includes(next) || blockedByGate(next.slice(1), gate))) {
    return result(gate, 'suggested_next.command недопустим для этого gate или обходит блокирующие проблемы.');
  }
  return result(gate, null);
}
