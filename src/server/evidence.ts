import type { Evidence } from '../shared/domain.js';

// Commit SHAs identify immutable context. An optional lookup skipped on refresh must not erase it.
export function retainPushContext(incoming: Evidence, previous: Evidence | undefined): Evidence {
  return !incoming.excerpt &&
    incoming.push &&
    previous?.excerpt &&
    incoming.id === previous.id &&
    incoming.project === previous.project &&
    JSON.stringify(incoming.push) === JSON.stringify(previous.push)
    ? { ...incoming, excerpt: previous.excerpt }
    : incoming;
}
