import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '../shared/domain.js';
import { validateScanDepth } from '../shared/scan-depth.js';

const exec = promisify(execFile);

export function projectFromRemote(remote: string, gitlabUrl: string): string | null {
  const base = new URL(gitlabUrl);
  try {
    const url = new URL(remote);
    if (url.hostname !== base.hostname || !['https:', 'http:', 'ssh:'].includes(url.protocol))
      return null;
    const prefix = base.pathname.replace(/\/$/, '');
    if (prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    return url.pathname
      .slice(prefix.length)
      .replace(/^\//, '')
      .replace(/\.git\/?$/, '');
  } catch {
    const match = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(remote);
    if (match?.[1] !== base.hostname || !match[2]) return null;
    const path = match[2].replace(/\.git$/, '');
    const prefix = base.pathname.replace(/^\/|\/$/g, '');
    return prefix ? (path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null) : path;
  }
}
export async function discoverRepositories(root: string, scanDepth?: number): Promise<Project[]> {
  const maxDepth = validateScanDepth(scanDepth);
  root = await realpath(root);
  const repositories: Project[] = [];
  const skip = new Set(['node_modules', '.git', '.cache', 'dist', 'vendor']);
  let scanned = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (++scanned > 25000)
      throw new Error(
        'Work root scan exceeded 25,000 directories; lower Scan depth in Settings or choose a narrower root.',
      );
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
      throw new Error(
        `Cannot read work folder ${directory}. Check that it exists and you have permission, then collect again.`,
      );
    });
    if (entries.some((entry) => entry.name === '.git')) {
      if (repositories.length >= 1000)
        throw new Error('More than 1,000 checkouts; choose a narrower work folder.');
      repositories.push({ path: relative(root, directory) || '.', checkout: directory });
    }
    if (depth >= maxDepth) return;
    for (const entry of entries)
      if (entry.isDirectory() && !skip.has(entry.name))
        await walk(join(directory, entry.name), depth + 1);
  }
  await walk(root, 0);
  return repositories.sort((a, b) => a.path.localeCompare(b.path));
}
export async function discoverProjects(
  root: string,
  gitlabUrl: string,
  selected?: Project[],
  scanDepth?: number,
): Promise<Project[]> {
  const projects = new Map<string, Project>();
  for (const repository of selected ?? (await discoverRepositories(root, scanDepth))) {
    const { stdout } = await exec(
      'git',
      ['-C', repository.checkout, 'config', '--get-regexp', '^remote\\..*\\.url$'],
      { timeout: 10000 },
    ).catch((error: { code?: number }) => {
      if (error.code === 1) return { stdout: '' };
      throw error;
    });
    for (const line of stdout.trim().split('\n')) {
      const path = projectFromRemote(line.slice(line.indexOf(' ') + 1), gitlabUrl);
      if (path && !projects.has(path)) projects.set(path, { path, checkout: repository.checkout });
    }
  }
  return [...projects.values()].sort((a, b) => a.path.localeCompare(b.path));
}
