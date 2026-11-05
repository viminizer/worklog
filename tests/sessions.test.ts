import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ingestSessions } from '../src/server/sessions.js';
import { openStore, type StoreApi } from '../src/server/store.js';

const resources: Array<{ path: string; store: StoreApi }> = [];
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'worklog-sessions-')));
  const workRoot = join(path, 'work');
  const codexDir = join(path, 'codex');
  const claudeDir = join(path, 'claude');
  for (const directory of [workRoot, codexDir, claudeDir]) await mkdir(directory);
  const store = openStore(':memory:');
  resources.push({ path, store });
  return { path, workRoot, codexDir, claudeDir, store, timezone: 'Asia/Seoul' };
}
afterEach(async () => {
  for (const { path, store } of resources.splice(0)) {
    store.close();
    await rm(path, { recursive: true, force: true });
  }
});
const jsonl = (...values: unknown[]) =>
  `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
const header = (cwd: string, originator = 'codex_cli_rs') => ({
  type: 'session_meta',
  payload: { cwd, id: 'session-one', originator },
});
const codexMessage = (text: string, timestamp = '2026-11-04T16:00:00Z') => ({
  type: 'response_item',
  timestamp,
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
const claudeMessage = (cwd: string, text: string, uuid = 'entry-one') => ({
  type: 'user',
  cwd,
  uuid,
  sessionId: 'claude-one',
  timestamp: '2026-11-05T01:00:00Z',
  message: { role: 'user', content: text },
});

it('ingests both providers under the work root and preserves source references', async () => {
  const options = await fixture();
  await writeFile(
    join(options.codexDir, 'one.jsonl'),
    jsonl(header(options.workRoot), codexMessage('Implemented sign-in.')),
  );
  await writeFile(
    join(options.claudeDir, 'two.jsonl'),
    jsonl(claudeMessage(options.workRoot, 'Please review the sign-in changes.')),
  );
  const result = await ingestSessions(options);
  expect(result.records).toBe(2);
  const evidence = options.store.daily('2026-11-05').evidence;
  expect(evidence).toHaveLength(2);
  expect(evidence.map((item) => item.session?.provider).sort()).toEqual(['claude', 'codex']);
  expect(evidence.every((item) => item.url.startsWith('/api/evidence?id='))).toBe(true);
});
it('advances byte offsets without duplicating UTF-8 messages on append', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('작업 완료 🎉')));
  await ingestSessions(options);
  const position = options.store.sessionCursor(file)?.offset;
  expect((await ingestSessions(options)).records).toBe(0);
  await appendFile(file, jsonl(codexMessage('Added checks.')));
  expect((await ingestSessions(options)).records).toBe(1);
  expect(options.store.sessionCursor(file)?.offset).toBeGreaterThan(position ?? 0);
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(2);
});
it('retains an incomplete final JSON entry and reads it after completion', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  const complete = JSON.stringify(codexMessage('Finished the work.'));
  await writeFile(file, jsonl(header(options.workRoot)) + complete.slice(0, 30));
  expect((await ingestSessions(options)).records).toBe(0);
  await appendFile(file, complete.slice(30) + '\n');
  expect((await ingestSessions(options)).records).toBe(1);
});
it('supports a valid final entry without a newline', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot)) + JSON.stringify(codexMessage('Done.')));
  expect((await ingestSessions(options)).records).toBe(1);
  await appendFile(file, '\n' + jsonl(codexMessage('More work.')));
  expect((await ingestSessions(options)).records).toBe(1);
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(2);
});
it('excludes unrelated roots, sidechains, and Worklog automation', async () => {
  const options = await fixture();
  const outside = options.workRoot + '-personal';
  await mkdir(outside);
  await writeFile(
    join(options.codexDir, 'outside.jsonl'),
    jsonl(header(outside), codexMessage('Private personal work.')),
  );
  await writeFile(
    join(options.codexDir, 'automated.jsonl'),
    jsonl(header(options.workRoot, 'worklog'), codexMessage('Collected records.')),
  );
  await writeFile(
    join(options.claudeDir, 'sidechain.jsonl'),
    jsonl({ ...claudeMessage(options.workRoot, 'Subagent duplicate.'), isSidechain: true }),
  );
  await ingestSessions(options);
  expect(options.store.daily('2026-11-05').evidence).toEqual([]);
});
it('resolves symlinks and excludes later messages after leaving the work root', async () => {
  const options = await fixture();
  const outside = join(options.path, 'outside');
  await mkdir(outside);
  await symlink(outside, join(options.workRoot, 'outside-link'));
  await writeFile(
    join(options.codexDir, 'symlink.jsonl'),
    jsonl(header(join(options.workRoot, 'outside-link')), codexMessage('Not work.')),
  );
  await writeFile(
    join(options.codexDir, 'moved.jsonl'),
    jsonl(
      header(options.workRoot),
      codexMessage('Work.'),
      { type: 'turn_context', payload: { cwd: outside } },
      codexMessage('Personal.'),
    ),
  );
  await ingestSessions(options);
  expect(options.store.daily('2026-11-05').evidence.map((item) => item.title)).toEqual(['Work.']);
});
it('treats replaced files as a new generation while retaining old evidence', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('First generation.')));
  await ingestSessions(options);
  const replacement = join(options.path, 'replacement');
  await writeFile(replacement, jsonl(header(options.workRoot), codexMessage('Second generation.')));
  await rename(replacement, file);
  await ingestSessions(options);
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(2);
});
it('does not commit a cursor when a complete line is malformed', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('Valid.')) + '{broken}\n');
  expect((await ingestSessions(options)).warnings.length).toBeGreaterThan(0);
  expect(options.store.sessionCursor(file)).toBeUndefined();
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(0);
});
it('does not commit session data after cancellation', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('Work.')));
  const controller = new AbortController();
  controller.abort();
  await expect(ingestSessions({ ...options, signal: controller.signal })).rejects.toThrow();
  expect(options.store.sessionCursor(file)).toBeUndefined();
});

it('reindexes unchanged session files when the reporting timezone changes', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('Work.')));
  await ingestSessions(options);
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(1);
  await ingestSessions({ ...options, timezone: 'UTC' });
  expect(options.store.daily('2026-11-05').evidence).toHaveLength(0);
  expect(options.store.daily('2026-11-04').evidence).toHaveLength(1);
});
it('does not send evidence from an old work root into a new scope', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('Work.')));
  await ingestSessions(options);
  expect(options.store.sessionEvidence('2026-11-05', options.workRoot)).toHaveLength(1);
  expect(options.store.sessionEvidence('2026-11-05', join(options.path, 'other'))).toHaveLength(0);
});

it('recovers growing in-place rewrites even when metadata and inode stay the same', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('First.')));
  await ingestSessions(options);
  await writeFile(
    file,
    jsonl(
      header(options.workRoot),
      codexMessage('A longer replacement message with the same metadata.'),
      codexMessage('Additional work.'),
    ),
  );
  const result = await ingestSessions(options);
  expect(result.warnings).toEqual([]);
  expect(
    options.store.daily('2026-11-05').evidence.some((item) => item.title === 'Additional work.'),
  ).toBe(true);
});
it('continues healthy sessions when another file is malformed', async () => {
  const options = await fixture();
  await writeFile(
    join(options.codexDir, 'bad.jsonl'),
    jsonl(header(options.workRoot)) + '{broken}\n',
  );
  await writeFile(
    join(options.claudeDir, 'good.jsonl'),
    jsonl(claudeMessage(options.workRoot, 'Healthy source.')),
  );
  const result = await ingestSessions(options);
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(options.store.daily('2026-11-05').evidence[0]?.title).toBe('Healthy source.');
});
it('reads complete metadata larger than128KB without silently losing sessions', async () => {
  const options = await fixture();
  const metadata = { ...header(options.workRoot), padding: 'x'.repeat(140000) };
  await writeFile(
    join(options.codexDir, 'large.jsonl'),
    jsonl(metadata, codexMessage('Found after large metadata.')),
  );
  const result = await ingestSessions(options);
  expect(result.warnings).toEqual([]);
  expect(result.records).toBe(1);
});

it('does not replay an already collected session prefix into another workspace', async () => {
  const options = await fixture();
  const file = join(options.codexDir, 'one.jsonl');
  options.store.setState('data_scope', 'old');
  await writeFile(file, jsonl(header(options.workRoot), codexMessage('Old workspace text.')));
  await ingestSessions(options);
  options.store.setState('data_scope', 'new');
  await appendFile(file, jsonl(codexMessage('New workspace text.')));
  await ingestSessions(options);
  expect(options.store.daily('2026-11-05').evidence.map((item) => item.title)).toEqual([
    'New workspace text.',
  ]);
  await ingestSessions({ ...options, timezone: 'UTC' });
  expect(options.store.daily('2026-11-04').evidence.map((item) => item.title)).toEqual([
    'New workspace text.',
  ]);
  expect(options.store.daily('2026-11-05', 0, 'old').evidence.map((item) => item.title)).toEqual([
    'Old workspace text.',
  ]);
});
