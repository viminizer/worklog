import type { Evidence } from '../shared/domain.js';
import { SourceFailure } from './errors.js';

interface GitLabEvent {
  id: number;
  author_id: number;
  created_at: string;
  action_name: string;
  target_title: string | null;
  target_type: string | null;
  target_iid: number | null;
  note?: { body: string; noteable_type: string; noteable_iid: number };
  push_data?: {
    commit_title: string | null;
    commit_to: string | null;
    commit_from?: string | null;
    commit_count?: number;
    ref: string | null;
  };
}
export class GitLab {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.base}/api/v4/${path}`, {
        headers: { 'PRIVATE-TOKEN': this.token },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new SourceFailure({
        message: 'GitLab is unreachable. Check the company network and instance URL.',
      });
    }
    if (!response.ok)
      throw new SourceFailure({
        message: `GitLab returned HTTP ${response.status}. Check access and token permissions.`,
      });
    const text = await response.text();
    if (text.length > 2_000_000)
      throw new SourceFailure({ message: 'GitLab response exceeds the supported size.' });
    try {
      return JSON.parse(text);
    } catch {
      throw new SourceFailure({ message: 'GitLab returned invalid JSON.' });
    }
  }
  async identity(): Promise<number> {
    const user = (await this.get('user')) as { id?: number };
    if (typeof user.id !== 'number')
      throw new SourceFailure({ message: 'GitLab identity response has no user ID.' });
    return user.id;
  }
  async activity(project: string, start: string, end: string, userId: number): Promise<Evidence[]> {
    const after = new Date(new Date(start).valueOf() - 86400000).toISOString().slice(0, 10);
    const before = new Date(new Date(end).valueOf() + 86400000).toISOString().slice(0, 10);
    const evidence: Evidence[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.get(
        `projects/${encodeURIComponent(project)}/events?after=${after}&before=${before}&per_page=100&page=${page}&sort=asc`,
      );
      if (!Array.isArray(result))
        throw new SourceFailure({ message: 'Unexpected GitLab activity response.' });
      for (const item of result as GitLabEvent[]) {
        if (
          !Number.isInteger(item.id) ||
          typeof item.created_at !== 'string' ||
          !Number.isInteger(item.author_id)
        ) {
          throw new SourceFailure({ message: 'Invalid GitLab event; collection was not saved.' });
        }
        const timestamp = Date.parse(item.created_at);
        if (!Number.isFinite(timestamp))
          throw new SourceFailure({ message: 'GitLab returned an invalid event timestamp.' });
        if (
          item.author_id !== userId ||
          timestamp < Date.parse(start) ||
          timestamp >= Date.parse(end)
        )
          continue;
        const type = item.note?.noteable_type ?? item.target_type;
        const iid = item.note?.noteable_iid ?? item.target_iid;
        const suffix =
          type === 'MergeRequest' && iid
            ? `/-/merge_requests/${iid}`
            : type === 'Issue' && iid
              ? `/-/issues/${iid}`
              : item.push_data?.commit_to
                ? `/-/commit/${encodeURIComponent(item.push_data.commit_to)}`
                : '/-/activity';
        evidence.push({
          id: `${this.base}:${project}:event:${item.id}`,
          project,
          time: new Date(timestamp).toISOString(),
          action: item.action_name ?? 'activity',
          title: (
            item.note?.body ??
            item.push_data?.commit_title ??
            item.target_title ??
            item.push_data?.ref ??
            'Project activity'
          ).slice(0, 4000),
          url: `${this.base}/${project}${suffix}`,
          ...(item.push_data?.commit_to &&
          /^[a-fA-F0-9]{40,64}$/.test(item.push_data.commit_to) &&
          !/^0+$/.test(item.push_data.commit_to)
            ? {
                push: {
                  from:
                    item.push_data.commit_from &&
                    /^[a-fA-F0-9]{40,64}$/.test(item.push_data.commit_from) &&
                    !/^0+$/.test(item.push_data.commit_from)
                      ? item.push_data.commit_from
                      : null,
                  to: item.push_data.commit_to,
                  count: Number.isInteger(item.push_data.commit_count)
                    ? (item.push_data.commit_count ?? null)
                    : null,
                  ref: item.push_data.ref,
                },
              }
            : {}),
          targetType: type ?? null,
          targetIid: iid ?? null,
        });
      }
      if (result.length < 100) return evidence;
    }
    throw new SourceFailure({
      message: 'Activity exceeds the pagination limit; choose a smaller collection scope.',
    });
  }
  async pushDetail(item: Evidence) {
    const push = item.push;
    if (!push) throw new SourceFailure({ message: 'Push metadata is unavailable.' });
    const base = `projects/${encodeURIComponent(item.project)}/repository`;
    const raw = push.from
      ? await this.get(
          `${base}/compare?${new URLSearchParams({ from: push.from, to: push.to, straight: 'true' })}`,
        )
      : await this.get(`${base}/commits/${encodeURIComponent(push.to)}`);
    const values = push.from ? (raw as { commits?: unknown }).commits : [raw];
    if (!Array.isArray(values))
      throw new SourceFailure({ message: 'Unexpected GitLab commit response.' });
    const commits = values.slice(0, 25).map((value: unknown) => {
      const commit = value as Record<string, unknown> | null;
      if (
        !commit ||
        typeof commit.id !== 'string' ||
        !/^[a-fA-F0-9]{40,64}$/.test(commit.id) ||
        typeof commit.title !== 'string'
      )
        throw new SourceFailure({ message: 'GitLab returned invalid commit details.' });
      return {
        id: commit.id,
        title: commit.title.slice(0, 300),
        author: String(commit.author_name ?? '').slice(0, 100),
        authoredAt: String(commit.authored_date ?? commit.created_at ?? '').slice(0, 50),
      };
    });
    const limitations = [
      'A push records who pushed changes; commit authors may be different people. Commit titles are evidence of changes, not proof of deployment or successful testing.',
    ];
    if (!push.from)
      limitations.push(
        'The previous ref is unavailable. Only the tip commit is shown; this does not enumerate the full push or branch history.',
      );
    if (values.length > 25)
      limitations.push(`Showing 25 of ${values.length} commits; remaining titles are omitted.`);
    return {
      ref: push.ref,
      from: push.from,
      to: push.to,
      reportedCount: push.count,
      commits,
      limitations,
    };
  }
  async detail(project: string, type: 'merge_requests' | 'issues', iid: number) {
    const detail = (await this.get(
      `projects/${encodeURIComponent(project)}/${type}/${iid}`,
    )) as Record<string, unknown>;
    return {
      title: detail.title,
      description: String(detail.description ?? '').slice(0, 12000),
      state: detail.state,
      web_url: detail.web_url,
    };
  }
}
