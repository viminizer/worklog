import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { DateTime } from 'luxon';
import type { ReportMaterial } from '../shared/domain.js';
import { AgentRunner } from './agent.js';
import { configPath, dayWindow } from './config.js';
import { message, SourceFailure, StorageFailure } from './errors.js';
import { Store } from './store.js';

export const ReportRequestSchema = Schema.Struct({
  kind: Schema.Literals(['daily', 'weekly']),
  fromDay: Schema.String,
  toDay: Schema.String,
});
export type ReportRequest = typeof ReportRequestSchema.Type;
export const reportId = (input: ReportRequest, scope = 'legacy') =>
  `${scope}:${input.kind}:${input.fromDay}:${input.toDay}`;
export function validateRange(
  input: unknown,
  timezone: string,
  allowFuture = false,
): ReportRequest {
  let result: ReportRequest;
  try {
    result = Schema.decodeUnknownSync(ReportRequestSchema)(input);
  } catch {
    throw new Error('Choose a report type and valid from/through dates.');
  }
  dayWindow(result.fromDay, timezone);
  dayWindow(result.toDay, timezone);
  const start = DateTime.fromISO(result.fromDay, { zone: timezone });
  const end = DateTime.fromISO(result.toDay, { zone: timezone });
  if (result.toDay < result.fromDay || end.diff(start, 'days').days > 30)
    throw new Error('Choose a report range of 1–31 days in chronological order.');
  if (result.kind === 'daily' && result.fromDay !== result.toDay)
    throw new Error('Daily reports cover one date.');
  if (!allowFuture && result.toDay > DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd'))
    throw new Error('Reports cannot include future dates.');
  return result;
}
export function reportInputHash(input: ReportRequest, material: ReportMaterial) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        input,
        evidence: material.evidence,
        accomplishments: material.accomplishments,
        warnings: material.warnings,
      }),
    )
    .digest('hex');
}
export const generateReport = (
  jobId: string,
  input: ReportRequest,
  timezone: string,
  force: boolean,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const agent = yield* AgentRunner;
    const material = yield* Effect.try({
      try: () => store.reportMaterial(input.fromDay, input.toDay, timezone),
      catch: (error) => new SourceFailure({ message: message(error) }),
    });
    if (!material.evidence.length)
      return yield* Effect.fail(
        new SourceFailure({ message: 'No stored activity in this range. Collect activity first.' }),
      );
    const id = reportId(input, store.scope());
    const sourceRevision = store.reportSnapshot(input.fromDay, input.toDay, timezone);
    const inputHash = reportInputHash(input, material);
    if (!force && store.report(id)?.inputHash === inputHash) {
      store.completeUnchanged(jobId, id, sourceRevision);
      return;
    }
    const result = yield* agent.report({
      task: { projects: [], start: input.fromDay, end: input.toDay, reportMaterial: material },
      configFile: configPath,
      onAttempt: (name, fallback) => store.attempt(jobId, name, fallback),
    });
    yield* Effect.try({
      try: () =>
        store.saveDraft({
          jobId,
          id,
          ...input,
          draft: result.result,
          inputHash,
          sourceRevision,
          warnings: material.warnings,
          agent: result.agent,
          fallback: result.fallback,
        }),
      catch: (error) => new StorageFailure({ message: message(error) }),
    });
  });
