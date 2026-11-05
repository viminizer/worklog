import { realpath } from 'node:fs/promises';
import { Effect } from 'effect';
import { AgentRunner } from './agent.js';
import { type AppConfig, configPath, dayWindow } from './config.js';
import { discoverProjects } from './discovery.js';
import { message, SourceFailure, StorageFailure } from './errors.js';
import { ingestSessions } from './sessions.js';
import { Store } from './store.js';

export const collectDay = (id: string, day: string, config: AppConfig) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const agent = yield* AgentRunner;
    const ingestion = yield* Effect.tryPromise({
      try: (signal) =>
        ingestSessions({ workRoot: config.workRoot, timezone: config.timezone, store, signal }),
      catch: (error) =>
        new SourceFailure({ message: `Session collection failed: ${message(error)}` }),
    }).pipe(
      Effect.catchTag('SourceFailure', (error) =>
        Effect.succeed({
          files: 0,
          records: 0,
          hasMore: true,
          warnings: [],
          warning: error.message,
        }),
      ),
    );
    const warning =
      'warning' in ingestion
        ? ingestion.warning
        : [
            ...ingestion.warnings,
            ...(ingestion.hasMore
              ? ['Session catch-up is incomplete; more records will be read next collection.']
              : []),
          ]
            .join(' · ')
            .slice(0, 2000) || undefined;
    const projects = yield* Effect.tryPromise({
      try: () => discoverProjects(config.workRoot, config.gitlabUrl),
      catch: () =>
        new SourceFailure({
          message: 'Cannot scan the work root. Check that the folder exists and is readable.',
        }),
    });
    const sessionEvidence = store.sessionEvidence(
      day,
      yield* Effect.tryPromise({
        try: () => realpath(config.workRoot),
        catch: () => new SourceFailure({ message: 'Cannot resolve work root.' }),
      }),
    );
    if (!projects.length && !sessionEvidence.length)
      return yield* Effect.fail(
        new SourceFailure({
          message:
            warning ??
            'No GitLab repositories or eligible local sessions found under the work root.',
        }),
      );
    const window = dayWindow(day, config.timezone);
    const result = yield* agent.collect({
      task: { projects: projects.map((project) => project.path), ...window, sessionEvidence },
      configFile: configPath,
      onAttempt: (name, fallback) => store.attempt(id, name, fallback),
    });
    yield* Effect.try({
      try: () => store.commit(id, day, { ...result, warning }),
      catch: (error) => new StorageFailure({ message: message(error) }),
    });
  });
