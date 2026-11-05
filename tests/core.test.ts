import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentRunner, validateResult } from '../src/server/agent.js';
import { dayWindow } from '../src/server/config.js';
import { discoverProjects, projectFromRemote } from '../src/server/discovery.js';
import { AgentFailure, SourceFailure } from '../src/server/errors.js';
import { GitLab } from '../src/server/gitlab.js';
import { acquireInstance } from '../src/server/instance.js';
import { type Execute, execute } from '../src/server/process.js';
import { openStore } from '../src/server/store.js';
import type { Audit, Evidence } from '../src/shared/domain.js';

const evidence: Evidence = {
  id: 'event:1',
  project: 'team/app',
  time: '2026-11-05T03:00:00.000Z',
  action: 'merged',
  title: 'Ship sign-in',
  url: 'https://git.example/team/app/-/merge_requests/1',
  targetType: 'MergeRequest',
  targetIid: 1,
};
const result = {
  accomplishments: [
    { title: 'Shipped sign-in', state: 'completed' as const, evidenceIds: ['event:1'] },
  ],
};
const audit: Audit = { covered: ['team/app'], evidence: [evidence] };
const paths: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'worklog-test-'));
  paths.push(path);
  return path;
}
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('source scope', () => {
  it('normalizes nested GitLab remotes and rejects other hosts', () => {
    expect(projectFromRemote('git@git.example:team/nested/app.git', 'https://git.example')).toBe(
      'team/nested/app',
    );
    expect(projectFromRemote('ssh://git@git.example/team/app.git', 'https://git.example')).toBe(
      'team/app',
    );
    expect(projectFromRemote('https://git.example/team/app.git', 'https://git.example')).toBe(
      'team/app',
    );
    expect(projectFromRemote('https://github.com/team/app.git', 'https://git.example')).toBeNull();
  });
  it('discovers nested repositories and deduplicates clones', async () => {
    const root = await temp();
    for (const name of ['a', 'b']) {
      const path = join(root, name);
      await mkdir(path);
      execFileSync('git', ['init', '-q', path]);
      execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'git@git.example:team/app.git']);
    }
    expect(await discoverProjects(root, 'https://git.example')).toHaveLength(1);
  });
  it('handles timezone boundaries and daylight-saving days', () => {
    const { start, end } = dayWindow('2026-11-01', 'America/New_York');
    expect((Date.parse(end) - Date.parse(start)) / 3600000).toBe(25);
    expect(() => dayWindow('2026-02-30', 'UTC')).toThrow();
  });
});

it('paginates GitLab, filters actor and exact time, and keeps evidence links', async () => {
  const calls: string[] = [];
  const record = {
    id: 1,
    author_id: 7,
    created_at: evidence.time,
    action_name: 'merged',
    target_title: 'Sign-in',
    target_type: 'MergeRequest',
    target_iid: 1,
  };
  const request: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response(
      JSON.stringify(
        url.includes('page=2')
          ? []
          : Array.from({ length: 100 }, (_, index) => ({
              ...record,
              id: index + 1,
              author_id: index === 0 ? 7 : 8,
            })),
      ),
    );
  };
  const gitlab = new GitLab('https://git.example', 'not-a-real-token', request);
  const records = await gitlab.activity(
    'team/app',
    '2026-11-05T00:00:00.000Z',
    '2026-11-06T00:00:00.000Z',
    7,
  );
  expect(calls).toHaveLength(2);
  expect(records).toHaveLength(1);
  expect(records[0]?.url).toBe('https://git.example/team/app/-/merge_requests/1');
});
it('does not follow authentication redirects', async () => {
  const gitlab = new GitLab('https://git.example', 'secret', async (_url, options) => {
    expect(options?.redirect).toBe('error');
    return new Response('', { status: 401 });
  });
  await expect(gitlab.identity()).rejects.toBeInstanceOf(SourceFailure);
});

