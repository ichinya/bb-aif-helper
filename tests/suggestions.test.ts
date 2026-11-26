import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands, extractAifInvocations, analyzeReply, chipDraft, isCommandDraft, nextStepItems, withTopic, rulesSyncCommand } from '../suggestions.ts';

test('stale generated rules use only an exact, scoped sync invocation in completed code', () => {
  const command = 'ai-factory aifhub-mode sync --change "268-demo" --json';
  const report = 'SessionBrief актуален (`valid`), но проверка отметила правила как `stale-generated-rules`.\n';
  assert.equal(rulesSyncCommand(report + '```powershell\r\n' + command + '\r\n```', '268-demo'), command);
  assert.equal(rulesSyncCommand(report + '`' + command + '`', '268-demo'), command);
  for (const text of [report + '```powershell\n' + command, report + '```powershell\n' + command + ' --all\n```',
    report + '`' + command + '; next-command`', '```text\nstale-generated-rules\n' + command + '\n```',
    report + '`' + command + '` и `ai-factory aifhub-mode sync --change other --json`']) {
    assert.equal(rulesSyncCommand(text, '268-demo'), undefined);
  }
  assert.equal(rulesSyncCommand(report + '`' + command + '`', 'other'), undefined);
});

test('last-answer command names are extracted in order, without arguments or duplicates', () => {
  assert.deepEqual(extractAifCommands('Далее `$aif-architecture`, затем `$aif-roadmap`. Повтор: $aif-architecture; $aif-plan full #177; $aif.'), ['aif-architecture', 'aif-roadmap', 'aif-plan', 'aif']);
});
test('commands inside code blocks work; other variables and embedded names do not match', () => {
  assert.deepEqual(extractAifCommands('```text\n$aif-plan\n```\n$aifhub $aif_analyze $$aif-plan foo$aif-plan /$aif-plan $HOME'), ['aif-plan']);
});

test('scoped commands in fenced blocks stop at LF or CRLF without disappearing or consuming the next line', () => {
  for (const newline of ['\n', '\r\n']) {
    const text = ['Прогресс остаётся 10/15. Теперь можно вернуться к задаче 3.3:', '', '```text',
      '$aif-implement 71-schedule-templates', '```', '',
      '::aif-chat{card="794dbf57-c2ed-4bbd-af7a-c62b75bf78bb" target="openspec/changes/71-schedule-templates/tasks.md" phase="fix"}'].join(newline);
    const reply = analyzeReply(text);
    assert.deepEqual(reply.ids, ['aif-implement']);
    assert.equal(reply.commands.get('aif-implement'), 'aif-implement 71-schedule-templates');
    assert.equal(reply.error, null);
    assert.deepEqual(extractAifInvocations('/aif-plan full "@docs/my plan.md"' + newline + 'Following prose'), [
      { id: 'aif-plan', command: 'aif-plan full "@docs/my plan.md"' },
    ]);
    assert.deepEqual(extractAifInvocations('$aif-implement demo \t' + newline + 'rm unrelated'), [
      { id: 'aif-implement', command: 'aif-implement demo' },
    ]);
    assert.deepEqual(extractAifInvocations('$aif-plan "unfinished' + newline + 'argument"'), []);
    assert.deepEqual(extractAifInvocations('$aif-plan ' + 'x'.repeat(4001) + newline), []);
  }
});
test('suggestions are bounded and do not turn following shell syntax into a command', () => {
  const commands = Array.from({ length: 20 }, (_, i) => `$aif-${i}`).join(' ');
  assert.equal(extractAifCommands(commands).length, 12);
  assert.deepEqual(extractAifCommands('$aif-review; rm -rf x && $aif-plan'), ['aif-review', 'aif-plan']);
  assert.deepEqual(extractAifCommands('x'.repeat(1024 * 1024) + ' $aif-plan'), []);
});

