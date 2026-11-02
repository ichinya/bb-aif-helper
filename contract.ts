import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { requestSchema, runSchema, snapshotSchema, hostInputSchema } from './model.ts';
export const hostContract = defineRpcContract({
  collect: { input: hostInputSchema, output: snapshotSchema, experimental_retryable: true },
});
export const rpcContract = defineRpcContract({
  status: { input: requestSchema.extend({ checkUpdates: z.boolean().default(false) }), output: snapshotSchema },
  run: { input: runSchema, output: z.object({ sent: z.boolean(), message: z.string() }) },
});
