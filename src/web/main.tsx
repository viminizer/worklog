import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import packageInfo from '../../package.json' with { type: 'json' };
import type { AppStatus, DailyView, Evidence } from '../shared/domain.js';
import './style.css';
import { api } from './api.js';
import { EvidencePanel } from './evidence-panel.js';
import { EvidenceLinks } from './evidence-reference.js';
import { Projects } from './projects.js';
import { Reports } from './reports.js';
import { Settings } from './settings.js';

function EvidenceDialog({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="evidence-title">
      <button type="button" className="dialog-close" onClick={() => dialog.current?.close()}>
        Close
      </button>
      <p className="eyebrow">
        {evidence.localGit ? 'LOCAL GIT COMMIT' : `${evidence.session?.provider} SESSION EVIDENCE`}
      </p>
      <h2 id="evidence-title">{evidence.project}</h2>
      <p className="muted">
        {evidence.time} · {evidence.action}
      </p>
      <pre>{evidence.excerpt ?? evidence.title}</pre>
      {evidence.session && (
        <p className="muted">
          Session {evidence.session.id} · Entry {evidence.session.entry}
        </p>
      )}
      {evidence.localGit && <p className="muted">Checkout: {evidence.localGit.checkout}</p>}
    </dialog>
  );
}
function App() {
  const [historyScope, setHistoryScope] = useState('');
  const [tab, setTab] = useState<'log' | 'reports' | 'projects'>('log');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence>();
  const [status, setStatus] = useState<AppStatus>();
  const statusEpoch = useRef(0);
  const [day, setDay] = useState(DateTime.local().toFormat('yyyy-MM-dd'));
  const [view, setView] = useState<DailyView>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [offset, setOffset] = useState(0);
  const scope = historyScope || status?.workspaceId || '';
  const archived = Boolean(scope && status && scope !== status.workspaceId);
  useEffect(() => {
    let active = true;
    let fetching = false;
    let initialized = false;
    const controller = new AbortController();
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const epoch = statusEpoch.current;
        const value = await api<AppStatus>('/api/status', { signal: controller.signal });
        if (active && epoch === statusEpoch.current) {
          setStatus(value);
          if (!initialized) setDay(DateTime.now().setZone(value.timezone).toFormat('yyyy-MM-dd'));
          initialized = true;
          setStatusError('');
        }
      } catch (error) {
        if (active)
          setStatusError(error instanceof Error ? error.message : 'Cannot connect to Worklog.');
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!scope) return;
    let active = true;
    let fetching = false;
    const controller = new AbortController();
    setView(undefined);
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await api<DailyView>(
          `/api/day?day=${day}&refresh=${refresh}&offset=${offset}&scope=${encodeURIComponent(scope)}`,
          {
            signal: controller.signal,
          },
        );
        if (active) {
          setView(value);
          setLoadError('');
        }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Cannot load activity.');
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [day, refresh, offset, scope]);
  const running = pending || view?.jobs.some((job) => ['queued', 'running'].includes(job.status));
  async function collect() {
    setPending(true);
    setError('');
    try {
      await api('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day }),
      });
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Collection failed.');
    } finally {
      setPending(false);
    }
  }
  const formatted = DateTime.fromISO(day).toFormat('cccc, LLLL d');
  return (
    <div className={`app${status?.configured ? ' configured' : ''}`}>
      <header>
        <div className="brand">
          <a className="wordmark" href="/">
            w<span>▧</span>rklog<span className="period">.</span>
          </a>
          <span className="app-version">v{packageInfo.version}</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="quiet"
            onClick={() => setSettingsOpen((value) => !value)}
          >
            Settings
          </button>
          <span className="local-badge">
            <i /> LOCAL WORKSPACE
          </span>
        </div>
      </header>
      <main>
        <div className="intro">
          <p className="eyebrow">THE WORKING RECORD</p>
          <h1>
            {status?.configured ? (
              'Your working record.'
            ) : (
              <>
                A little less remembering.
                <br />
                <em>A clearer picture.</em>
              </>
            )}
          </h1>
          <p className="lede">Your work, gathered from the places it happens.</p>
        </div>
        {status && status.workspaces.length > 1 && (
          <label className="workspace-picker">
            History
            <select
              value={scope}
              onChange={(event) => {
                setHistoryScope(
                  event.target.value === status.workspaceId ? '' : event.target.value,
                );
                setOffset(0);
              }}
            >
              {status.workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === status.workspaceId
                    ? 'Current workspace'
                    : (item.workRoot ?? 'Imported history')}
                  {item.label && item.id !== status.workspaceId ? ` · ${item.label}` : ''}
                  {item.id !== status.workspaceId && item.gitlabUrl ? ` · ${item.gitlabUrl}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {archived && (
          <p className="notice">
            Archived workspace. You can browse records and edit saved reports. Collection and
            generation use the current workspace.
          </p>
        )}
        <div className="toolbar">
          <div>
            <label htmlFor="day">YOUR DAY</label>
            <input
              id="day"
              type="date"
              max={DateTime.now()
                .setZone(status?.timezone ?? 'UTC')
                .toFormat('yyyy-MM-dd')}
              value={day}
              onChange={(event) => event.target.value && (setDay(event.target.value), setOffset(0))}
            />
          </div>
          <button
            type="button"
            disabled={!status?.configured || running || archived}
            onClick={collect}
          >
            {running ? 'Collecting…' : '↻  Collect activity'}
          </button>
        </div>
        {(error || loadError || statusError) && (
          <div role="alert" className="notice error">
            {error || loadError || statusError}
          </div>
        )}
        {status && (!status.configured || settingsOpen) && (
          <Settings
            status={status}
            onClose={() => setSettingsOpen(false)}
            onSaved={(value) => {
              statusEpoch.current++;
              setStatus(value);
              setError('');
              setSettingsOpen(false);
              setDay(DateTime.now().setZone(value.timezone).toFormat('yyyy-MM-dd'));
              setRefresh((value) => value + 1);
            }}
          />
        )}
        {status?.workerError && (
          <p role="alert" className="notice error">
            Background queue: {status.workerError}
          </p>
        )}
        <nav className="view-tabs" aria-label="Workspace views">
          <button type="button" aria-pressed={tab === 'log'} onClick={() => setTab('log')}>
            Daily log
          </button>
          <button type="button" aria-pressed={tab === 'reports'} onClick={() => setTab('reports')}>
            Reports
          </button>
          <button
            type="button"
            aria-pressed={tab === 'projects'}
            onClick={() => setTab('projects')}
          >
            Projects
          </button>
        </nav>
        <div hidden={tab !== 'projects'}>
          <Projects
            key={`${status?.workRoot}:${status?.remoteCollection ? status.gitlabUrl : 'local'}`}
            active={tab === 'projects'}
            configured={status?.configured ?? false}
            onSaved={(value) => {
              statusEpoch.current++;
              setStatus(value);
              setHistoryScope('');
              setRefresh((old) => old + 1);
            }}
          />
        </div>
        <div hidden={tab !== 'reports'}>
          <Reports
            day={day}
            scope={scope}
            archived={archived}
            status={status}
            active={tab === 'reports'}
            onEvidence={setSelectedEvidence}
          />
        </div>
        <div hidden={tab !== 'log'}>
          <div className="workspace">
            <section className="journal">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">DAILY LOG</p>
                  <h2>{formatted}</h2>
                </div>
                <span className="count">{view?.accomplishments.length ?? '—'} entries</span>
              </div>
              {!view && !error && (
                <p role="status" className="empty">
                  Loading your working record…
                </p>
              )}
              {view && view.accomplishments.length === 0 && (
                <div className="empty">
                  <span className="empty-mark">↳</span>
                  <h3>Room for today's work.</h3>
                  <p>
                    {status?.configured
                      ? 'Collect activity to turn your work into a record you can revisit.'
                      : 'Connect your sources to start building your daily record.'}
                  </p>
                </div>
              )}
              {view?.accomplishments.map((item) => (
                <article className="entry" key={item.id}>
                  <span className={`state ${item.state}`}>{item.state}</span>
                  <h3>{item.title}</h3>
                  <EvidenceLinks
                    items={item.evidenceIds.flatMap((id) => {
                      const source = view.supportingEvidence.find((record) => record.id === id);
                      return source ? [source] : [];
                    })}
                    onOpen={setSelectedEvidence}
                  />
                </article>
              ))}
              {(offset > 0 || view?.hasMore) && (
                <nav className="pagination" aria-label="Daily record pages">
                  <button
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset((value) => Math.max(0, value - 100))}
                  >
                    Previous
                  </button>
                  <span>Page {offset / 100 + 1}</span>
                  <button
                    type="button"
                    disabled={!view?.hasMore}
                    onClick={() => setOffset((value) => value + 100)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </section>
            <aside>
              <section className="side-section">
                <p className="eyebrow">COLLECTION STATUS</p>
                {status?.configured && (
                  <div className="queue-summary">
                    <p>
                      {status.activeJob
                        ? `${status.activeJob.kind === 'report' ? 'Preparing report for' : 'Collecting'} ${status.activeJob.day}`
                        : status.automatic
                          ? 'Automatic collection is on'
                          : 'Automatic collection is paused'}
                    </p>
                    <p className="muted">
                      {status.queuedJobs} queued ·{' '}
                      {status.lastCollectedAt
                        ? `Last complete: ${DateTime.fromISO(status.lastCollectedAt).toRelative()}`
                        : 'No complete collection yet'}
                    </p>
                    {status.automatic && status.nextAutomaticAt && (
                      <p className="muted">
                        Next check {DateTime.fromISO(status.nextAutomaticAt).toRelative()}
                      </p>
                    )}
                  </div>
                )}
                {view?.jobs.length ? (
                  view.jobs.slice(0, 4).map((job) => (
                    <div className="job" key={job.id}>
                      <div>
                        <strong>
                          {job.kind === 'report' ? 'Report · ' : ''}
                          {job.status}
                        </strong>
                        <span>
                          {job.agent ?? 'Preparing'}
                          {job.attempts > 0 ? ` · attempt ${job.attempts}/3` : ''}
                        </span>
                      </div>
                      <time>
                        {DateTime.fromISO(job.createdAt).toLocaleString(DateTime.TIME_SIMPLE)}
                      </time>
                      {job.fallback && <p>Switched to Claude Code: {job.fallback}</p>}
                      {job.error && (
                        <div role="alert" className="job-error">
                          <p>{job.error}</p>
                          <p>Fix the issue on this computer, then collect this date again.</p>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="muted">No collections for this day.</p>
                )}
              </section>
              <EvidencePanel
                key={`${scope}:${day}`}
                day={day}
                scope={scope}
                onOpen={setSelectedEvidence}
              />
              <div className="footnote">
                Stored on this computer.
                <br />
                Codex first. Claude Code when needed.
              </div>
            </aside>
          </div>
        </div>
      </main>
      {selectedEvidence && (
        <EvidenceDialog
          evidence={selectedEvidence}
          onClose={() => setSelectedEvidence(undefined)}
        />
      )}
      <footer>
        WORKLOG <span>A record that grows with your work.</span>
      </footer>
    </div>
  );
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<App />);
