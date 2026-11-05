import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner } from '../src/server/agent.js';
import { collectDay } from '../src/server/collection.js';
import { discoverRepositories } from '../src/server/discovery.js';
import { AgentFailure } from '../src/server/errors.js';
import { repositoryActivity, repositoryDetail } from '../src/server/local-git.js';
import { openStore, Store } from '../src/server/store.js';

const paths: string[] = [];
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'worklog-git-')));
  paths.push(path);
  return path;
}
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_DATE: '2026-11-05T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-11-05T12:00:00Z',
    },
  }).trim();
}
it('discovers repositories without a host or credentials and reads only the configured author', async () => {
  const root = await fixture();
  const path = join(root, 'app');
  await mkdir(path);
  git(path, 'init', '-q');
  git(path, 'config', 'user.email', 'owner@example.test');
  git(path, 'config', 'user.name', 'Owner');
  await writeFile(join(path, 'file.txt'), 'Owner change');
  git(path, 'add', 'file.txt');
  git(path, 'commit', '-qm', 'Implement validation');
  await writeFile(join(path, 'other.txt'), 'Other change');
  git(path, 'add', 'other.txt');
  git(path, '-c', 'user.email=colleague@example.test', 'commit', '-qm', 'Colleague commit');
  const repositories = await discoverRepositories(root);
  expect(repositories).toHaveLength(1);
  const records = await repositoryActivity(
    root,
    repositories[0]!,
    '2026-11-05T00:00:00Z',
    '2026-11-06T00:00:00Z',
  );
  expect(records).toHaveLength(1);
  expect(records[0]?.title).toBe('Implement validation');
  expect(records[0]?.url).toContain('/api/evidence');
  expect(await repositoryDetail(root, records[0]!)).toContain('file.txt');
  expect(
    await repositoryActivity(
      root,
      repositories[0]!,
      '2026-11-06T00:00:00Z',
      '2026-11-07T00:00:00Z',
    ),
  ).toEqual([]);
});
it('reports missing identity with a manual repair action and rejects out-of-root repositories', async () => {
  const root = await fixture();
  const path = join(root, 'app');
  await mkdir(path);
  git(path, 'init', '-q');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  try {
    await expect(
      repositoryActivity(root, { path: 'app', checkout: path }, '2026-11-05', '2026-11-06'),
    ).rejects.toThrow('config user.email');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  const outside = await fixture();
  await expect(
    repositoryActivity(root, { path: 'outside', checkout: outside }, '2026-11-05', '2026-11-06'),
  ).rejects.toThrow('outside the work folder');
});

it('gives the work-root repository a unique identity beside a same-named child', async () => {
  const base = await fixture();
  const root = join(base, 'app');
  const nested = join(root, 'app');
  await mkdir(nested, { recursive: true });
  git(root, 'init', '-q');
  git(nested, 'init', '-q');
  expect((await discoverRepositories(root)).map((item) => item.path)).toEqual(['.', 'app']);
});

it('preserves healthy local evidence and visible partial status when optional GitLab access fails', async () => {
  const root = await fixture();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'owner@example.test');
  git(root, 'config', 'user.name', 'Owner');
  git(root, 'remote', 'add', 'origin', 'https://git.example/team/app.git');
  await writeFile(join(root, 'file.txt'), 'Local work');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-qm', 'Implement local validation');
  const empty = join(root, 'sessions');
  await mkdir(empty);
  vi.stubEnv('WORKLOG_CODEX_SESSIONS_DIR', empty);
  vi.stubEnv('WORKLOG_CLAUDE_SESSIONS_DIR', empty);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 401 })),
  );
  const store = openStore(':memory:');
  store.enqueue('collect', '2026-11-05');
  const runner = AgentRunner.of({
    collect: (request) =>
      Effect.promise(async () => {
        expect(request.task.projects).toEqual([]);
        const repository = request.task.repositories?.[0];
        if (!repository) throw new Error('Expected local repository');
        const evidence = await repositoryActivity(
          root,
          repository,
          request.task.start,
          request.task.end,
        );
        return {
          result: {
            accomplishments: [
              {
                title: 'Implemented local validation',
                state: 'completed' as const,
                evidenceIds: evidence.map((item) => item.id),
              },
            ],
          },
          audit: { covered: ['repository:.', 'local-sessions'], evidence },
          agent: 'codex' as const,
          fallback: null,
        };
      }),
    report: () => Effect.fail(new AgentFailure({ message: 'Not used' })),
  });
  try {
    await Effect.runPromise(
      collectDay('collect', '2026-11-05', {
        workRoot: root,
        timezone: 'UTC',
        gitlabUrl: 'https://git.example',
        token: 'fixture',
        remoteCollection: true,
        automatic: false,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(AgentRunner, runner)),
        ),
      ),
    );
    expect(store.daily('2026-11-05').evidence).toHaveLength(1);
    expect(store.daily('2026-11-05').jobs[0]?.status).toBe('partial');
    expect(store.daily('2026-11-05').jobs[0]?.error).toContain('401');
    expect(store.coverage('2026-11-05')).toBeUndefined();
  } finally {
    store.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
