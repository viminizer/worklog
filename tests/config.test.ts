import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, saveConfig, validateConfig } from '../src/server/config.js';

const paths: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'worklog-config-'));
  paths.push(root);
  return root;
}
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
it('saves private settings and preserves the token on a blank same-instance update', async () => {
  const root = await fixture();
  const path = join(root, 'config.json');
  const input = {
    workRoot: root,
    gitlabUrl: 'https://git.example',
    token: 'fixture-secret',
    timezone: 'UTC',
    automatic: false,
  };
  await saveConfig(input, path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await saveConfig({ ...input, token: '' }, path);
  expect((await loadConfig(path)).token).toBe('fixture-secret');
  await expect(
    saveConfig(
      { ...input, remoteCollection: true, token: '', gitlabUrl: 'https://other.example' },
      path,
    ),
  ).rejects.toThrow('token');
});
it('retains previous settings on validation failure and never includes input secrets in errors', async () => {
  const root = await fixture();
  const path = join(root, 'config.json');
  const input = {
    workRoot: root,
    gitlabUrl: 'https://git.example',
    token: 'fixture-secret',
    timezone: 'UTC',
  };
  await saveConfig(input, path);
  const previous = await readFile(path, 'utf8');
  try {
    validateConfig({ ...input, token: { secret: 'do-not-display' } });
    throw new Error('Expected validation failure.');
  } catch (error) {
    expect(String(error)).not.toContain('do-not-display');
  }
  await expect(saveConfig({ ...input, timezone: 'Wrong/Timezone' }, path)).rejects.toThrow(
    'timezone',
  );
  expect(await readFile(path, 'utf8')).toBe(previous);
});
it('rejects credential storage inside a Git repository and rejects file-valued work roots', async () => {
  const root = await fixture();
  const repository = join(root, 'repo');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  const input = {
    workRoot: root,
    gitlabUrl: 'https://git.example',
    token: 'fixture-secret',
    timezone: 'UTC',
  };
  await expect(saveConfig(input, join(repository, 'config.json'))).rejects.toThrow('outside Git');
  const file = join(root, 'file');
  await writeFile(file, 'text');
  await expect(saveConfig({ ...input, workRoot: file }, join(root, 'config.json'))).rejects.toThrow(
    'directory',
  );
});

it('accepts folder-only settings and expands the current user home without shell execution', async () => {
  expect(validateConfig({ workRoot: '~', timezone: 'UTC' }).workRoot).toBe(homedir());
  expect(validateConfig({ workRoot: '~/work', timezone: 'UTC' }).workRoot).toBe(
    join(homedir(), 'work'),
  );
  expect(() => validateConfig({ workRoot: '~someone/work', timezone: 'UTC' })).toThrow(
    'absolute path',
  );
  const root = await fixture();
  const path = join(root, 'config.json');
  await saveConfig({ workRoot: root, timezone: 'UTC', automatic: false }, path);
  expect((await loadConfig(path)).token).toBeUndefined();
  expect((await loadConfig(path)).gitlabUrl).toBeUndefined();
});

it('preserves project choices on ordinary settings edits and clears them for a different root', async () => {
  const root = await fixture();
  const path = join(root, 'settings.json');
  const ids = ['a'.repeat(24), 'b'.repeat(24)];
  await saveConfig(
    { workRoot: root, timezone: 'UTC', includedProjects: ids, includeSharedSessions: false },
    path,
  );
  await saveConfig({ workRoot: root, timezone: 'Asia/Seoul', automatic: false }, path);
  expect((await loadConfig(path)).includedProjects).toEqual(ids);
  expect((await loadConfig(path)).includeSharedSessions).toBe(false);
  const other = await fixture();
  await saveConfig({ workRoot: other, timezone: 'UTC' }, path);
  expect((await loadConfig(path)).includedProjects).toBeUndefined();
});

it('defaults legacy settings to depth three, saves depth zero and rejects invalid depths atomically', async () => {
  const root = await fixture();
  const path = join(root, 'settings.json');
  await writeFile(path, JSON.stringify({ workRoot: root, timezone: 'UTC' }));
  expect((await loadConfig(path)).scanDepth).toBe(3);
  await saveConfig({ workRoot: root, timezone: 'UTC', scanDepth: 0 }, path);
  expect((await loadConfig(path)).scanDepth).toBe(0);
  const original = await readFile(path, 'utf8');
  for (const scanDepth of [-1, 1.5, 21, NaN, Infinity, '3', null]) {
    await expect(saveConfig({ workRoot: root, timezone: 'UTC', scanDepth }, path)).rejects.toThrow(
      'Scan depth',
    );
    expect(await readFile(path, 'utf8')).toBe(original);
  }
});
