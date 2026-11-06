import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Project, RepairIssue, RepositoryCheckout } from '../shared/domain.js';
import { authorRepair, readGit } from './local-git.js';
import { quoteShell } from './process.js';

export const checkoutId = (path: string) =>
  createHash('sha256').update(path).digest('hex').slice(0, 24);
export async function inspectCheckout(root: string, project: Project): Promise<RepositoryCheckout> {
  const result: RepositoryCheckout = {
    id: checkoutId(project.checkout),
    path: project.path,
    checkout: project.checkout,
    checkedAt: new Date().toISOString(),
  };
  const command = (...args: string[]) => `git -C ${quoteShell(project.checkout)} ${args.join(' ')}`;
  const fail = (repair: RepairIssue) => {
    result.repair = repair;
    result.error = repair.message;
    return result;
  };
  try {
    const rel = relative(await realpath(root), await realpath(project.checkout));
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
      return fail({
        code: 'outside-root',
        title: 'Checkout moved outside the work folder',
        message: 'This checkout resolves outside the configured work folder.',
        steps: ['Choose a checkout inside the saved folder, then rescan projects.'],
      });
    const marker = join(project.checkout, '.git');
    const info = await stat(marker);
    if (info.isFile()) {
      if (info.size > 16384)
        return fail({
          code: 'invalid-reference',
          title: 'Invalid .git reference',
          message: 'The .git reference is unexpectedly large.',
          steps: ['Restore the checkout metadata or exclude this project.'],
          command: command('rev-parse', '--git-dir'),
        });
      const text = await readFile(marker, 'utf8');
      const pointer = /^gitdir:\s*([^\r\n]+)\s*$/.exec(text);
      if (!pointer?.[1])
        return fail({
          code: 'invalid-reference',
          title: 'Invalid .git reference',
          message: 'The .git file does not contain a valid gitdir reference.',
          steps: ['Restore the checkout metadata or exclude this project.'],
          command: command('rev-parse', '--git-dir'),
        });
      const target = resolve(project.checkout, pointer[1]);
      const targetInfo = await stat(target).catch(() => undefined);
      if (!targetInfo?.isDirectory())
        return fail({
          code: 'missing-reference',
          title: target.includes('/worktrees/')
            ? 'Missing worktree metadata'
            : target.includes('/modules/')
              ? 'Missing submodule metadata'
              : 'Missing Git metadata',
          message: `The .git reference points to a missing or unreadable Git metadata directory: ${target}`,
          steps: [
            'Check that the referenced directory exists and is readable. If this checkout is obsolete, deselect its project.',
            'Otherwise restore or recreate its Git metadata using your normal repository setup, then recheck.',
          ],
          command: command('rev-parse', '--git-dir'),
        });
    } else if (!info.isDirectory())
      return fail({
        code: 'invalid-reference',
        title: 'Invalid .git metadata',
        message: 'The .git path is not a directory or reference file.',
        steps: ['Restore the checkout metadata or exclude this project.'],
      });
    result.commonDir = await realpath(
      (
        await readGit(project.checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).replace(/\n$/, ''),
    );
    result.gitDir = await realpath(
      (await readGit(project.checkout, ['rev-parse', '--absolute-git-dir'])).replace(/\n$/, ''),
    );
  } catch (error) {
    const failure = error as { code?: string; stderr?: string; message?: string };
    if (failure.message?.includes('Git is unavailable'))
      return fail({
        code: 'git-unavailable',
        title: 'Git is unavailable',
        message: 'Worklog cannot run Git from its current PATH.',
        steps: ['Install Git or start Worklog from the same shell environment where Git works.'],
        command: 'git --version',
      });
    if (
      failure.code === 'EACCES' ||
      failure.code === 'EPERM' ||
      failure.stderr?.includes('dubious ownership')
    )
      return fail({
        code: 'permissions',
        title: 'Checkout ownership or permissions need attention',
        message: 'Git cannot safely read this checkout with the current user permissions.',
        steps: [
          'Verify the checkout owner and permissions. Review Git’s native error before changing trust settings.',
        ],
        command: command('rev-parse', '--git-dir'),
      });
    return fail({
      code: 'metadata-unreadable',
      title: 'Git metadata cannot be read',
      message: 'This checkout has incomplete, moved, or invalid Git metadata/configuration.',
      steps: [
        'Run the diagnostic command to inspect Git’s exact error. Restore the checkout or exclude it, then recheck.',
      ],
      command: command('rev-parse', '--git-dir'),
    });
  }
  const missingAuthor = async () => {
    const repair = await authorRepair(project.checkout);
    return fail({
      code: 'author-missing',
      title: 'Git author email is missing',
      message: 'Worklog needs this checkout’s Git user.email to attribute your commits.',
      steps: [
        'Replace the placeholder with your work email before running the command.',
        ...(repair.shared
          ? [
              'This repository shares its local identity across worktrees; the command changes that shared identity.',
            ]
          : []),
        'Recheck after saving the identity.',
      ],
      command: repair.command,
    });
  };
  try {
    result.authorEmail =
      (await readGit(project.checkout, ['config', '--get', 'user.email'])).trim() || undefined;
    if (!result.authorEmail) return await missingAuthor();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return await missingAuthor();
    return fail({
      code: 'author-unreadable',
      title: 'Git author configuration cannot be read',
      message: 'Git could not read user.email for this checkout.',
      steps: ['Inspect Git’s native configuration error and correct it, then recheck.'],
      command: command('config', '--get', 'user.email'),
    });
  }
  try {
    await readGit(project.checkout, ['log', '--all', '--max-count=1', '--format=%H']);
  } catch {
    return fail({
      code: 'history-unreadable',
      title: 'Local Git history cannot be read',
      message: 'Git cannot traverse this checkout’s local refs or objects.',
      steps: [
        'Inspect the diagnostic output and restore the affected refs/objects using your normal Git workflow.',
        'Recheck, then collect the affected date again.',
      ],
      command: command('log', '--all', '-1', '--oneline'),
    });
  }
  return result;
}
