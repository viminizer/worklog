import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import type { RepositoryGroup } from '../shared/domain.js';
import { inspectCheckout } from './diagnostics.js';
import { discoverRepositories } from './discovery.js';

export async function discoverRepositoryGroups(root: string): Promise<RepositoryGroup[]> {
  root = await realpath(root);
  const groups = new Map<string, RepositoryGroup>();
  for (const repository of await discoverRepositories(root)) {
    const member = await inspectCheckout(root, repository);
    const identity = member.commonDir ?? repository.checkout;
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const group = groups.get(id) ?? {
      id,
      path: repository.path,
      checkout: repository.checkout,
      members: [],
      authorEmails: [],
      checkouts: [],
      commonDir: member.commonDir,
    };
    group.members.push(repository.checkout);
    group.checkouts.push(member);
    if (
      member.authorEmail &&
      !group.authorEmails.some((email) => email.toLowerCase() === member.authorEmail?.toLowerCase())
    )
      group.authorEmails.push(member.authorEmail);
    if (member.commonDir && member.gitDir === member.commonDir) {
      group.checkout = repository.checkout;
      group.path = relative(root, repository.checkout) || '.';
    }
    groups.set(id, group);
    if (groups.size > 200)
      throw new Error('More than 200 repository groups; choose a narrower work folder.');
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
}
