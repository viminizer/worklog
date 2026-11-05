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
  push_data?: { commit_title: string | null; commit_to: string | null; ref: string | null };
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
