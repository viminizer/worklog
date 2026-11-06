import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createQueue,
  dataScope,
  schedule,
  sourceWorkspace,
  syncSourceScope,
} from '../src/server/queue.js';
import { openStore, type StoreApi } from '../src/server/store.js';
import type { Job } from '../src/shared/domain.js';

const config = {
  workRoot: '/work',
  gitlabUrl: 'https://git.example',
  token: 'fixture',
  timezone: 'UTC',
  automatic: false,
  collectionStartDate: '2026-11-01',
};
const stores: StoreApi[] = [];
const paths: string[] = [];
function store() {
  const value = openStore(':memory:');
  stores.push(value);
  return value;
}
afterEach(async () => {
  for (const value of stores.splice(0)) value.close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function complete(database: StoreApi, job: Pick<Job, 'id' | 'day'>) {
  database.commit(job.id, job.day, {
    result: { accomplishments: [] },
    audit: { covered: [], evidence: [] },
    agent: 'codex',
    fallback: null,
  });
}
it('coalesces pending requests for the same day', () => {
  const database = store();
  expect(database.enqueue('first', '2026-11-05')).toBe('first');
  expect(database.enqueue('duplicate', '2026-11-05')).toBe('first');
  expect(database.queueCount()).toBe(1);
});
it('runs one task at a time even when ticks overlap', async () => {
  const database = store();
  database.enqueue('one', '2026-11-05');
  database.enqueue('two', '2026-11-04');
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const queue = createQueue({
    store: database,
    config: async () => config,
    run: async (job) => {
      calls++;
      entered();
      await wait;
      complete(database, job);
    },
  });
  const first = queue.tick();
  await started;
  const second = queue.tick();
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second]);
  await queue.tick();
  expect(calls).toBe(2);
  await queue.stop();
});
it('persists retry delays and stops after three attempts', async () => {
  const database = store();
  database.enqueue('one', '2026-11-05');
  let now = Date.now();
  let calls = 0;
  const queue = createQueue({
    store: database,
    config: async () => config,
    now: () => now,
    run: async () => {
      calls++;
      throw new Error('Offline.');
    },
  });
  await queue.tick();
  await queue.tick();
  expect(calls).toBe(1);
  now += 30001;
  await queue.tick();
  expect(calls).toBe(2);
  now += 60001;
  await queue.tick();
  expect(calls).toBe(3);
  expect(database.daily('2026-11-05').jobs[0]?.status).toBe('failed');
  now += 600000;
  await queue.tick();
  expect(calls).toBe(3);
  await queue.stop();
});
it('recovers a running task from disk without losing its attempt budget', async () => {
  const path = await mkdtemp(join(tmpdir(), 'worklog-queue-'));
  paths.push(path);
  const db = join(path, 'worklog.db');
  const first = openStore(db);
  first.enqueue('one', '2026-11-05');
  expect(first.claim()?.attempts).toBe(1);
  first.close();
  const reopened = openStore(db);
  try {
    expect(reopened.claim()?.attempts).toBe(2);
  } finally {
    reopened.close();
  }
});
it('schedules current work and bounded catch-up after wake, preserving the next interval', () => {
  const database = store();
  const now = Date.parse('2026-11-05T12:00:00Z');
  schedule(database, { ...config, automatic: true }, now);
  expect(database.queueCount()).toBe(5);
  expect(database.claim()?.day).toBe('2026-11-05');
  schedule(database, { ...config, automatic: true }, now + 1000);
  expect(database.queueCount()).toBe(4);
  expect(Number(database.state('next_auto'))).toBe(now + 30 * 60000);
});
it('keeps failed historical collection eligible for later automatic catch-up', () => {
  const database = store();
  database.setState('backfill_day', '2026-11-05');
  database.enqueue('one', '2026-11-01');
  for (let n = 0; n < 3; n++) {
    const job = database.claim('2099-01-01T00:00:00Z');
    if (!job) throw new Error('Expected job.');
    database.retry(job, 'Offline.', 0);
  }
  expect(database.state('backfill_day')).toBe('2026-11-01');
});
it('aborts active work on shutdown and retains it for recovery', async () => {
  const database = store();
  database.enqueue('one', '2026-11-05');
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const queue = createQueue({
    store: database,
    config: async () => config,
    run: async (_job, _config, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true }),
      );
    },
  });
  const pending = queue.tick();
  await started;
  await queue.stop();
  await pending;
  expect(database.running()?.id).toBe('one');
});
it('pauses before settings changes and cancels queued stale tasks', async () => {
  const database = store();
  database.enqueue('one', '2026-11-05');
  let calls = 0;
  const queue = createQueue({
    store: database,
    config: async () => config,
    run: async (job) => {
      calls++;
      complete(database, job);
    },
  });
  expect(queue.pause()).toBe(true);
  expect(queue.pause()).toBe(false);
  await queue.tick();
  expect(calls).toBe(0);
  database.cancelQueued();
  queue.resume();
  await queue.tick();
  expect(calls).toBe(0);
  await queue.stop();
});

