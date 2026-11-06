import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Job } from '../shared/domain.js';
import { DEFAULT_SCAN_DEPTH } from '../shared/scan-depth.js';
import { type AppConfig, isDayFinalized } from './config.js';
import { message } from './errors.js';
import type { StoreApi } from './store.js';

export function sourceWorkspace(config: AppConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([config.workRoot, config.remoteCollection ? config.gitlabUrl : 'local-git']),
    )
    .digest('hex');
}
export function dataScope(config: AppConfig): string {
  const root = sourceWorkspace(config);
  const projects =
    config.includedProjects === undefined && config.includeSharedSessions !== false
      ? root
      : createHash('sha256')
          .update(
            JSON.stringify([
              root,
              config.includedProjects === undefined
                ? null
                : [...new Set(config.includedProjects)].sort(),
              config.includeSharedSessions === true,
            ]),
          )
          .digest('hex');
  const depth = config.scanDepth ?? DEFAULT_SCAN_DEPTH;
  return depth === DEFAULT_SCAN_DEPTH
    ? projects
    : createHash('sha256')
        .update(JSON.stringify([projects, 'scanDepth', depth]))
        .digest('hex');
}
export function syncSourceScope(store: StoreApi, config: AppConfig) {
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        config.workRoot,
        config.gitlabUrl,
        config.timezone,
        config.token,
        config.remoteCollection,
        config.includedProjects,
        config.includeSharedSessions,
        config.scanDepth ?? DEFAULT_SCAN_DEPTH,
      ]),
    )
    .digest('hex');
  const previous = store.state('source_scope');
  const workspace = dataScope(config);
  if (previous !== scope || store.scope() !== workspace) {
    store.registerWorkspace({
      id: workspace,
      label:
        (config.includedProjects === undefined
          ? 'All projects'
          : `${config.includedProjects.length} selected projects${config.includeSharedSessions ? ' + shared sessions' : ''}`) +
        ((config.scanDepth ?? DEFAULT_SCAN_DEPTH) === DEFAULT_SCAN_DEPTH
          ? ''
          : ` · depth ${config.scanDepth}`),
      workRoot: config.workRoot,
      gitlabUrl: config.remoteCollection ? (config.gitlabUrl ?? null) : null,
      timezone: config.timezone,
      lastUsedAt: new Date().toISOString(),
    });
    store.setState('data_scope', workspace);
    store.invalidateCoverage();
    if (previous !== null) store.cancelQueued();
    store.setState('source_scope', scope);
    store.setState('auto_scope', '');
    store.setState('next_auto', '0');
  }
}
export function schedule(store: StoreApi, config: AppConfig, now: number) {
  if (config.automatic === false || Number(store.state('next_auto') ?? 0) > now) return;
  const today = DateTime.fromMillis(now, { zone: config.timezone });
  const day = today.toFormat('yyyy-MM-dd');
  const scope = JSON.stringify([
    config.workRoot,
    config.gitlabUrl,
    config.timezone,
    config.collectionStartDate,
  ]);
  if (store.state('auto_scope') !== scope) {
    store.setState('auto_scope', scope);
    store.setState(
      'history_start',
      config.collectionStartDate ?? today.minus({ days: 6 }).toFormat('yyyy-MM-dd'),
    );
    store.setState(
      'backfill_day',
      config.collectionStartDate ?? today.minus({ days: 6 }).toFormat('yyyy-MM-dd'),
    );
  }
  store.enqueue(randomUUID(), day, 'collect', '{}', new Date(now).toISOString());
  const start = store.state('history_start') ?? day;
  let cursor = store.state('backfill_day') ?? start;
  if (cursor < start) cursor = start;
  for (let count = 0; count < 7 && cursor < day && store.queueCount() < 10; count++) {
    const coverage = store.coverage(cursor);
    if (!coverage || !isDayFinalized(cursor, config.timezone, coverage.collectedAt))
      store.enqueue(randomUUID(), cursor, 'collect', '{}', new Date(now).toISOString());
    cursor = DateTime.fromISO(cursor, { zone: config.timezone })
      .plus({ days: 1 })
      .toFormat('yyyy-MM-dd');
  }
  store.setState('backfill_day', cursor);
  store.setState('next_auto', String(now + 30 * 60 * 1000));
}
export function createQueue(options: {
  store: StoreApi;
  config: () => Promise<AppConfig>;
  run: (job: Job, config: AppConfig, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let busy: Promise<void> | undefined;
  let stopped = false;
  let paused = false;
  let lastError: string | null = null;
  async function work() {
    let config: AppConfig;
    try {
      config = await options.config();
    } catch {
      return;
    }
    if (stopped) return;
    syncSourceScope(options.store, config);
    schedule(options.store, config, now());
    const job = options.store.claim(new Date(now()).toISOString());
    if (!job) return;
    try {
      await options.run(job, config, controller.signal);
      lastError = null;
    } catch (error) {
      if (!stopped) options.store.retry(job, message(error), now());
    }
  }
  return {
    tick(): Promise<void> {
      if (stopped || paused || busy) return busy ?? Promise.resolve();
      busy = work()
        .catch((error) => {
          lastError = message(error);
        })
        .finally(() => {
          busy = undefined;
        });
      return busy;
    },
    pause: () => {
      if (busy || paused || stopped) return false;
      paused = true;
      return true;
    },
    resume: () => {
      paused = false;
    },
    error: () => lastError,
    async stop() {
      stopped = true;
      controller.abort();
      await busy;
    },
  };
}