test('prefix-free invocations in complete code spans and fences retain arguments and reply order', () => {
  const reply = analyzeReply('Следующий шаг — `aif-fix 71-schedule-templates`. Коммит и push не выполнялись.');
  assert.deepEqual(reply.ids, ['aif-fix']);
  assert.equal(reply.commands.get('aif-fix'), 'aif-fix 71-schedule-templates');
  for (const command of ['`aif-review`', '``aif-review``', '```text\naif-review\n```', '~~~text\r\naif-review\r\n~~~~']) {
    assert.deepEqual(extractAifCommands(command), ['aif-review']);
  }
  assert.deepEqual(extractAifInvocations('``aif-fix "@docs/my plan.md" --plan-first``'), [
    { id: 'aif-fix', command: 'aif-fix "@docs/my plan.md" --plan-first' },
  ]);
  assert.deepEqual(extractAifInvocations('`aif-mode sync` затем `$aif-commit`, потом `aif-mode`.'), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.deepEqual(extractAifInvocations('```text\naif-fix demo && shell\naif-verify demo\n```'), [
    { id: 'aif-fix', command: 'aif-fix demo' }, { id: 'aif-verify', command: 'aif-verify demo' },
  ]);
});

test('prefix-free mentions outside command code, paths and incomplete code never become suggestions', () => {
  for (const text of ['aif-fix demo', 'Applied aif-fix.', '`skills/aif-fix/SKILL.md`', '`aif-fix.md`',
    '`https://example.org/aif-fix`', '`example aif-fix demo`', '`aif-fix demo', '```text\naif-fix demo',
    '```text\naif-fix demo\n~~', '`aif-fix "unfinished`', '`aif-fix ' + 'x'.repeat(4001) + '`']) {
    assert.deepEqual(extractAifInvocations(text), [], text.slice(0, 80));
  }
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [],
    affected_files: ['aif-archive'], suggested_next: { command: null, reason: 'aif-commit' } };
  assert.deepEqual(analyzeReply('```aif-gate-result\n' + JSON.stringify(gate) + '\n```').ids, []);
  assert.equal(extractAifCommands(Array.from({ length: 20 }, (_, i) => '`aif-' + i + '`').join(' ')).length, 12);
});

test('slash recommendations from the finalization reply preserve only the fixed sync subcommand', () => {
  const reply = 'Следующие отдельные шаги: `/aif-mode sync`, затем `/aif-commit`. Commit, push и deploy не выполнялись.';
  assert.deepEqual(extractAifCommands(reply), ['aif-mode', 'aif-commit']);
  assert.deepEqual(extractAifInvocations(reply), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.deepEqual(extractAifInvocations('$aif-mode /aif-mode sync /aif-commit $aif-commit'), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
});

test('slash commands exclude paths, URLs and malformed prefixes and retain arguments only up to the invocation boundary', () => {
  assert.deepEqual(extractAifCommands('https://example.org/aif-review /tmp/aif-plan ./aif-fix //aif-commit $/aif-mode /$aif-plan /aifhub /aif_bad'), []);
  assert.deepEqual(extractAifInvocations('/aif-mode sync --force && shell'), [{ id: 'aif-mode', command: 'aif-mode sync --force' }]);
  for (const text of ['$aif-mode sync; shell', '/aif-mode sync, затем', '/aif-mode sync$(shell)']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode sync' }]);
  }
  assert.deepEqual(extractAifInvocations('/aif-mode\nsync'), [{ id: 'aif-mode', command: 'aif-mode' }]);
  assert.deepEqual(extractAifInvocations('/aif-plan full @secret #196'), [{ id: 'aif-plan', command: 'aif-plan full @secret #196' }]);
});

test('Markdown backticks terminate arguments and never become arguments or absorb following prose', () => {
  assert.deepEqual(extractAifInvocations('Далее `$aif-plan full #177`, затем `$aif-review +coupling`. Объяснение.'), [
    { id: 'aif-plan', command: 'aif-plan full #177' }, { id: 'aif-review', command: 'aif-review +coupling' },
  ]);
  assert.deepEqual(extractAifInvocations('``$aif-fix "@docs/my plan.md" --plan-first`` — пояснение'), [
    { id: 'aif-fix', command: 'aif-fix "@docs/my plan.md" --plan-first' },
  ]);
  assert.deepEqual(extractAifInvocations('`$aif-explore и что проверить?`'), [{ id: 'aif-explore', command: 'aif-explore и что проверить?' }]);
  assert.deepEqual(extractAifInvocations('`$aif-review`'), [{ id: 'aif-review', command: 'aif-review' }]);
  assert.deepEqual(extractAifInvocations('$aif-plan "unterminated\nNext line'), []);
  assert.deepEqual(extractAifInvocations('$aif-plan ' + 'x'.repeat(4001)), []);
});

test('gate JSON cannot supply prose arguments and an exact gate recommendation retains precedence', () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [], affected_files: ['/aif-archive'],
    suggested_next: { command: '/aif-mode', reason: 'Example /aif-mode sync is data.' } };
  const reply = analyzeReply('/aif-mode sync\n```aif-gate-result\n' + JSON.stringify(gate) + '\n```');
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-mode']);
  assert.equal(reply.commands.get('aif-mode'), 'aif-mode');
});

