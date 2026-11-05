import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    saveConfig({ ...input, token: '', gitlabUrl: 'https://other.example' }, path),
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
