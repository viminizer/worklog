import { Effect } from 'effect';
import { AgentRunner } from './agent.js';
import { type AppConfig, configPath, dayWindow } from './config.js';
import { discoverProjects } from './discovery.js';
import { message, SourceFailure, StorageFailure } from './errors.js';
import { Store } from './store.js';

export const collectDay = (id: string, day: string, config: AppConfig) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const agent = yield* AgentRunner;
    const projects = yield* Effect.tryPromise({
      try: () => discoverProjects(config.workRoot, config.gitlabUrl),
      catch: () =>
        new SourceFailure({
          message: 'Cannot scan the work root. Check that the folder exists and is readable.',
        }),
    });
    if (!projects.length)
      return yield* Effect.fail(
        new SourceFailure({ message: 'No GitLab repositories found under the work root.' }),
      );
    const window = dayWindow(day, config.timezone);
    const result = yield* agent.collect({
      task: { projects: projects.map((project) => project.path), ...window },
      configFile: configPath,
      onAttempt: (name, fallback) => store.attempt(id, name, fallback),
    });
    yield* Effect.try({
      try: () => store.commit(id, day, result),
      catch: (error) => new StorageFailure({ message: message(error) }),
    });
  });
