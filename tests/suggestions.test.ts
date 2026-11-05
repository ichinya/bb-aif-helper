import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands, extractAifInvocations, analyzeReply } from '../suggestions.ts';

test('last-answer command names are extracted in order, without arguments or duplicates', () => {
  assert.deepEqual(extractAifCommands('Далее `$aif-architecture`, затем `$aif-roadmap`. Повтор: $aif-architecture; $aif-plan full #177; $aif.'), ['aif-architecture', 'aif-roadmap', 'aif-plan', 'aif']);
});
test('commands inside code blocks work; other variables and embedded names do not match', () => {
  assert.deepEqual(extractAifCommands('```text\n$aif-plan\n```\n$aifhub $aif_analyze $$aif-plan foo$aif-plan /$aif-plan $HOME'), ['aif-plan']);
});
test('suggestions are bounded and do not turn following shell syntax into a command', () => {
  const commands = Array.from({ length: 20 }, (_, i) => `$aif-${i}`).join(' ');
  assert.equal(extractAifCommands(commands).length, 12);
  assert.deepEqual(extractAifCommands('$aif-review; rm -rf x && $aif-plan'), ['aif-review', 'aif-plan']);
  assert.deepEqual(extractAifCommands('x'.repeat(1024 * 1024) + ' $aif-plan'), []);
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

test('slash commands exclude paths, URLs and malformed prefixes and never copy arbitrary arguments', () => {
  assert.deepEqual(extractAifCommands('https://example.org/aif-review /tmp/aif-plan ./aif-fix //aif-commit $/aif-mode /$aif-plan /aifhub /aif_bad'), []);
  for (const text of ['/aif-mode sync --force && shell', '$aif-mode sync; shell', '/aif-mode sync, затем']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode sync' }]);
  }
  for (const text of ['/aif-mode sync-other', '/aif-mode sync/path', '/aif-mode\nsync', '/aif-mode openspec', '/aif-mode sync$(shell)']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode' }]);
  }
  assert.deepEqual(extractAifInvocations('/aif-plan full @secret #196'), [{ id: 'aif-plan', command: 'aif-plan' }]);
});

test('gate JSON cannot supply prose arguments and an exact gate recommendation retains precedence', () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [], affected_files: ['/aif-archive'],
    suggested_next: { command: '/aif-mode', reason: 'Example /aif-mode sync is data.' } };
  const reply = analyzeReply('/aif-mode sync\n```aif-gate-result\n' + JSON.stringify(gate) + '\n```');
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-mode']);
  assert.equal(reply.commands.get('aif-mode'), 'aif-mode');
});
