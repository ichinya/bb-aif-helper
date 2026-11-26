// These are literal agent messages, never shell commands. Markdown delimiters
// and subsequent commands/shell statements do not belong to the invocation.
import { parseReplyGate } from './gate.ts';
import { briefCommands } from './session-brief.ts';
import { gateEvidenceCommands } from './gate-evidence-command.ts';
import { confirmationProse } from './confirmation.ts';
import { PLUGIN_SKILLS, type Action, type Suggestions } from './model.ts';

function argumentsAfter(tail: string, code: boolean): string | null {
  const tokens: string[] = [];
  let offset = 0;
  while (/^[ \t]/.test(tail.slice(offset, offset + 1))) {
    while (/[ \t]/.test(tail[offset] ?? '') && offset < tail.length) offset++;
    const start = offset;
    if (!tail[offset] || /[\r\n`;,|&<>\x00-\x1f]/.test(tail[offset]) || /^[/$]aif\b/.test(tail.slice(offset))) break;
    let quote = '';
    while (offset < tail.length) {
      const char = tail[offset];
      if (/[\r\n]/.test(char)) { if (quote) return null; break; }
      if (/[\x00-\x08\x0b-\x1f]/.test(char) || offset > 4000) return null;
      if (quote) {
        if (char === '\\' && tail[offset + 1] === quote) { offset += 2; continue; }
        if (char === quote) quote = '';
      } else {
        if (char === '"' || char === "'") quote = char;
        else if (/[ \t`;,|&<>]/.test(char) || (char === '$' && tail[offset + 1] === '(')) break;
      }
      offset++;
    }
    if (quote) return null; // Never silently drop an incomplete scoped argument.
    const raw = tail.slice(start, offset);
    const token = code ? raw : raw.replace(/[.,:!?\)\]\}]+$/, '');
    if (!token || !code && /^(?:затем|потом|далее|then|and|или|и)$/i.test(token)) break;
    tokens.push(token);
    if (offset === start || tail.slice(start, offset) !== token) break;
  }
  return tokens.length ? ' ' + tokens.join(' ') : '';
}

// Prefix-free skill names are invocations only at the start of complete code
// spans or code lines. Ordinary prose, paths and partial fences are not commands.
function readCodeItems<T>(text: string, parse: (body: string, index: number) => T | null): T[] {
  const result: T[] = [];
  const add = (body: string, index: number, into = result) => {
    const item = parse(body, index);
    if (item !== null) into.push(item);
  };
  let fence: { char: string; size: number; items: typeof result } | null = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const value = line.replace(/\r?\n$/, '');
    const delimiter = value.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.char && delimiter[1].length >= fence.size && !delimiter[2].trim()) {
        for (const item of fence.items) result.push(item);
        fence = null;
      } else add(value, offset, fence.items);
    } else if (delimiter) {
      fence = { char: delimiter[1][0], size: delimiter[1].length, items: [] };
    } else {
      for (const match of value.matchAll(/(?<!`)(`+)(?!`)([^\r\n]+?)\1(?!`)/g)) {
        add(match[2], offset + match.index!);
      }
    }
    offset += line.length;
  }
  return result;
}

export function rulesSyncCommand(text: string, change: string): string | undefined {
  const bounded = text.slice(0, 1024 * 1024);
  const prose = confirmationProse(bounded.replace(/(`+)stale-generated-rules\1/gi, 'stale-generated-rules'));
  if (!/\bstale-generated-rules\b/.test(prose)) return;
  const commands = readCodeItems(bounded, body => {
    const command = body.trim();
    const match = command.match(/^ai-factory[ \t]+aifhub-mode[ \t]+sync[ \t]+--change[ \t]+(?:"([a-z0-9][a-z0-9._-]{0,199})"|'([a-z0-9][a-z0-9._-]{0,199})'|([a-z0-9][a-z0-9._-]{0,199}))[ \t]+--json$/);
    return match ? { command, change: match[1] ?? match[2] ?? match[3] } : null;
  });
  if (commands.every(item => item.change === change)) return commands[0]?.command;
}

export function extractAifInvocations(text: string): { id: string; command: string }[] {
  const result: { id: string; command: string }[] = [];
  const bounded = text.slice(0, 1024 * 1024);
  const matches = [...bounded.matchAll(/(?<![\w$\\/.-])[/$](aif(?:-[a-z0-9]+)*)(?![\w/-])/g)].map(match => ({
    name: match[1], tail: bounded.slice(match.index! + match[0].length), index: match.index!, code: bounded[match.index! - 1] === '`',
  }));
  const bare = readCodeItems(bounded, (body, index) => {
    const match = body.match(/^[ \t]*(aif(?:-[a-z0-9]+)*)(?=$|[ \t])/);
    return match ? { name: match[1], tail: body.slice(match[0].length), index, code: true } : null;
  });
  for (const { name, tail, code } of matches.concat(bare).sort((a, b) => a.index - b.index)) {
    const args = argumentsAfter(tail, code);
    if (args === null) continue;
    const command = name + args;
    const existing = result.find(item => item.id === name);
    if (existing && existing.command === name && args) existing.command = command;
    else if (name.length <= 100 && !existing) result.push({ id: name, command });
    if (result.length === 12) break;
  }
  return result;
}
export function extractAifCommands(text: string): string[] {
  return extractAifInvocations(text).map(item => item.id);
}
export function analyzeReply(text: string) {
  const parsed = parseReplyGate(text);
  const next = !parsed.error ? parsed.gate?.suggested_next?.command?.slice(1) : null;
  const evidenceCommands = gateEvidenceCommands(parsed.prose);
  const invocations = [...evidenceCommands, ...extractAifInvocations(parsed.prose), ...briefCommands(parsed.prose)];
  const commands = new Map(invocations.map(item => [item.id, item.command]));
  for (const item of evidenceCommands) commands.set(item.id, item.command);
  if (next) commands.set(next, next); // Gate's allowlist remains authoritative.
  const ids = [...new Set([...(next ? [next] : []), ...invocations.map(item => item.id)])].slice(0, 12);
  return { ...parsed, ids, next, commands, evidenceCommands };
}

