import { TOPIC_COMMANDS } from './suggestions.ts';

export const AIF_MENTION = { provider: 'aif-mode', id: 'aif-mode', label: 'AI Factory' } as const;

function formatTopicCommands(): string {
  const names = [...TOPIC_COMMANDS].map(id => `\`/${id}\``);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? '';
}

export function aifModeInstructions(): string {
  return [
    '## AI Factory mode',
    'This project is run through AI Factory.',
    'At the start read `.ai-factory/DESCRIPTION.md` and `.ai-factory/ARCHITECTURE.md` (or the paths in `.ai-factory/config.yaml` → `paths`).',
    'Drive work with `/aif-plan` → `/aif-implement` → `/aif-verify` → `/aif-commit`; fix bugs with `/aif-fix`.',
    'Follow the rules in `.ai-factory/skill-context/`.',
    'Call `aif_chat_status` at workflow boundaries.',
    `When the next step is ${formatTopicCommands()}, write it with its topic (\`/aif-fix <what to fix>\`), so the chip can send it at once.`,
    'When the next decision depends on outside facts that are not in the code, `DESCRIPTION.md` or `RESEARCH.md` — choosing a library or approach, an error that looks like a known bug in a dependency, or what users complain about and want — offer `/aif-scout "<topic>"` as a next step and name `/aif-scout` nowhere else in that reply, with the topic on one line in double quotes so the chip keeps it whole; the topic holds no double quotes, no other `/aif-` or `$aif-` command and no trailing backslash — if it needs any of them, write bare `/aif-scout` and give the topic in the reply text, naming AI Factory commands there as plain words without `/` or `$` (the aif-implement skill). Do not offer it when one known URL or the codebase answers the question.',
    'This is the default path; a direct owner request to do otherwise wins.',
  ].join('\n');
}

export function shouldContribute(input: { enabled: boolean; modeOn: boolean; parentThreadId: string | null }): boolean {
  return input.enabled && input.modeOn && input.parentThreadId === null;
}

const MENTION_TERMS = ['ai factory', 'aif', 'factory', 'фабрика', 'режим'];
/** Mention menu rows for a query: the mode pill when the query is empty or starts one of its terms. */
export function aifMentionItems(query: string) {
  const q = query.trim().toLowerCase();
  return !q || MENTION_TERMS.some(term => term.startsWith(q))
    ? [{ id: AIF_MENTION.id, title: 'AI Factory — режим работы', subtitle: 'Вести задачу через /aif-plan → /aif-implement → /aif-verify', icon: 'Workflow' }]
    : [];
}
