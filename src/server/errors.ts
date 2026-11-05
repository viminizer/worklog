import { Data } from 'effect';
export class AgentFailure extends Data.TaggedError('AgentFailure')<{ message: string }> {}
export class SourceFailure extends Data.TaggedError('SourceFailure')<{ message: string }> {}
export class StorageFailure extends Data.TaggedError('StorageFailure')<{ message: string }> {}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