it('does not expand automatic history after an older manual failure', () => {
  const database = store();
  const now = Date.parse('2026-11-05T12:00:00Z');
  schedule(database, { ...config, automatic: true }, now);
  database.cancelQueued();
  database.setState('backfill_day', '2020-01-01');
  database.setState('next_auto', '0');
  schedule(database, { ...config, automatic: true }, now + 1);
  const days = [];
  for (
    let job = database.claim('2099-01-01T00:00:00Z');
    job;
    job = database.claim('2099-01-01T00:00:00Z')
  ) {
    days.push(job.day);
    complete(database, job);
  }
  expect(days.every((day) => day >= '2026-11-01')).toBe(true);
});

it('revisits yesterday when its last coverage was before midnight', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  try {
    const database = store();
    database.enqueue('yesterday', '2026-11-04');
    complete(database, { id: 'yesterday', day: '2026-11-04' });
    schedule(
      database,
      { ...config, automatic: true, collectionStartDate: '2026-11-04' },
      Date.parse('2026-11-05T01:00:00Z'),
    );
    const queued = [];
    for (
      let job = database.claim('2099-01-01T00:00:00Z');
      job;
      job = database.claim('2099-01-01T00:00:00Z')
    ) {
      queued.push(job.day);
      database.fail(job.id, 'fixture');
    }
    expect(queued).toContain('2026-11-04');
  } finally {
    vi.useRealTimers();
  }
});
it('invalidates completeness when selected session evidence changes', () => {
  const database = store();
  const day = '2026-11-05';
  database.enqueue('one', day);
  complete(database, { id: 'one', day });
  expect(database.coverage(day)).toBeDefined();
  const item = {
    id: 'session:new',
    project: 'app',
    time: day + 'T10:00:00Z',
    action: 'assistant',
    title: 'Late evidence',
    url: '/api/evidence',
    targetType: 'codex',
    targetIid: null,
  };
  database.ingestSession(
    '/fixture',
    { offset: 1, fingerprint: 'f', cwd: '/work', modified: 1, scope: 's', consumedHash: 'h' },
    [item],
    'UTC',
  );
  expect(database.coverage(day)).toBeUndefined();
  expect(database.state('backfill_day')).toBe(day);
  database.enqueue('two', day);
  complete(database, { id: 'two', day });
  database.invalidateCoverage();
  expect(database.coverage(day)).toBeUndefined();
  expect(database.daily(day).evidence).toHaveLength(1);
});

it('scopes completeness to configuration even when settings were edited outside the UI', () => {
  const database = store();
  syncSourceScope(database, config);
  database.enqueue('one', '2026-11-05');
  complete(database, { id: 'one', day: '2026-11-05' });
  syncSourceScope(database, config);
  expect(database.coverage('2026-11-05')).toBeDefined();
  syncSourceScope(database, { ...config, workRoot: '/different-work' });
  expect(database.coverage('2026-11-05')).toBeUndefined();
  expect(database.daily('2026-11-05').jobs).toHaveLength(1);
});

it('isolates changed scan-depth records while retaining same-root privacy identity and archives', () => {
  const database = store();
  syncSourceScope(database, config);
  const original = dataScope(config);
  expect(dataScope({ ...config, scanDepth: 3 })).toBe(original);
  database.enqueue('one', '2026-11-05');
  complete(database, { id: 'one', day: '2026-11-05' });
  const changed = { ...config, scanDepth: 4 };
  syncSourceScope(database, changed);
  expect(dataScope(changed)).not.toBe(original);
  expect(sourceWorkspace(changed)).toBe(sourceWorkspace(config));
  expect(database.coverage('2026-11-05')).toBeUndefined();
  expect(database.workspaces().some((workspace) => workspace.id === original)).toBe(true);
  expect(database.state('auto_scope')).toBe('');
});
