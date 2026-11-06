import { realpath } from 'node:fs/promises';
import { Effect } from 'effect';
import type { Project } from '../shared/domain.js';
import { AgentRunner } from './agent.js';
import { type AppConfig, configPath, dayWindow } from './config.js';
import { discoverProjects } from './discovery.js';
import { message, SourceFailure, StorageFailure } from './errors.js';
import { GitLab } from './gitlab.js';
import { sourceWorkspace } from './queue.js';
import { discoverRepositoryGroups } from './repository-groups.js';
import { ingestSessions } from './sessions.js';
import { Store } from './store.js';

export const collectDay = (id: string, day: string, config: AppConfig) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const agent = yield* AgentRunner;
    const allRepositories = yield* Effect.tryPromise({
      try: () => discoverRepositoryGroups(config.workRoot),
      catch: (error) => new SourceFailure({ message: message(error) }),
    });
    const included = new Set(config.includedProjects);
    const repositories = allRepositories.filter(
      (group) => config.includedProjects === undefined || included.has(group.id),
    );
    const ingestion = yield* Effect.tryPromise({
      try: (signal) =>
        ingestSessions({
          workRoot: config.workRoot,
          timezone: config.timezone,
          store,
          signal,
          workspace: sourceWorkspace(config),
          includeSharedSessions:
            config.includedProjects === undefined
              ? config.includeSharedSessions !== false
              : config.includeSharedSessions === true,
          repositoryRoots: allRepositories.flatMap((group) =>
            group.members.map((checkout) => ({
              checkout,
              included: config.includedProjects === undefined || included.has(group.id),
              project: group.path,
            })),
          ),
        }),
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
    const memberWarnings = repositories.flatMap((group) =>
      group.authorEmails.length
        ? group.checkouts
            .filter((checkout) => checkout.error)
            .map((checkout) => `${checkout.path}: ${checkout.error}`)
        : [],
    );
    store.reconcileRepositories(repositories);
    let remoteWarning: string | undefined;
    let projects: Project[] = [];
    if (config.remoteCollection && config.gitlabUrl) {
      const discovery = yield* Effect.tryPromise({
        try: () => discoverProjects(config.workRoot, config.gitlabUrl as string, repositories),
        catch: () =>
          new SourceFailure({
            message:
              'Cannot discover optional GitLab projects. Check repository remotes, or disable optional GitLab collection.',
          }),
      }).pipe(
        Effect.map((projects) => ({ projects, warning: undefined as string | undefined })),
        Effect.catchTag('SourceFailure', (error) =>
          Effect.succeed({ projects: [] as Project[], warning: error.message }),
        ),
      );
      projects = discovery.projects;
      remoteWarning = discovery.warning;
    }
    const sessionEvidence = store.sessionEvidence(
      day,
      yield* Effect.tryPromise({
        try: () => realpath(config.workRoot),
        catch: () => new SourceFailure({ message: 'Cannot resolve work root.' }),
      }),
    );
    if (!repositories.length && !sessionEvidence.length)
      return yield* Effect.fail(
        new SourceFailure({
          message:
            warning ?? 'No Git repositories or eligible local sessions found under the work root.',
        }),
      );
    let userId: number | undefined;
    if (projects.length) {
      const access = yield* Effect.tryPromise({
        try: () => new GitLab(config.gitlabUrl as string, config.token as string).identity(),
        catch: (error) =>
          error instanceof SourceFailure
            ? error
            : new SourceFailure({
                message:
                  'Cannot verify optional GitLab access. Check the network and saved token, or disable remote collection.',
              }),
      }).pipe(
        Effect.map((id) => ({ id, warning: undefined as string | undefined })),
        Effect.catchTag('SourceFailure', (error) =>
          Effect.succeed({ id: undefined, warning: error.message }),
        ),
      );
      userId = access.id;
      remoteWarning = access.warning;
      if (remoteWarning) projects = [];
    }
    const window = dayWindow(day, config.timezone);
    const result = yield* agent.collect({
      task: {
        repositories,
        projects: projects.map((project) => project.path),
        ...window,
        sessionEvidence,
        userId,
      },
      configFile: configPath,
      onAttempt: (name, fallback) => store.attempt(id, name, fallback),
    });
    yield* Effect.try({
      try: () =>
        store.commit(id, day, {
          ...result,
          warning:
            [warning, remoteWarning, ...memberWarnings, ...(result.audit.warnings ?? [])]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 4000) || undefined,
        }),
      catch: (error) => new StorageFailure({ message: message(error) }),
    });
  });
