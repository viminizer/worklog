import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectCheckout } from '../src/server/diagnostics.js';

const paths: string[] = [];
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'worklog-diagnostics-')));
  paths.push(path);
  return path;
}
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
it('offers a safely quoted manual identity command and clears the issue after a manual fix without editing config during checks', async () => {
  const root = await fixture();
  const checkout = join(root, "o'connor $(touch owned)");
  await mkdir(checkout);
  git(checkout, 'init', '-q');
  git(checkout, 'config', 'user.email', '');
  const config = await readFile(join(checkout, '.git/config'), 'utf8');
  const issue = await inspectCheckout(root, { path: 'fixture', checkout });
  expect(issue.repair?.code).toBe('author-missing');
  expect(await readFile(join(checkout, '.git/config'), 'utf8')).toBe(config);
  const command = issue.repair?.command;
  if (!command) throw new Error('Expected repair command');
  execFileSync('sh', ['-c', command], { cwd: root });
  await expect(readFile(join(root, 'owned'))).rejects.toThrow();
  expect(git(checkout, 'config', '--get', 'user.email')).toBe('you@company.com');
  const checked = await inspectCheckout(root, { path: 'fixture', checkout });
  expect(checked.repair).toBeUndefined();
  expect(checked.error).toBeUndefined();
  expect(checked.id).toBe(issue.id);
});
it('distinguishes missing Git pointers from invalid references and refuses an outside checkout', async () => {
  const root = await fixture();
  const checkout = join(root, 'broken');
  await mkdir(checkout);
  await writeFile(
    join(checkout, '.git'),
    'gitdir: /nonexistent-worklog-main/.git/worktrees/test\n',
  );
  expect((await inspectCheckout(root, { path: 'broken', checkout })).repair?.code).toBe(
    'missing-reference',
  );
  await writeFile(join(checkout, '.git'), 'invalid');
  expect((await inspectCheckout(root, { path: 'broken', checkout })).repair?.code).toBe(
    'invalid-reference',
  );
  const outside = await fixture();
  expect((await inspectCheckout(root, { path: 'outside', checkout: outside })).repair?.code).toBe(
    'outside-root',
  );
});
it('reports unreadable history after metadata and author checks succeed', async () => {
  const root = await fixture();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, '.git/refs/heads/broken'), 'f'.repeat(40) + '\n');
  expect((await inspectCheckout(root, { path: '.', checkout: root })).repair?.code).toBe(
    'history-unreadable',
  );
});

it('repairs an empty worktree override without changing the main checkout identity', async () => {
  const root = await fixture();
  const main = join(root, 'main');
  const checkout = join(root, 'linked');
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'main@example.test');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'commit', '--allow-empty', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-qb', 'linked', checkout);
  git(main, 'config', 'extensions.worktreeConfig', 'true');
  git(checkout, 'config', '--worktree', 'user.email', '');
  const issue = await inspectCheckout(root, { path: 'linked', checkout });
  expect(issue.repair?.code).toBe('author-missing');
  if (!issue.repair?.command) throw new Error('Expected repair command');
  execFileSync('sh', ['-c', issue.repair.command], { cwd: root });
  expect((await inspectCheckout(root, { path: 'linked', checkout })).repair).toBeUndefined();
  expect(git(main, 'config', '--get', 'user.email')).toBe('main@example.test');
  expect(git(checkout, 'config', '--get', 'user.email')).toBe('you@company.com');
});

it('offers shared local identity repair for default linked worktrees', async () => {
  const root = await fixture();
  const main = join(root, 'main');
  const checkout = join(root, 'linked');
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'main@example.test');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'commit', '--allow-empty', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-qb', 'linked', checkout);
  git(main, 'config', 'user.email', '');
  const issue = await inspectCheckout(root, { path: 'linked', checkout });
  expect(issue.repair?.command).toContain('config --local user.email');
  expect(issue.repair?.steps.join(' ')).toContain('shared identity');
  if (!issue.repair?.command) throw new Error('Expected repair command');
  execFileSync('sh', ['-c', issue.repair.command], { cwd: root });
  expect((await inspectCheckout(root, { path: 'linked', checkout })).repair).toBeUndefined();
  expect(git(main, 'config', '--get', 'user.email')).toBe('you@company.com');
});
