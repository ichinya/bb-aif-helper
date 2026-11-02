import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyGate, blockedByGate } from '../gate.ts';
import { analyzeReply } from '../suggestions.ts';

export const gateBlock = (gate: object) => '```aif-gate-result\n' + JSON.stringify(gate) + '\n```';
export const warnGate = { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: ['src/demo.ts'], suggested_next: { command: '/aif-commit', reason: 'Only non-blocking warnings remain.' } };
test('non-blocking verify WARN extracts the slash recommendation and its reason', () => {
  const reply = analyzeReply(gateBlock(warnGate));
  assert.equal(reply.error, null); assert.equal(reply.gate?.status, 'warn');
  assert.equal(reply.gate?.blocking, false); assert.deepEqual(reply.ids, ['aif-commit']);
  assert.equal(reply.gate?.suggested_next?.reason, warnGate.suggested_next.reason);
});
test('blocking findings retain stable ids, severity, summary and files; prose cannot bypass them', () => {
  const fail = { ...warnGate, status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', file: 'src/demo.ts', summary: 'Required behavior is missing.' }], suggested_next: { command: '/aif-fix', reason: 'Fix the blocker.' } };
  const reply = analyzeReply('$aif-commit\n' + gateBlock(fail));
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-fix', 'aif-commit']);
  assert.equal(reply.gate?.blockers[0].summary, fail.blockers[0].summary);
  assert(blockedByGate('aif-commit', reply.gate)); assert(!blockedByGate('aif-fix', reply.gate));
});
test('last gate wins and data fields never become independent command suggestions', () => {
  const reply = analyzeReply(gateBlock(warnGate) + '\n' + gateBlock({ ...warnGate, affected_files: ['$aif-archive'], suggested_next: { command: '/aif-roadmap', reason: '$aif-commit is a quoted name, not another recommendation.' } }));
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-roadmap']);
});
test('invalid or unclosed final gate never falls back to an earlier valid result', () => {
  for (const tail of ['```aif-gate-result\nbad\n```', '```aif-gate-result\n{"status":']) {
    const reply = analyzeReply(gateBlock(warnGate) + '\n' + tail);
    assert(reply.error); assert.equal(reply.gate, null); assert.deepEqual(reply.ids, []);
  }
  assert(parseReplyGate(gateBlock(warnGate) + '\nmore text').error);
});
test('nested or quoted examples are not authoritative gate results', () => {
  assert.equal(parseReplyGate('````markdown\n' + gateBlock(warnGate) + '\n````').gate, null);
  assert.equal(parseReplyGate(gateBlock(warnGate).split('\n').map(l => '> ' + l).join('\n')).gate, null);
});
test('contradictory states, arbitrary commands and gate-incompatible routing are diagnosed', () => {
  for (const patch of [
    { blocking: true }, { status: 'fail', blocking: true }, { status: 'pass' },
    { suggested_next: { command: '/aif-commit && shell', reason: 'bad' } },
    { gate: 'security' }, { schema_version: 2 },
    { blockers: [{ id: 'x', severity: 'critical', summary: 'bad severity' }] },
  ]) assert(analyzeReply(gateBlock({ ...warnGate, ...patch })).error);
});
test('PASS or FAIL with no next command still produces gate information, not invented suggestions', () => {
  const pass = analyzeReply(gateBlock({ ...warnGate, status: 'pass', suggested_next: null }));
  assert.equal(pass.error, null); assert.equal(pass.gate?.status, 'pass'); assert.deepEqual(pass.ids, []);
  const fail = analyzeReply(gateBlock({ ...warnGate, status: 'fail', blocking: true, blockers: [{ id: '1', severity: 'warning', summary: 'Policy escalates this finding.' }], suggested_next: null }));
  assert.equal(fail.error, null); assert.equal(fail.gate?.blockers.length, 1); assert.deepEqual(fail.ids, []);
});
