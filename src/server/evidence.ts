import type { Evidence } from '../shared/domain.js';

// Commit SHAs identify immutable context. An optional lookup skipped on refresh must not erase it.
export function retainEvidenceContext(
  incoming: Evidence,
  previous: Evidence | undefined,
): Evidence {
  if (
    incoming.localGit &&
    previous?.localGit?.inspected &&
    !incoming.localGit.inspected &&
    incoming.id === previous.id &&
    incoming.project === previous.project &&
    incoming.localGit.commit === previous.localGit.commit &&
    incoming.localGit.checkout === previous.localGit.checkout
  )
    return { ...incoming, localGit: previous.localGit, excerpt: previous.excerpt };
  return !incoming.excerpt &&
    incoming.push &&
    previous?.excerpt &&
    incoming.id === previous.id &&
    incoming.project === previous.project &&
    JSON.stringify(incoming.push) === JSON.stringify(previous.push)
    ? { ...incoming, excerpt: previous.excerpt }
    : incoming;
}
