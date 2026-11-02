import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands } from '../suggestions.ts';

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
