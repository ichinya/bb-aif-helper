import type { defineRpcContract as DefineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { delegationChoiceSchema, delegationDefaultsSchema, delegationRoleSchema, delegationStateSchema } from './model.ts';
import { requestSchema, runSchema, snapshotSchema, hostInputSchema, suggestionRequestSchema, suggestionActionSchema, suggestionsSchema, gateResultSchema, cardVisibilitySchema } from './model.ts';
import { SKIPPABLE_STEPS } from './readiness.ts';
import { CHIP_SCORING_TAG, projectTag, threadTag } from './live-updates.ts';
// The app bundle cannot import the server SDK at runtime; defineRpcContract is an identity helper.
const defineRpcContract: typeof DefineRpcContract = contract => contract;
export const delegationViewSchema = delegationStateSchema.extend({
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  children: z.array(z.object({ id: z.string(), title: z.string().nullable(), status: z.string(), providerId: z.string().nullable(), updatedAt: z.string(), worktree: z.boolean(),
    execution: z.object({ model: z.string(), reasoning: z.string().nullable() }).nullable(),
    fallback: z.object({ from: z.string(), to: z.string(), reason: z.string() }).nullable(),
    mismatch: z.string().nullable() })),
  defaults: delegationDefaultsSchema.nullable(),
  appliedDefaults: z.string().nullable(),
});
export const aifModeViewSchema = z.object({ projectId: z.string(), on: z.boolean(), configured: z.boolean().nullable() });
export type DelegationView = z.infer<typeof delegationViewSchema>;
export const chipScoringViewSchema = z.object({
  enabled: z.boolean(), source: z.enum(['catalog', 'manual']), catalogName: z.string().nullable(),
  catalogAvailable: z.boolean(), catalogNames: z.array(z.string()), manualKeySet: z.boolean(),
  lastError: z.string().nullable(), lastScoredAt: z.number().nullable(),
});
export type ChipScoringView = z.infer<typeof chipScoringViewSchema>;
const rootInput = z.object({ root: z.string().min(1).max(4096) }).strict();
export const hostContract = defineRpcContract({
  collect: { input: hostInputSchema, output: snapshotSchema, experimental_retryable: true },
  delegation: { input: z.object({ root: z.string().min(1).max(4096) }).strict(), output: delegationStateSchema, experimental_retryable: true },
  setDelegation: { input: z.object({ root: z.string().min(1).max(4096), choice: delegationChoiceSchema, role: delegationRoleSchema.optional() }).strict(), output: delegationStateSchema },
  watch: { input: z.object({ root: z.string().min(1).max(4096) }).strict(), output: z.object({ ok: z.literal(true) }) },
  unwatch: { input: z.object({ root: z.string().min(1).max(4096) }).strict(), output: z.object({ ok: z.literal(true) }) },
  savePlan: { input: z.object({ root: z.string().min(1).max(4096), threadId: z.string().regex(/^[\w-]{1,200}$/),
    seq: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(96000) }).strict(),
    output: z.object({ path: z.string() }), experimental_retryable: true },
  markPlanVerified: { input: z.object({ root: z.string().min(1).max(4096), target: z.string().min(1).max(1000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    output: z.object({ path: z.string(), verified: z.literal(true) }), experimental_retryable: false },
  createWorktree: { input: z.object({ basePath: z.string().min(1).max(4096), name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), ref: z.string().max(200).optional(), seed: z.boolean().optional() }).strict(),
    output: z.object({ root: z.string(), path: z.string(), sha: z.string() }), experimental_retryable: false },
  removeWorktree: { input: z.object({ basePath: z.string().min(1).max(4096), root: z.string().min(1).max(4096) }).strict(),
    output: z.object({ removed: z.literal(true) }), experimental_retryable: true },
  headCommit: { input: rootInput, output: z.object({ sha: z.string() }), experimental_retryable: true },
  bringBack: { input: z.object({ root: z.string().min(1).max(4096), copy: z.string().min(1).max(4096) }).strict(),
    output: z.object({ applied: z.boolean(), empty: z.boolean().optional(), partial: z.boolean().optional(), files: z.array(z.string()), error: z.string().optional() }), experimental_retryable: false },
  readBrief: { input: z.object({ path: z.string().min(1).max(4096) }).strict(), output: z.object({ text: z.string() }), experimental_retryable: true },
});
const dispatchResult = z.object({ sent: z.boolean(), message: z.string(), stale: z.literal(true).optional() });

export const hostSignals = {
  filesChanged: { payload: z.object({ root: z.string() }) },
  watchLost: { payload: z.object({ root: z.string(), reason: z.string().max(500) }) },
};
export const rpcContract = defineRpcContract({
  planDocument: { input: z.object({ threadId: z.string().min(1).max(200), text: z.string().min(1).max(96000) }).strict(),
    output: z.object({ path: z.string(), seq: z.number(), hash: z.string(), environmentId: z.string() }).nullable() },
  status: { input: requestSchema.extend({ checkUpdates: z.boolean().default(false), force: z.boolean().default(false) }), output: snapshotSchema,
    tags: input => [threadTag(input.threadId)] },
  setPreparationVisibility: { input: requestSchema.pick({ threadId: true }).extend({ visible: z.boolean() }),
    output: z.object({ visible: z.boolean() }) },
  cardVisibility: { input: cardVisibilitySchema, output: z.object({ state: z.enum(['current', 'superseded', 'hidden']) }),
    tags: input => [threadTag(input.threadId)] },
  run: { input: runSchema, output: dispatchResult.extend({ newTask: z.boolean().optional() }) },
  suggestions: { input: suggestionRequestSchema, output: suggestionsSchema,
    tags: input => [threadTag(input.threadId)] },
  dismissSuggestion: { input: suggestionActionSchema, output: z.object({ dismissed: z.literal(true) }) },
  delegation: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: delegationViewSchema,
    tags: input => [threadTag(input.threadId)] },
  setDelegation: { input: z.object({ threadId: z.string().min(1).max(200), choice: delegationChoiceSchema, role: delegationRoleSchema.optional() }).strict(), output: delegationViewSchema },
  setDelegationDefaults: { input: z.object({ threadId: z.string().min(1).max(200), action: z.enum(['from-project', 'apply', 'clear']) }).strict(), output: delegationViewSchema },
  chipScoring: { input: z.object({}).strict(), output: chipScoringViewSchema,
    tags: () => [CHIP_SCORING_TAG] },
  setChipScoring: { input: z.object({ enabled: z.boolean().optional(), source: z.enum(['catalog', 'manual']).optional(),
    catalogName: z.string().max(200).nullable().optional(), manualKey: z.string().max(500).nullable().optional() }).strict(), output: chipScoringViewSchema },
  setReadinessSkip: { input: z.object({ threadId: z.string().min(1).max(200), stepId: z.enum(SKIPPABLE_STEPS), skipped: z.boolean() }).strict(), output: z.object({ ok: z.literal(true) }) },
  runSuggestion: { input: suggestionActionSchema.extend({ fingerprint: z.string().length(64), requestId: z.string().uuid() }), output: dispatchResult.extend({
    command: z.string().optional(),
    data: z.object({ source: z.literal('aif-chat'), sourceKey: z.string(), commandId: z.string(), fingerprint: z.string(), gate: gateResultSchema.nullable() }).optional() }) },
  aifMode: { input: z.object({ threadId: z.string().min(1).max(200).optional(), projectId: z.string().min(1).max(200).optional() }).strict(), output: aifModeViewSchema, experimental_retryable: true,
    tags: (input, output) => [projectTag(output.projectId), ...(input.threadId ? [threadTag(input.threadId)] : [])] },
  setAifMode: { input: z.object({ threadId: z.string().min(1).max(200).optional(), projectId: z.string().min(1).max(200).optional(), on: z.boolean() }).strict(), output: aifModeViewSchema },
});
