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
import { localCommitId, repositoryActivity, repositoryDetail } from '../src/server/local-git.js';
import { discoverRepositoryGroups } from '../src/server/repository-groups.js';
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
  const branch = join(root, 'branch');
  git(root, 'worktree', 'add', '-qb', 'fixture-branch', branch);
  git(root, 'config', 'extensions.worktreeConfig', 'true');
  git(branch, 'config', '--worktree', 'user.email', '');
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
    expect(store.daily('2026-11-05').jobs[0]?.error).toContain('user.email');
    expect(store.coverage('2026-11-05')).toBeUndefined();
  } finally {
    store.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

it('groups worktrees by common Git directory and includes branches and worktree-specific author identities once', async () => {
  const root = await fixture();
  const main = join(root, 'main');
  const branch = join(root, 'branch');
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'owner@example.test');
  git(main, 'config', 'user.name', 'Owner');
  await writeFile(join(main, 'a.txt'), 'main change');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-qm', 'Main work');
  git(main, 'worktree', 'add', '-qb', 'feature', branch);
  git(main, 'config', 'extensions.worktreeConfig', 'true');
  git(branch, 'config', '--worktree', 'user.email', 'alternate@example.test');
  await writeFile(join(branch, 'b.txt'), 'branch change');
  git(branch, 'add', 'b.txt');
  git(branch, 'commit', '-qm', 'Branch work');
  const groups = await discoverRepositoryGroups(root);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.checkout).toBe(main);
  expect(groups[0]?.members).toHaveLength(2);
  expect(groups[0]?.authorEmails.sort()).toEqual(['alternate@example.test', 'owner@example.test']);
  const records = await repositoryActivity(
    root,
    groups[0]!,
    '2026-11-05T00:00:00Z',
    '2026-11-06T00:00:00Z',
  );
  expect(records).toHaveLength(2);
  expect(new Set(records.map((item) => item.id)).size).toBe(2);
  const broken = join(root, 'broken');
  await mkdir(broken);
  await writeFile(join(broken, '.git'), 'gitdir: /nonexistent-worklog-fixture\n');
  const withBroken = await discoverRepositoryGroups(root);
  expect(withBroken).toHaveLength(2);
  expect(withBroken.find((group) => group.path === 'broken')?.checkouts[0]?.error).toContain(
    'metadata',
  );
});
it('deduplicates previously collected worktree commits without deleting old citations or re-churning snapshots', () => {
  const store = openStore(':memory:');
  const commit = 'a'.repeat(40);
  const main = '/fixture/main';
  const branch = '/fixture/branch';
  const other = '/fixture/other';
  const record = {
    id: 'old-branch',
    project: 'branch',
    time: '2026-11-05T12:00:00Z',
    action: 'committed',
    title: 'Implemented validation',
    excerpt: 'Inspected commit detail',
    url: '/api/evidence',
    targetType: 'local-commit',
    targetIid: null,
    localGit: { checkout: branch, commit, authorEmail: 'owner@example.test', inspected: true },
  };
  try {
    const mainRecord = {
      ...record,
      id: localCommitId(main, commit),
      project: 'main',
      excerpt: 'Basic commit',
      localGit: { ...record.localGit, checkout: main, inspected: false },
    };
    const otherRecord = {
      ...record,
      id: 'old-other',
      url: '/api/evidence?id=old-other',
      excerpt: 'Other inspected representation',
      localGit: { ...record.localGit, checkout: other },
    };
    store.enqueue('old', '2026-11-05');
    store.commit('old', '2026-11-05', {
      result: {
        accomplishments: [
          {
            title: record.title,
            state: 'completed',
            evidenceIds: [record.id, mainRecord.id, otherRecord.id],
          },
        ],
      },
      audit: { covered: [], evidence: [record, mainRecord, otherRecord] },
      agent: 'codex',
      fallback: null,
    });
    expect(store.evidencePage('2026-11-05').total).toBe(3);
    const group = { path: 'main', checkout: main, members: [main, branch, other] };
    store.setState('backfill_day', '2026-11-06');
    store.reconcileRepositories([group]);
    expect(store.state('backfill_day')).toBe('2026-11-05');
    const canonical = store.evidencePage('2026-11-05').items[0];
    expect(store.evidencePage('2026-11-05').total).toBe(1);
    expect(canonical?.id).not.toBe(record.id);
    expect(canonical?.project).toBe('main');
    expect(store.evidence(record.id)?.canonicalId).toBe(canonical?.id);
    expect(store.daily('2026-11-05').supportingEvidence[0]?.id).toBe(record.id);
    const material = store.reportMaterial('2026-11-05', '2026-11-05', 'UTC');
    expect(material.accomplishments[0]?.evidenceIds).toEqual([canonical?.id]);
    expect(material.evidence.map((item) => item.id)).toEqual([canonical?.id]);
    const snapshot = store.reportSnapshot('2026-11-05', '2026-11-05', 'UTC');
    store.setState('backfill_day', '2026-11-06');
    store.reconcileRepositories([group]);
    expect(store.reportSnapshot('2026-11-05', '2026-11-05', 'UTC')).toBe(snapshot);
    expect(store.state('backfill_day')).toBe('2026-11-06');
  } finally {
    store.close();
  }
});
