import type { Snapshot } from './model.ts';
export const VERSION_TTL = 24 * 60 * 60 * 1000;
export const versionSampleFresh = (at: number, now = Date.now()) => Number.isFinite(at) && at <= now && now - at < VERSION_TTL;
export function coreVersionsMatch(s: Snapshot) {
  const { globalCli, installed, sourceVersion, sourceWorktreeVersion } = s.versions;
  return !!globalCli && !!installed && [installed, sourceVersion, sourceWorktreeVersion, s.upstream.version].filter(Boolean).every(v => v === globalCli);
}
export function updateInVersionDetails(s: Snapshot, id: string) {
  if (!coreVersionsMatch(s)) return false;
  if (id === 'update-factory') return true;
  return id === 'update-extensions' && s.extensions.length > 0 && s.extensions.every(e => e.state === 'present' && !!e.installedVersion && e.installedVersion === e.recordedVersion);
}
