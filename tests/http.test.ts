import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createReportStore } from '../src/server/report-store.js';

it('serves protected local APIs, saves split UTF-8 settings, and keeps credentials private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklog-http-'));
  const work = join(directory, '업무');
  await mkdir(work);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      WORKLOG_DATA_DIR: directory,
      WORKLOG_CONFIG: join(directory, 'config.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup timed out: ' + errors)), 10000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Worklog:')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('exit', () => {
        clearTimeout(timeout);
        reject(new Error('Server exited: ' + errors));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    expect((await (await fetch(url + '/api/status')).json()).configured).toBe(false);
    const input = {
      workRoot: work,
      gitlabUrl: 'https://git.example',
      token: 'fixture-private-token',
      timezone: 'Asia/Seoul',
      automatic: false,
      collectionStartDate: '2026-11-01',
    };
    const data = Buffer.from(JSON.stringify(input));
    const split = data.indexOf(Buffer.from('업')) + 1;
    const reply = await new Promise<string>((resolve, reject) => {
      const req = request(
        url + '/api/settings',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk.toString()));
          res.on('end', () => resolve(text));
        },
      );
      req.on('error', reject);
      req.write(data.subarray(0, split));
      setTimeout(() => req.end(data.subarray(split)), 10);
    });
    const status = JSON.parse(reply);
    expect(status.configured).toBe(true);
    expect(reply).not.toContain('fixture-private-token');
    const saved = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    expect(saved.workRoot).toContain('업무');
    expect(saved.token).toBe(input.token);
    const rejected = await fetch(url + '/api/settings', {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, token: 'changed' }),
    });
    expect(rejected.status).toBe(403);
    const fixtureDb = new Database(join(directory, 'worklog.db'));
    fixtureDb
      .prepare('INSERT INTO coverage(day,collectedAt) VALUES(?,?)')
      .run('2026-11-01', '2026-11-02T00:00:00Z');
    fixtureDb.prepare('INSERT INTO activity(id,day,data,scope) VALUES(?,?,?,?)').run(
      'fixture-preserved',
      '2026-11-01',
      JSON.stringify({
        id: 'fixture-preserved',
        project: 'app',
        time: '2026-11-01T12:00:00Z',
        action: 'worked',
        title: 'Existing work',
        url: 'https://git.example/app',
        targetType: null,
        targetIid: null,
      }),
      status.workspaceId,
    );
    const reportStore = createReportStore(fixtureDb);
    reportStore.saveDraft({
      scope: status.workspaceId,
      jobId: 'fixture-report',
      id: 'daily:2026-11-01:2026-11-01',
      kind: 'daily',
      fromDay: '2026-11-01',
      toDay: '2026-11-01',
      draft: { text: 'Fixture draft.', evidenceIds: ['fixture-preserved'] },
      inputHash: 'fixture',
      sourceRevision: reportStore.reportSnapshot('2026-11-01', '2026-11-01', 'Asia/Seoul'),
      warnings: [],
      agent: 'codex',
      fallback: null,
    });
    fixtureDb.close();
    const update = await fetch(url + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, token: '', timezone: 'UTC' }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).lastCollectedAt).toBeNull();
    expect((await (await fetch(url + '/api/day?day=2026-11-01')).json()).evidence).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).token).toBe(
      input.token,
    );
    expect((await fetch(url + '/api/day?day=not-a-date')).status).toBe(400);
    const report = await (
      await fetch(url + '/api/report?kind=daily&fromDay=2026-11-01&toDay=2026-11-01')
    ).json();
    expect(report.stale).toBe(true);
    const text = '업무'.repeat(10000);
    const edit = { id: report.report.id, text, editVersion: 0, baseDraftVersion: 1 };
    const savedEdit = await fetch(url + '/api/report/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    });
    expect(savedEdit.status).toBe(200);
    expect((await savedEdit.json()).report.edited).toBe(text);
    const conflict = await fetch(url + '/api/report/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...edit, text: 'stale overwrite' }),
    });
    expect(conflict.status).toBe(409);
    const empty = await fetch(url + '/api/report/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'daily', fromDay: '2026-11-02', toDay: '2026-11-02' }),
    });
    expect(empty.status).toBe(400);
    const localOnly = await fetch(url + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workRoot: work, timezone: 'UTC', automatic: false }),
    });
    expect(localOnly.status).toBe(200);
    expect((await localOnly.json()).remoteCollection).toBe(false);
    const localSettings = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    expect(localSettings.gitlabUrl).toBeUndefined();
    expect(localSettings.token).toBeUndefined();
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
