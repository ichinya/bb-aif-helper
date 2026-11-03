import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION_TTL, versionSampleFresh, coreVersionsMatch, updateInVersionDetails } from '../versions.ts';
import { snapshot } from './fixtures.ts';
function matching() {
  const s = snapshot(); s.versions.globalCli = s.versions.installed = s.versions.sourceVersion = s.versions.sourceWorktreeVersion = '2.21.0';
  s.upstream.version = '2.21.0'; return s;
}
test('equal versions tuck maintenance into version details; mismatches and unknown local versions do not', () => {
  const s = matching(); assert(coreVersionsMatch(s)); assert(updateInVersionDetails(s, 'update-factory'));
  assert(!updateInVersionDetails(s, 'setup-context'));
  s.versions.installed = '2.12.0'; assert(!coreVersionsMatch(s));
  s.versions.installed = null; assert(!coreVersionsMatch(s));
  s.versions.installed = '2.21.0'; s.upstream.version = '2.22.0'; assert(!coreVersionsMatch(s));
});
test('extensions must also be healthy and match their recorded versions to tuck their updater away', () => {
  const s = matching(); s.extensions = [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }];
  assert(updateInVersionDetails(s, 'update-extensions'));
  s.extensions[0].installedVersion = '1.7.1'; assert(!updateInVersionDetails(s, 'update-extensions'));
  s.extensions[0].state = 'missing'; assert(!updateInVersionDetails(s, 'update-extensions'));
});
test('version results expire after a day, never after a normal card poll or because of a future timestamp', () => {
  const at = 1000;
  assert(versionSampleFresh(at, at + VERSION_TTL - 1)); assert(!versionSampleFresh(at, at + VERSION_TTL));
  assert(!versionSampleFresh(at + 1, at)); assert(!versionSampleFresh(NaN, at));
});
