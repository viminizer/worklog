import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppStatus, DailyView } from '../shared/domain.js';
import './style.css';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed.');
  return value;
}
function App() {
  const [status, setStatus] = useState<AppStatus>();
  const [day, setDay] = useState(DateTime.local().toFormat('yyyy-MM-dd'));
  const [view, setView] = useState<DailyView>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let active = true;
    api<AppStatus>('/api/status')
      .then((value) => {
        if (active) {
          setStatus(value);
          setDay(DateTime.now().setZone(value.timezone).toFormat('yyyy-MM-dd'));
        }
      })
      .catch((error) => active && setError(error.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    let fetching = false;
    setView(undefined);
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await api<DailyView>(
          `/api/day?day=${day}&refresh=${refresh}&offset=${offset}`,
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
      clearInterval(timer);
    };
  }, [day, refresh, offset]);
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
    <div className="app">
      <header>
        <a className="wordmark" href="/">
          w<span>▧</span>rklog<span className="period">.</span>
        </a>
        <span className="local-badge">
          <i /> LOCAL WORKSPACE
        </span>
      </header>
      <main>
        <div className="intro">
          <p className="eyebrow">THE WORKING RECORD</p>
          <h1>
            A little less remembering.
            <br />
            <em>A clearer picture.</em>
          </h1>
          <p className="lede">Your work, gathered from the places it happens.</p>
        </div>
        <div className="toolbar">
          <div>
            <label htmlFor="day">YOUR DAY</label>
            <input
              id="day"
              type="date"
              value={day}
              onChange={(event) => event.target.value && (setDay(event.target.value), setOffset(0))}
            />
          </div>
          <button type="button" disabled={!status?.configured || running} onClick={collect}>
            {running ? 'Collecting…' : '↻  Collect activity'}
          </button>
        </div>
        {(error || loadError) && (
          <div role="alert" className="notice error">
            {error || loadError}
          </div>
        )}
        {status && !status.configured && (
          <section className="notice setup">
            <p className="eyebrow">A PLACE TO BEGIN</p>
            <h2>Connect your work.</h2>
            <p>
              Create your local configuration at <code>{status.configPath}</code> with your work
              folder, GitLab URL, read-only token, and timezone. See the README for the format.
            </p>
            {status.setupError && <p role="alert">{status.setupError}</p>}
          </section>
        )}
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
                    ? 'Collect activity to turn your GitLab work into a record you can revisit.'
                    : 'Connect GitLab to start building your daily record.'}
                </p>
              </div>
            )}
            {view?.accomplishments.map((item) => (
              <article className="entry" key={item.id}>
                <span className={`state ${item.state}`}>{item.state}</span>
                <h3>{item.title}</h3>
                <div className="sources">
                  {item.evidenceIds.map((id) => {
                    const evidence = view.supportingEvidence.find((record) => record.id === id);
                    return (
                      evidence && (
                        <a key={id} href={evidence.url} target="_blank" rel="noreferrer">
                          {evidence.project} ↗
                        </a>
                      )
                    );
                  })}
                </div>
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
              {view?.jobs.length ? (
                view.jobs.slice(0, 4).map((job) => (
                  <div className="job" key={job.id}>
                    <div>
                      <strong>{job.status}</strong>
                      <span>{job.agent ?? 'Preparing'}</span>
                    </div>
                    <time>
                      {DateTime.fromISO(job.createdAt).toLocaleString(DateTime.TIME_SIMPLE)}
                    </time>
                    {job.fallback && <p>Switched to Claude Code: {job.fallback}</p>}
                    {job.error && <p className="job-error">{job.error}</p>}
                  </div>
                ))
              ) : (
                <p className="muted">No collections for this day.</p>
              )}
            </section>
            <section className="side-section">
              <p className="eyebrow">SOURCE EVIDENCE</p>
              {view?.evidence.length ? (
                view.evidence.map((item) => (
                  <a
                    className="evidence"
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>{item.project} ↗</span>
                    <p>{item.title}</p>
                  </a>
                ))
              ) : (
                <p className="muted">
                  Original activity will appear here, with links back to GitLab.
                </p>
              )}
            </section>
            <div className="footnote">
              Stored on this computer.
              <br />
              Codex first. Claude Code when needed.
            </div>
          </aside>
        </div>
      </main>
      <footer>
        WORKLOG <span>A record that grows with your work.</span>
      </footer>
    </div>
  );
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<App />);