// Chips write into the composer draft: bare commands that need the user's
// topic wait for text; a command that already carries arguments submits an
// empty draft right away and only edits a non-empty one.
export const TOPIC_COMMANDS = new Set(['aif-explore', 'aif-plan', 'aif-fix', 'aif-scout']);

/** A bare topic command takes the gate's reason as its topic, so its chip can send at once. */
export function withTopic(command: string, id: string, topic: string | null | undefined): string {
  const text = topic?.replace(/\s+/g, ' ').trim().slice(0, 500);
  return TOPIC_COMMANDS.has(id) && text && !/\s/.test(command.trim()) ? `${command} ${text}` : command;
}

const stripRanges = (text: string, ranges: readonly { from: number; to: number }[]) => {
  let out = '';
  let pos = 0;
  for (const m of ranges) { out += text.slice(pos, m.from); pos = Math.max(pos, m.to); }
  return out + text.slice(pos);
};

const isModePill = (m: { kind?: string; provider?: string; id?: string }) =>
  m.kind === 'plugin' && m.provider === 'aif-mode' && m.id === 'aif-mode';

/** True when the draft text, ignoring the AI Factory pill, starts with a `/aif-…` or `$aif-…` command. */
export function isCommandDraft(draft: { text: string; mentions: readonly { from: number; to: number; kind?: string; provider?: string; id?: string }[] }): boolean {
  const pills = draft.mentions.filter(isModePill).sort((a, b) => a.from - b.from);
  // Only an AI Factory command takes the rest of the draft as its arguments; `/tmp contains …` and `$20` are plain text.
  return /^[/$]aif[\w-]*(\s|$)/i.test(stripRanges(draft.text, pills).trimStart());
}

export function chipDraft<M extends { from: number; to: number; kind?: string; provider?: string; id?: string }>(
  draft: { text: string; mentions: readonly M[] },
  command: string,
  id: string,
): { text: string; mentions: M[]; submit: boolean } {
  // The AI Factory mode pill never enters a command draft: BB would pass its
  // text to the skill as arguments, while commands read the mode from
  // skill-context. A draft holding only the pill counts as empty.
  const pills = draft.mentions.filter(isModePill).sort((a, b) => a.from - b.from);
  const hasArgs = /\s/.test(command.replace(/^[/\$][\w-]+/, ''));
  const empty = () => {
    const topic = TOPIC_COMMANDS.has(id) && !hasArgs;
    return { text: topic ? `${command} ` : command, mentions: [] as M[], submit: !topic };
  };
  const text = stripRanges(draft.text, pills);
  const unshift = (at: number) => pills.reduce((n, m) => n + (m.to <= at ? m.to - m.from : m.from < at ? at - m.from : 0), 0);
  const mentions = draft.mentions.filter(m => !isModePill(m)).map(m => ({ ...m, from: m.from - unshift(m.from), to: m.to - unshift(m.to) }));
  if (!text.trim()) return empty();
  const lead = /^\s*/.exec(text)![0].length;
  const body = text.slice(lead);
  const head = /^[/$][\w-]+/.exec(body);
  if (head) {
    const start = lead;
    const end = lead + head[0].length;
    const tail = text.slice(end);
    const overlaps = mentions.some(m => m.from < end && m.to > start);
    if (!overlaps) {
      if (!tail.trim() && !hasArgs) return empty();
      if (hasArgs) {
        const newline = text.indexOf('\n', end);
        const cut = newline === -1 ? text.length : newline;
        const delta = command.length - (cut - start);
        return {
          text: text.slice(0, start) + command + text.slice(cut),
          mentions: mentions.filter(m => m.to <= start || m.from >= cut)
            .map(m => m.from >= cut ? { ...m, from: m.from + delta, to: m.to + delta } : m),
          submit: false,
        };
      }
      const delta = command.length - head[0].length;
      return {
        text: text.slice(0, start) + command + tail,
        mentions: mentions.map(m => {
          const by = m.from >= end ? delta : 0;
          return { ...m, from: m.from + by, to: m.to + by };
        }),
        submit: true,
      };
    }
  }
  const shift = command.length + 1 - lead;
  return {
    text: hasArgs ? `${command}\n${body}` : `${command} ${body}`,
    mentions: mentions.map(m => ({ ...m, from: m.from + shift, to: m.to + shift })),
    submit: !hasArgs,
  };
}

/**
 * Chips for a chat whose last reply names no AI Factory command (mode on): up to three available
 * `next` actions whose skill is installed, one per skill, in the runtime's prefix.
 */
export function nextStepItems(actions: readonly Action[], o: { skills: readonly string[]; invalid: boolean; prefix: '/' | '$'; hidden: readonly string[] }): Suggestions['items'] {
  if (o.invalid) return [];
  const seen = new Set<string>();
  return actions.filter(a => a.group === 'next' && a.available).flatMap(a => {
    const body = a.command.replace(/^[/$]/, '');
    const id = body.split(/\s/, 1)[0];
    if (seen.has(id) || !(o.skills.includes(id) || (PLUGIN_SKILLS as readonly string[]).includes(id))) return [];
    seen.add(id);
    return [{ id, command: `${o.prefix}${body}`, available: true, reason: 'Следующий шаг', probability: null }];
  }).filter(item => !o.hidden.includes(item.id)).slice(0, 3);
}