function request() {
  return {
    task: { projects: ['team/app'], start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' },
    configFile: '/unused/config.json',
    onAttempt: () => {},
  };
}
async function succeed(command: Parameters<Execute>[0]) {
  await writeFile(join(command.cwd, 'audit.json'), JSON.stringify(audit));
  if (command.executable === 'codex')
    await writeFile(join(command.cwd, 'output.json'), JSON.stringify(result));
  return JSON.stringify({ structured_output: result });
}
it('automatically falls back to Claude after Codex fails and cleans workspaces', async () => {
  const commands: string[] = [];
  const directories: string[] = [];
  const runner = makeAgentRunner(async (command) => {
    commands.push(command.executable);
    directories.push(command.cwd);
    if (command.executable === 'codex') throw new AgentFailure({ message: 'Usage limit reached.' });
    return succeed(command);
  });
  const value = await Effect.runPromise(runner.collect(request()));
  expect(commands).toEqual(['codex', 'claude']);
  expect(value.agent).toBe('claude');
  expect(value.fallback).toContain('Usage limit');
  for (const path of directories) await expect(readFile(join(path, 'task.json'))).rejects.toThrow();
});
it('does not switch agents for GitLab access errors', async () => {
  const commands: string[] = [];
  const runner = makeAgentRunner(async (command) => {
    commands.push(command.executable);
    await writeFile(
      join(command.cwd, 'audit.json'),
      JSON.stringify({ ...audit, sourceError: 'GitLab returned HTTP 403.' }),
    );
    throw new AgentFailure({ message: 'Agent stopped.' });
  });
  await expect(Effect.runPromise(runner.collect(request()))).rejects.toThrow('403');
  expect(commands).toEqual(['codex']);
});
it('rejects invented evidence and incomplete coverage', () => {
  expect(() => validateResult(result, { ...audit, evidence: [] }, ['team/app'])).toThrow();
  expect(() => validateResult(result, { ...audit, covered: [] }, ['team/app'])).toThrow();
});
it('surfaces failure when both agents return invalid output', async () => {
  const called: string[] = [];
  const invalid = makeAgentRunner(async (command) => {
    called.push(command.executable);
    await succeed(command);
    await writeFile(join(command.cwd, 'output.json'), '{}');
    return '{}';
  });
  await expect(Effect.runPromise(invalid.collect(request()))).rejects.toThrow('invalid output');
  expect(called).toEqual(['codex', 'claude']);
});
it('commits evidence idempotently and retains the previous record after failure', () => {
  const store = openStore(':memory:');
  try {
    for (const id of ['one', 'two']) {
      store.enqueue(id, '2026-11-05');
      store.commit(id, '2026-11-05', { result, audit, agent: 'codex', fallback: null });
    }
    expect(store.daily('2026-11-05').evidence).toHaveLength(1);
    expect(store.daily('2026-11-05').accomplishments).toHaveLength(1);
    store.enqueue('three', '2026-11-05');
    store.fail('three', 'Source failed.');
    expect(store.daily('2026-11-05').accomplishments).toHaveLength(1);
  } finally {
    store.close();
  }
});
it('marks interrupted collection jobs as failed after reopening', async () => {
  const path = join(await temp(), 'worklog.db');
  const first = openStore(path);
  first.enqueue('interrupted', '2026-11-05');
  first.close();
  const reopened = openStore(path);
  try {
    expect(reopened.daily('2026-11-05').jobs[0]?.status).toBe('failed');
  } finally {
    reopened.close();
  }
});
it('times out a child process and reports failure', async () => {
  await expect(
    execute(
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 30,
        input: '',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('timed out');
});

it('keeps cited evidence available across daily pages', () => {
  const store = openStore(':memory:');
  try {
    const records = Array.from({ length: 1001 }, (_, index) => ({
      ...evidence,
      id: `event:${index}`,
      time: new Date(Date.parse(evidence.time) + index * 1000).toISOString(),
    }));
    store.enqueue('large', '2026-11-05');
    store.commit('large', '2026-11-05', {
      result: {
        accomplishments: [
          { title: 'Shipped sign-in', state: 'completed', evidenceIds: ['event:0'] },
        ],
      },
      audit: { ...audit, evidence: records },
      agent: 'codex',
      fallback: null,
    });
    const page = store.daily('2026-11-05');
    expect(page.evidence).toHaveLength(100);
    expect(page.evidence.some((record) => record.id === 'event:0')).toBe(false);
    expect(page.supportingEvidence[0]?.id).toBe('event:0');
    expect(page.hasMore).toBe(true);
    expect(store.daily('2026-11-05', 1000).evidence).toHaveLength(1);
  } finally {
    store.close();
  }
});

it('compares event instants rather than ISO timestamp spelling', async () => {
  const timestamps = [
    '2026-11-05T00:00:00+00:00',
    '2026-11-05T09:00:00+09:00',
    '2026-11-06T00:00:00Z',
  ];
  const gitlab = new GitLab(
    'https://git.example',
    'fixture-only',
    async () =>
      new Response(
        JSON.stringify(
          timestamps.map((created_at, index) => ({
            id: index,
            created_at,
            author_id: 7,
            action_name: 'pushed',
            target_title: 'work',
            target_type: null,
            target_iid: null,
          })),
        ),
      ),
  );
  const records = await gitlab.activity(
    'team/app',
    '2026-11-05T00:00:00.000Z',
    '2026-11-06T00:00:00.000Z',
    7,
  );
  expect(records).toHaveLength(2);
  expect(records.every((record) => record.time === '2026-11-05T00:00:00.000Z')).toBe(true);
});

it('prevents a second instance from recovering a live job', async () => {
  const directory = await temp();
  const lockPath = join(directory, 'instance.db');
  const release = acquireInstance(lockPath);
  const store = openStore(join(directory, 'worklog.db'));
  try {
    store.enqueue('live', '2026-11-05');
    store.attempt('live', 'codex', null);
    expect(() => acquireInstance(lockPath)).toThrow('Another Worklog instance');
    expect(store.daily('2026-11-05').jobs[0]?.status).toBe('running');
  } finally {
    store.close();
    release();
  }
  const releaseAgain = acquireInstance(lockPath);
  releaseAgain();
});
