import { z } from 'zod';

export const phaseSchema = z.enum(['unknown', 'explore', 'plan', 'improve', 'implement', 'verify', 'fix', 'done']);
export const requestSchema = z.object({
  threadId: z.string().min(1).max(200),
  target: z.string().max(1000).default(''),
  phase: phaseSchema.default('unknown'),
}).strict();
export const actionSchema = z.object({
  id: z.string(), label: z.string(), command: z.string(), group: z.enum(['next', 'check', 'setup', 'maintenance']),
  reason: z.string(), available: z.boolean(), disabledReason: z.literal('unchanged').optional(),
});
export const snapshotSchema = z.object({
  schemaVersion: z.literal('aif-chat/v1'), collectedAt: z.string(), fingerprint: z.string(),
  inputsFingerprint: z.string().length(64).nullable().default(null),
  versionsCheckedAt: z.string().optional(),
  cache: z.object({ source: z.enum(['live', 'memory', 'saved']), refreshing: z.boolean(), refreshError: z.boolean() }).optional(),
  root: z.string(), runtime: z.string(), configured: z.boolean(),
  worktree: z.object({ hasUncommitted: z.boolean().nullable() }).default({ hasUncommitted: null }),
  profile: z.enum(['none', 'upstream', 'aifhub-classic', 'aifhub-openspec', 'aifhub-ultra', 'invalid']),
  threadState: z.string(),
  pendingQuestions: z.number().int().nonnegative().nullable(),
  phase: phaseSchema, phaseSource: z.string(),
  versions: z.object({ globalCli: z.string().nullable(), globalSource: z.string().nullable(), installed: z.string().nullable(),
    sourceVersion: z.string().nullable(), sourceWorktreeVersion: z.string().nullable(), sourceSha: z.string().nullable(), sourceDirty: z.boolean().nullable() }),
  upstream: z.object({ version: z.string().nullable(), sha: z.string().nullable(), ref: z.string().nullable(), checkedAt: z.string().nullable(), error: z.string().nullable() }),
  extensions: z.array(z.object({ name: z.string(), recordedVersion: z.string().nullable(), installedVersion: z.string().nullable(),
    source: z.string(), state: z.enum(['present', 'missing', 'invalid', 'version_mismatch']), contributions: z.array(z.string()) })),
  skills: z.array(z.string()), candidates: z.array(z.object({ path: z.string(), title: z.string(), kind: z.string() })),
  target: z.object({ path: z.string(), title: z.string(), id: z.string(), kind: z.enum(['fast', 'full', 'fix', 'ultra', 'classic', 'openspec', 'basic']),
    tasks: z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean() })) }).nullable(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), state: z.enum(['notrun', 'reported-pass', 'warn', 'fail', 'unknown']),
    detail: z.string(), path: z.string().nullable(), required: z.boolean(),
    chat: z.object({ seq: z.number(), at: z.string(), target: z.string(),
      result: z.lazy(() => gateResultSchema), freshness: z.enum(['unknown', 'unchanged', 'changed']),
      inputFingerprint: z.string().length(64).optional(), observedAt: z.string().optional() }).optional() })),
  actions: z.array(actionSchema), diagnostics: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type CardRequest = z.infer<typeof requestSchema>;
export const selectionSchema = z.object({ target: z.string().max(1000), phase: phaseSchema }).strict();
export const runSchema = requestSchema.extend({ fingerprint: z.string().length(64), actionId: z.string().min(1).max(100), requestId: z.string().uuid() }).strict();
export const hostInputSchema = z.object({ root: z.string().min(1).max(4096), target: z.string().max(1000), phase: phaseSchema,
  runtime: z.string().max(100), sourceRepo: z.string().max(4096), checkUpdates: z.boolean(),
  upstreamRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), upstreamRef: z.string().max(200),
  cachedVersions: z.object({ versions: snapshotSchema.shape.versions, checkedAt: z.string() }).nullable().default(null),
}).strict();
export type HostInput = z.input<typeof hostInputSchema>;
export const suggestionRequestSchema = z.object({ threadId: z.string().min(1).max(200) }).strict();
export const suggestionActionSchema = suggestionRequestSchema.extend({
  sourceKey: z.string().length(64), commandId: z.string().max(100).regex(/^aif(?:-[a-z0-9]+)*$/),
}).strict();
export const gateResultSchema = z.object({
  schema_version: z.literal(1), gate: z.enum(['verify', 'review', 'security', 'rules']),
  status: z.enum(['pass', 'warn', 'fail']), blocking: z.boolean(),
  blockers: z.array(z.object({ id: z.string().min(1).max(200), severity: z.enum(['error', 'warning']),
    file: z.string().max(1000).nullable().optional(), summary: z.string().min(1).max(2000) })).max(100),
  affected_files: z.array(z.string().max(1000)).max(200),
  suggested_next: z.object({ command: z.string().max(150).nullable(), reason: z.string().max(2000).nullable() }).nullable().default(null),
});
export type GateResult = z.infer<typeof gateResultSchema>;
export const suggestionsSchema = z.object({
  sourceKey: z.string(), fingerprint: z.string(), threadState: z.string(),
  gate: gateResultSchema.nullable().default(null), gateError: z.string().nullable().default(null),
  items: z.array(z.object({ id: z.string(), command: z.string(), available: z.boolean(), reason: z.string() })),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;
