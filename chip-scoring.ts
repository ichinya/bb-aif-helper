// Gemini Decisions API scoring for suggestion chips: builds the choice
// request, validates the response and flattens per-option probabilities.
import { z } from 'zod';

export const DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const REPLY_LIMIT = 20_000;

const SKILL_HINTS: Record<string, string> = {
  'aif-plan': 'plan new work',
  'aif-implement': 'execute the plan tasks',
  'aif-verify': 'verify implementation against the plan',
  'aif-commit': 'commit the changes',
  'aif-fix': 'fix a bug',
  'aif-review': 'code review',
  'aif-qa': 'QA test plan',
  'aif-docs': 'update docs',
  'aif-improve': 'refine the plan',
  'aif-archive': 'archive finished plans',
  'aif-rules-check': 'rules check',
  'aif-security-checklist': 'security audit',
};

export function decisionsRequest(reply: string, candidates: { id: string; command: string }[]) {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    const hint = SKILL_HINTS[c.id];
    criteria[c.id] = hint ? `${c.command} — ${hint}` : c.command;
  }
  return {
    model: 'gemini-decision-1',
    input: reply.slice(0, REPLY_LIMIT),
    questions: {
      next: {
        type: 'choice',
        instructions: 'Which of these AI Factory commands should the user run next, given the assistant reply?',
        criteria,
      },
    },
  };
}

const probabilitySchema = z.number().min(0).max(1);
export const decisionsResponseSchema = z.looseObject({
  answers: z.looseObject({
    next: z.looseObject({
      probabilities: z.record(z.string(), probabilitySchema).optional(),
    }).optional(),
  }).optional(),
});
export type DecisionsResponse = z.infer<typeof decisionsResponseSchema>;

/** Show a short gateway diagnostic, never its raw response, headers or credentials. */
export async function scoringErrorMessage(response: Response, key: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    const decoder = new TextDecoder();
    let body = '';
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return ''; }
      body += decoder.decode(value, { stream: true });
    }
    body = (body + decoder.decode()).trim();
    let message: string | undefined;
    try {
      const json = JSON.parse(body);
      message = [json?.error?.message, json?.detail, json?.message, json?.error].find(v => typeof v === 'string');
    } catch {
      if (response.headers.get('content-type')?.startsWith('text/plain') && body.length <= 400 && !/[<>\r\n]/.test(body)) message = body;
    }
    if (!message) return '';
    return message.replaceAll(key, '[скрыто]').replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [скрыто]')
      .replace(/\bsk-[\w-]+/gi, '[скрыто]').replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch { return ''; }
  finally { reader.releaseLock(); }
}

export function probabilitiesFor(response: DecisionsResponse, ids: readonly string[]): Record<string, number> {
  const next = response.answers?.next;
  if (!next) return {};
  const probabilities = next.probabilities ?? {};
  const out: Record<string, number> = {};
  for (const id of ids) {
    const p = probabilities[id];
    out[id] = p === undefined ? 0 : Math.min(1, Math.max(0, p));
  }
  return out;
}

export function scoringKey(sourceKey: string, ids: readonly string[]): string {
  return `${sourceKey}|${[...ids].sort().join(',')}`;
}
