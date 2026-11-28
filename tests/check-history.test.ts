import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatChecks, attachChatChecks, type HistoryRow as ThreadEventRow } from '../check-history.ts';
import { snapshot } from './fixtures.ts';
const target = '.ai-factory/plans/demo.md';
const other = '.ai-factory/plans/other.md';
const plan = (path: string) => ({ path, kind: 'full' });
function reply(seq: number, gate = 'verify', files = [target], status = 'warn'): ThreadEventRow {
  return { seq, createdAt: 1793627900000, type: 'item/completed', data: { item: { type: 'agentMessage', text:
    '```aif-gate-result\n' + JSON.stringify({ schema_version: 1, gate, status, blocking: false, blockers: [], affected_files: files, suggested_next: null }) + '\n```' } } } as ThreadEventRow;
}
function request(seq: number, text: string): ThreadEventRow {
  return { seq, type: 'client/turn/requested', data: { input: [{ type: 'text', text }] } } as ThreadEventRow;
}

test('rules PASS with a null-command explanation is retained in check history', () => {
  const row = reply(10, 'rules', [target], 'pass');
  if (row.type === 'item/completed' && row.data.item.type === 'agentMessage') row.data.item.text = row.data.item.text.replace('"suggested_next":null', '"suggested_next":{"command":null,"reason":"No rule updates required."}');
  const checks = readChatChecks([row], [plan(target)]);
  assert.equal(checks.length, 1); assert.equal(checks[0].result.status, 'pass');
  assert.equal(checks[0].result.suggested_next?.command, null);
});
test('completed verify WARN is restored from history and survives later rules result', () => {
  const records = readChatChecks([reply(4, 'rules'), reply(2), request(1, `$aif-verify "@${target}"`)], [plan(target)]);
  const s = snapshot({ checks: ['verify', 'rules'].map(id => ({ id, label: id, state: 'notrun', detail: 'Missing', path: null, required: false })) });
  attachChatChecks(s, records);
  assert.equal(s.checks[0].chat?.result.status, 'warn');
  assert.equal(s.checks[1].chat?.result.gate, 'rules');
  assert.equal(s.checks[0].state, 'notrun'); // File evidence and action readiness remain independent.
  assert.equal(s.checks[0].chat?.freshness, 'unknown');
});
test('scope requires an exact unique plan, never current selection or path substrings', () => {
  assert.equal(readChatChecks([reply(2, 'verify', ['src/code.ts'])], [plan(target)]).length, 0);
  assert.equal(readChatChecks([request(1, `${target}.bak`), reply(2, 'verify', [])], [plan(target)]).length, 0);
  assert.equal(readChatChecks([request(1, `${target} ${other}`), reply(2, 'verify', [])], [plan(target), plan(other)]).length, 0);
  assert.equal(readChatChecks([request(1, target), reply(2, 'verify', [other])], [plan(target)]).length, 0);
  const s = snapshot({ checks: [{ id: 'verify', label: '', state: 'notrun', detail: '', path: null, required: false }] });
  attachChatChecks(s, readChatChecks([reply(2, 'verify', [other])], [plan(target), plan(other)]));
  assert.equal(s.checks[0].chat, undefined);
});
test('a launch target binds a result lacking the plan in affected files; next request clears scope', () => {
  const rows = [request(1, `$aif-verify\nКонтекст: {"target":"${target}"}`), reply(2, 'verify', ['src/file.ts']), request(3, 'another task'), reply(4, 'rules', [])];
  const records = readChatChecks(rows, [plan(target)]);
  assert.equal(records.length, 1); assert.equal(records[0].seq, 2);
});

test('an exact OpenSpec change ID scopes the matching gate without guessing from prose', () => {
  const change = 'openspec/changes/demo-change/tasks.md';
  const openSpec = { path: change, kind: 'openspec' };
  const result = reply(2, 'verify', ['src/file.ts']);
  for (const command of ['$aif-verify demo-change', '/aif-verify "demo-change"', "$aif-verify 'demo-change'"]) {
    assert.equal(readChatChecks([request(1, command), result], [openSpec])[0]?.target, change);
  }
  for (const text of ['проверь demo-change', '$aif-verify demo', '$aif-verify demo-change-extra', '$aif-verify demo-change other-change', '$aif-review demo-change']) {
    assert.deepEqual(readChatChecks([request(1, text), result], [openSpec]), []);
  }
  const rows = [request(1, '$aif-verify demo-change'), result];
  assert.deepEqual(readChatChecks(rows, [plan(change)]), []);
  assert.deepEqual(readChatChecks(rows, [openSpec, { ...openSpec, path: `other/${change}` }]), []);
});
test('latest same-gate result wins, malformed and nested tool messages are ignored', () => {
  const nested = reply(5); if (nested.type === 'item/completed') nested.data.item.parentToolCallId = 'tool';
  const invalid = reply(6, 'verify', [target], 'fail'); // invalid fail without blockers
  const s = snapshot({ checks: [{ id: 'verify', label: '', state: 'unknown', detail: '', path: null, required: false }] });
  attachChatChecks(s, readChatChecks([reply(2), reply(3, 'verify', [target], 'pass'), nested, invalid], [plan(target)]));
  assert.equal(s.checks[0].chat?.seq, 3); assert.equal(s.checks[0].chat?.result.status, 'pass');
});
