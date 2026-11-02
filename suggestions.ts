// Suggest command names only: surrounding prose and shell/skill arguments are
// never promoted into an executable request. A click still requires server checks.
import { parseReplyGate } from './gate.ts';

export function extractAifCommands(text: string): string[] {
  const result: string[] = [];
  for (const match of text.slice(0, 1024 * 1024).matchAll(/(?<![\w$\\/.-])\$(aif(?:-[a-z0-9]+)*)(?![\w/-])/g)) {
    const name = match[1];
    if (name.length <= 100 && !result.includes(name)) result.push(name);
    if (result.length === 12) break;
  }
  return result;
}
export function analyzeReply(text: string) {
  const parsed = parseReplyGate(text);
  const next = !parsed.error ? parsed.gate?.suggested_next?.command?.slice(1) : null;
  const ids = [...new Set([...(next ? [next] : []), ...extractAifCommands(parsed.prose)])].slice(0, 12);
  return { ...parsed, ids, next };
}
