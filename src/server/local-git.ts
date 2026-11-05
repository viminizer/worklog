import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Evidence, Project } from '../shared/domain.js';
import { SourceFailure } from './errors.js';

const exec = promisify(execFile);
async function git(checkout: string, args: string[]) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key as keyof typeof env];
  try {
    return (
      await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', checkout, ...args], {
        env,
        timeout: 20000,
        maxBuffer: 2_000_000,
      })
    ).stdout;
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean };
    if (failure.code === 'ENOENT')
      throw new SourceFailure({
        message: 'Git is unavailable on PATH. Install Git and restart Worklog, then collect again.',
      });
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new SourceFailure({
        message: `Local Git output for ${checkout} exceeded 2 MB. Choose a narrower work folder or date range, then retry.`,
      });
    if (failure.killed)
      throw new SourceFailure({
        message: `Local Git inspection timed out for ${checkout}. Check the checkout and retry.`,
      });
    throw error;
  }
}
async function scoped(root: string, repository: Project) {
  const path = await realpath(repository.checkout);
  const rel = relative(await realpath(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new SourceFailure({
      message: `Repository ${repository.path} is outside the work folder.`,
    });
  return path;
}
export async function repositoryActivity(
  root: string,
  repository: Project,
  start: string,
  end: string,
): Promise<Evidence[]> {
  const checkout = await scoped(root, repository);
  const quotedCheckout = "'" + checkout.replaceAll("'", "'\\''") + "'";
  const missingAuthor = () =>
    new SourceFailure({
      message: `${repository.path}: Git author email is missing. Run git -C ${quotedCheckout} config user.email "you@company.com", then collect again.`,
    });
  let email: string;
  try {
    email = (await git(checkout, ['config', '--get', 'user.email'])).trim();
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    if ((error as { code?: number }).code === 1) throw missingAuthor();
    throw new SourceFailure({
      message: `${repository.path}: Cannot read Git author configuration. Check checkout ownership, permissions, and Git configuration, then collect again.`,
    });
  }
  if (!email) throw missingAuthor();
  let output: string;
  try {
    output = await git(checkout, [
      'log',
      '--all',
      `--since-as-filter=${start}`,
      `--until=${end}`,
      '--fixed-strings',
      `--author=<${email}>`,
      '--regexp-ignore-case',
      '--max-count=1001',
      '-z',
      '--format=%H%x00%ae%x00%an%x00%cI%x00%s%x00%b',
    ]);
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure({
      message: `${repository.path}: Cannot read local Git history. Check that the checkout is readable and Git supports --since-as-filter, then retry.`,
    });
  }
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 6 !== 0)
    throw new SourceFailure({ message: `${repository.path}: Git returned malformed history.` });
  if (fields.length / 6 > 1000)
    throw new SourceFailure({
      message: `${repository.path}: More than 1,000 commits in this date range; narrow the collection scope.`,
    });
  const records: Evidence[] = [];
  const repositoryId = createHash('sha256').update(checkout).digest('hex').slice(0, 24);
  for (let i = 0; i < fields.length; i += 6) {
    const [commit, authorEmail, author, time, title, body] = fields.slice(i, i + 6) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^[a-f0-9]{40,64}$/.test(commit) || !Number.isFinite(Date.parse(time)))
      throw new SourceFailure({
        message: `${repository.path}: Git returned invalid commit metadata.`,
      });
    if (
      authorEmail.toLowerCase() !== email.toLowerCase() ||
      Date.parse(time) < Date.parse(start) ||
      Date.parse(time) >= Date.parse(end)
    )
      continue;
    const id = `git:${repositoryId}:${commit}`;
    records.push({
      id,
      project: repository.path,
      time: new Date(time).toISOString(),
      action: 'committed',
      title: title.slice(0, 1000),
      excerpt: `Commit ${commit}\nAuthor: ${author} <${authorEmail}>\n${title}\n${body.slice(0, 4000)}\nLocal commit evidence; does not prove pushing, deployment, or successful tests.`,
      url: `/api/evidence?id=${encodeURIComponent(id)}`,
      targetType: 'local-commit',
      targetIid: null,
      localGit: { checkout, commit, authorEmail },
    });
  }
  return records;
}
export async function repositoryDetail(root: string, item: Evidence): Promise<string> {
  const local = item.localGit;
  if (!local || !/^[a-f0-9]{40,64}$/.test(local.commit))
    throw new SourceFailure({ message: 'Local commit is unavailable.' });
  const checkout = await scoped(root, { path: item.project, checkout: local.checkout });
  try {
    const value = await git(checkout, [
      'show',
      '--no-ext-diff',
      '--no-textconv',
      '--format=fuller',
      '--stat',
      local.commit,
      '--',
    ]);
    return value.length > 12000
      ? `${value.slice(0, 12000)}\n[Remaining commit summary omitted]`
      : value;
  } catch {
    throw new SourceFailure({
      message: `${item.project}: Cannot inspect commit ${local.commit.slice(0, 12)}. Check the checkout and retry.`,
    });
  }
}
