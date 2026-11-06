import { DateTime } from 'luxon';
import type { AppStatus, Job } from '../shared/domain.js';

export function CollectionStatus({
  status,
  jobs,
  archived,
  onRepair,
}: {
  status?: AppStatus;
  jobs: Job[];
  archived: boolean;
  onRepair: () => void;
}) {
  const latest = jobs.filter(
    (job, index) => jobs.findIndex((item) => item.kind === job.kind) === index,
  );
  const problems = latest.filter((job) => job.error);
  const label = !status
    ? 'Connecting to collector…'
    : !status.configured
      ? 'Set up your work folder to collect activity'
      : status.activeJob
        ? `${status.activeJob.kind === 'report' ? 'Preparing report for' : 'Collecting'} ${status.activeJob.day}`
        : status.automatic
          ? 'Automatic collection is on'
          : 'Automatic collection is paused';
  return (
    <section className="collection-panel" aria-label="Collection status">
      <div className="collection-strip">
        <div className="collector-state">
          <span
            className={`collector-dot${status?.activeJob ? ' active' : ''}`}
            aria-hidden="true"
          />
          <div>
            <p className="collector-label">{label}</p>
            {status?.configured && (
              <p className="collector-meta">
                {archived && 'Live workspace · '}
                {status.queuedJobs} queued ·{' '}
                {status.lastCollectedAt
                  ? `Last complete ${DateTime.fromISO(status.lastCollectedAt).toRelative()}`
                  : 'No complete collection yet'}
                {status.automatic &&
                  status.nextAutomaticAt &&
                  ` · Next check ${DateTime.fromISO(status.nextAutomaticAt).toRelative()}`}
              </p>
            )}
          </div>
        </div>
        <span className="collector-privacy">Stored on this computer</span>
      </div>
      {problems.map((job) => (
        <div className="collection-warning" role="alert" key={job.id}>
          <div>
            <strong>
              {job.kind === 'report' ? 'Report needs attention' : 'Collection needs attention'}
            </strong>
            <p>{job.error?.split(' · ')[0]}</p>
            <details className="task-error">
              <summary>Full error and recovery</summary>
              <p>{job.error}</p>
              <p>Fix the setup, then collect this date again.</p>
            </details>
          </div>
          {/Git|checkout|repository|worktree/i.test(job.error ?? '') && (
            <button type="button" className="quiet" onClick={onRepair}>
              Review repository setup
            </button>
          )}
        </div>
      ))}
      <details className="collection-history">
        <summary>
          Activity for this day{' '}
          <span>{jobs.length ? `${Math.min(jobs.length, 4)} recent tasks` : 'No tasks yet'}</span>
        </summary>
        {jobs.length ? (
          <div className="task-list">
            {jobs.slice(0, 4).map((job) => (
              <article className="task-row" key={job.id}>
                <div className="task-heading">
                  <strong>
                    {job.kind === 'report' ? 'Report' : 'Collection'}{' '}
                    <span className={`task-state ${job.status}`}>{job.status}</span>
                  </strong>
                  <time dateTime={job.createdAt}>
                    {DateTime.fromISO(job.createdAt).toLocaleString(DateTime.TIME_SIMPLE)}
                  </time>
                </div>
                <p className="muted">
                  {job.agent ?? 'Preparing'}
                  {job.attempts > 0 && ` · attempt ${job.attempts}/3`}
                </p>
                {job.fallback && <p>Switched to Claude Code: {job.fallback}</p>}
                {job.error && (
                  <details className="task-error">
                    <summary>Original task error</summary>
                    <p>{job.error}</p>
                    <p>Fix the setup, then collect this date again.</p>
                  </details>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No collection or report tasks for this day.</p>
        )}
      </details>
    </section>
  );
}