test('chipDraft keeps a topic command in an empty draft without submitting', () => {
  for (const id of ['aif-explore', 'aif-plan', 'aif-fix', 'aif-scout']) {
    assert.deepEqual(chipDraft({ text: '', mentions: [] }, `/${id}`, id), { text: `/${id} `, mentions: [], submit: false });
  }
});
test('chipDraft submits commands that need no topic text from an empty draft', () => {
  for (const id of ['aif-verify', 'aif-commit', 'aif-improve']) {
    assert.deepEqual(chipDraft({ text: '', mentions: [] }, `/${id}`, id), { text: `/${id}`, mentions: [], submit: true });
  }
});
test('chipDraft prepends to a non-empty draft and shifts mentions past the inserted command', () => {
  const mention = { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: 'check @a now', mentions: [mention] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify check @a now');
  assert.deepEqual(result.mentions, [{ ...mention, from: 18, to: 20 }]);
});
test('chipDraft replaces a leading command, keeps the tail and shifts later mentions by the delta', () => {
  const mention = { from: 14, to: 16, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  assert.deepEqual(chipDraft({ text: '/aif-plan fix @x', mentions: [mention] }, '/aif-fix', 'aif-fix'),
    { text: '/aif-fix fix @x', mentions: [{ ...mention, from: 13, to: 15 }], submit: true });
  assert.deepEqual(chipDraft({ text: '  /aif-plan fix', mentions: [] }, '/aif-fix', 'aif-fix'), { text: '  /aif-fix fix', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '/aif-plan ', mentions: [] }, '/aif-fix', 'aif-fix'), { text: '/aif-fix ', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-verify', mentions: [] }, '/aif-commit', 'aif-commit'), { text: '/aif-commit', mentions: [], submit: true });
});
test('chipDraft shifts two mentions and preserves their extra fields', () => {
  const mentions = [
    { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' },
    { from: 13, to: 15, label: '@b', kind: 'thread', threadId: 'thr_1', projectId: 'proj_1' },
  ];
  const result = chipDraft({ text: 'check @a then @b', mentions }, '$aif-fix', 'aif-fix');
  assert.equal(result.submit, true);
  assert.deepEqual(result.mentions, [{ ...mentions[0], from: 15, to: 17 }, { ...mentions[1], from: 22, to: 24 }]);
});
test('chipDraft handles the dollar prefix used by codex runtimes', () => {
  assert.deepEqual(chipDraft({ text: '', mentions: [] }, '$aif-verify', 'aif-verify'), { text: '$aif-verify', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '$aif-plan old task', mentions: [] }, '$aif-fix', 'aif-fix'), { text: '$aif-fix old task', mentions: [], submit: true });
});
test('chipDraft treats a whitespace-only draft as empty', () => {
  assert.deepEqual(chipDraft({ text: '  \n\t ', mentions: [] }, '/aif-plan', 'aif-plan'), { text: '/aif-plan ', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '   ', mentions: [] }, '/aif-commit', 'aif-commit'), { text: '/aif-commit', mentions: [], submit: true });
});
test('chipDraft prepends when a mention overlaps the leading command instead of replacing it', () => {
  const mention = { from: 1, to: 4, label: 'aif', kind: 'command', trigger: '/', name: 'aif-plan', source: 'skill', origin: 'builtin', argumentHint: null };
  const result = chipDraft({ text: '/aif-plan fix this', mentions: [mention] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify /aif-plan fix this');
  assert.deepEqual(result.mentions, [{ ...mention, from: 13, to: 16 }]);
});
test('isCommandDraft detects leading / and $ commands and ignores the pill', () => {
  const pill = { from: 0, to: 11, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  assert.equal(isCommandDraft({ text: '/aif-plan fix', mentions: [] }), true);
  assert.equal(isCommandDraft({ text: '  $aif-verify', mentions: [] }), true);
  assert.equal(isCommandDraft({ text: 'fix /aif-plan', mentions: [] }), false);
  assert.equal(isCommandDraft({ text: '@AI Factory /aif-plan', mentions: [pill] }), true);
  assert.equal(isCommandDraft({ text: '@AI Factory', mentions: [pill] }), false);
  assert.equal(isCommandDraft({ text: '', mentions: [] }), false);
  // Paths and prices are plain text: a typed @AI Factory stays in them.
  assert.equal(isCommandDraft({ text: '/tmp/build.log failed', mentions: [] }), false);
  assert.equal(isCommandDraft({ text: '$20 is the budget', mentions: [] }), false);
  assert.equal(isCommandDraft({ text: '/aif-verify', mentions: [] }), true);
  assert.equal(isCommandDraft({ text: '/tmp contains the cache', mentions: [] }), false);
  assert.equal(isCommandDraft({ text: '$HOME points home', mentions: [] }), false);
});
test('chipDraft drops the AI Factory pill: a draft holding only it counts as empty', () => {
  const pill = { from: 0, to: 10, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const result = chipDraft({ text: 'AI Factory', mentions: [pill] }, '/aif-plan', 'aif-plan');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-plan ');
  assert.deepEqual(result.mentions, []);
});
test('chipDraft removes the pill from a command draft and shifts other mentions', () => {
  const pill = { from: 0, to: 11, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const mention = { from: 26, to: 28, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: '@AI Factory /aif-plan fix @x', mentions: [pill, mention] }, '/aif-fix', 'aif-fix');
  assert.equal(result.submit, true);
  assert.equal(result.text, ' /aif-fix fix @x');
  assert.deepEqual(result.mentions, [{ ...mention, from: 14, to: 16 }]);
});
test('chipDraft drops the pill when prepending a command to plain text', () => {
  const pill = { from: 4, to: 15, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const result = chipDraft({ text: 'fix @AI Factory now', mentions: [pill] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify fix  now');
  assert.deepEqual(result.mentions, []);
});

test('next-step chips: available next actions of installed skills, one per skill, at most three, runtime prefix', () => {
  const a = (id: string, command: string, group: 'next' | 'check' = 'next', available = true) => ({ id, label: id, command, group, reason: '', available });
  const actions = [a('commit', '/aif-commit'), a('verify', '/aif-verify', 'check'), a('plan', '/aif-plan', 'next', false),
    a('impl', '/aif-implement @.ai-factory/plans/x.md'), a('impl2', '/aif-implement'), a('gone', '/aif-gone'), a('qa', '/aif-qa'), a('fix', '/aif-fix')];
  const skills = ['aif-commit', 'aif-verify', 'aif-plan', 'aif-implement', 'aif-qa', 'aif-fix'];
  assert.deepEqual(nextStepItems(actions as any, { skills, invalid: false, prefix: '$', hidden: ['aif-qa'] }).map(i => i.command),
    ['$aif-commit', '$aif-implement @.ai-factory/plans/x.md', '$aif-fix']);
  assert.deepEqual(nextStepItems([a('scout', '/aif-scout')] as any, { skills: [], invalid: false, prefix: '/', hidden: [] }).map(i => i.command),
    ['/aif-scout']);
  assert.deepEqual(nextStepItems(actions as any, { skills, invalid: true, prefix: '/', hidden: [] }), []);
});

test('inline code spans keep the full one-line command with its arguments', () => {
  const reply = 'Next: `/aif-fix refresh src/rooms/sma-map/provenance.json via npx tsx scripts/sma-provenance.ts so npm run sma:facts:check passes on HEAD` or `/aif-commit`.';
  const command = 'aif-fix refresh src/rooms/sma-map/provenance.json via npx tsx scripts/sma-provenance.ts so npm run sma:facts:check passes on HEAD';
  assert.deepEqual(extractAifInvocations(reply), [
    { id: 'aif-fix', command }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.equal(analyzeReply(reply).commands.get('aif-fix'), command);
});
test('a span variant with arguments replaces the bare command; the first one wins', () => {
  assert.deepEqual(extractAifInvocations('/aif-plan then `/aif-plan full #1` then `/aif-plan other`'),
    [{ id: 'aif-plan', command: 'aif-plan full #1' }]);
  assert.deepEqual(extractAifInvocations('`/aif-plan full #1` and /aif-plan'),
    [{ id: 'aif-plan', command: 'aif-plan full #1' }]);
  assert.deepEqual(extractAifInvocations('/aif-zeta `/aif-alpha x` /aif-commit `/aif-commit --amend`'),
    [{ id: 'aif-zeta', command: 'aif-zeta' }, { id: 'aif-alpha', command: 'aif-alpha x' }, { id: 'aif-commit', command: 'aif-commit --amend' }]);
});
test('overlong, multiline, fenced or control-character spans keep arguments up to the invocation boundary', () => {
  assert.deepEqual(extractAifInvocations('`/aif-fix ' + 'x'.repeat(300) + '`'), [{ id: 'aif-fix', command: 'aif-fix ' + 'x'.repeat(300) }]);
  assert.deepEqual(extractAifInvocations('`/aif-fix x\ny`'), [{ id: 'aif-fix', command: 'aif-fix x' }]);
  assert.deepEqual(extractAifInvocations('```\n/aif-fix x\n```'), [{ id: 'aif-fix', command: 'aif-fix x' }]);
  assert.deepEqual(extractAifInvocations('`/aif-fix\tx`'), [{ id: 'aif-fix', command: 'aif-fix x' }]);
});
test('span commands are trimmed and inner whitespace collapses to single spaces', () => {
  assert.deepEqual(extractAifInvocations('`  /aif-fix   refresh   x  `'), [{ id: 'aif-fix', command: 'aif-fix refresh x' }]);
  assert.deepEqual(extractAifInvocations('`$aif-verify @plan.md`'), [{ id: 'aif-verify', command: 'aif-verify @plan.md' }]);
});
test('chipDraft submits a command with arguments from an empty draft', () => {
  assert.deepEqual(chipDraft({ text: '', mentions: [] }, '/aif-fix refresh x so y', 'aif-fix'),
    { text: '/aif-fix refresh x so y', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '  \n ', mentions: [] }, '/aif-verify @plan.md', 'aif-verify'),
    { text: '/aif-verify @plan.md', mentions: [], submit: true });
});
test('chipDraft puts an argument command on the first line of a plain draft without submitting', () => {
  const mention = { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: 'check @a now', mentions: [mention] }, '/aif-verify @plan.md', 'aif-verify');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-verify @plan.md\ncheck @a now');
  assert.deepEqual(result.mentions, [{ ...mention, from: 27, to: 29 }]);
});
test('chipDraft replaces the whole first line of a command draft with an argument command', () => {
  assert.deepEqual(chipDraft({ text: '/aif-fix B old args', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-fix B\nkeep this line', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A\nkeep this line', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-plan ', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A', mentions: [], submit: false });
});
test('chipDraft drops mentions inside the replaced first line and shifts later ones', () => {
  const inside = { from: 9, to: 11, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  const after = { from: 17, to: 19, label: '@y', kind: 'path', path: 'y', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: '/aif-fix @x\nkeep @y', mentions: [inside, after] }, '/aif-verify @plan.md', 'aif-verify');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-verify @plan.md\nkeep @y');
  assert.deepEqual(result.mentions, [{ ...after, from: 26, to: 28 }]);
});

test('withTopic gives a bare topic command the gate reason, then the chip sends it at once', () => {
  const command = withTopic('/aif-fix', 'aif-fix', 'Reset the retry flag\n after a successful re-watch.');
  assert.equal(command, '/aif-fix Reset the retry flag after a successful re-watch.');
  assert.deepEqual(chipDraft({ text: '', mentions: [] }, command, 'aif-fix'), { text: command, mentions: [], submit: true });
  assert.equal(withTopic('/aif-fix', 'aif-fix', null), '/aif-fix');
  assert.equal(withTopic('/aif-fix login fails', 'aif-fix', 'other'), '/aif-fix login fails');
  assert.equal(withTopic('/aif-verify', 'aif-verify', 'some reason'), '/aif-verify');
});
