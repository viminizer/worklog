import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import type { Evidence, EvidencePage } from '../shared/domain.js';
import { api } from './api.js';
import { EvidenceReference } from './evidence-reference.js';

export function EvidencePanel({
  day,
  scope,
  onOpen,
}: {
  day: string;
  scope: string;
  onOpen: (item: Evidence) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ key: string; page: EvidencePage }>();
  const [problem, setProblem] = useState('');
  const key = JSON.stringify([day, scope, offset, query, kind]);
  const page = result?.key === key ? result.page : undefined;
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!scope) return;
    let active = true;
    let busy = false;
    const controller = new AbortController();
    setProblem('');
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const page = await api<EvidencePage>(
          `/api/evidence-list?${new URLSearchParams({ day, scope, offset: String(offset), q: query, kind })}`,
          { signal: controller.signal },
        );
        if (active) {
          if (page.total > 0 && offset >= page.total) {
            setOffset(Math.floor((page.total - 1) / 10) * 10);
            return;
          }
          setResult({ key, page });
          setProblem('');
        }
      } catch (error) {
        if (active) setProblem(error instanceof Error ? error.message : 'Cannot load evidence.');
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [key, day, scope, offset, query, kind]);
  return (
    <section className="evidence-panel" aria-label="Source evidence">
      <div className="section-heading">
        <div>
          <p className="eyebrow">THE SOURCE MATERIAL</p>
          <h2>Behind your working record.</h2>
        </div>
        {page && <span className="count">{page.total} sources</span>}
      </div>
      <p className="muted">
        {DateTime.fromISO(day).toFormat('cccc, LLLL d')} · Browse the commits and AI sessions
        collected for this day.
      </p>
      <div className="evidence-filters">
        <label>
          Find sources
          <input
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title or project"
          />
        </label>
        <label>
          Source
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setOffset(0);
            }}
          >
            <option value="all">All sources</option>
            <option value="git">Local Git</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
      </div>
      {problem && (
        <p role="alert" className="job-error">
          {problem}
        </p>
      )}
      {!page && !problem && (
        <p role="status" className="muted">
          Loading sources…
        </p>
      )}
      {page && page.total === 0 && (
        <p className="muted">
          {query || kind !== 'all'
            ? 'No matching sources.'
            : 'Collected activity will appear here.'}
        </p>
      )}
      {page && (
        <div className="evidence-results" tabIndex={0} role="region" aria-label="Evidence records">
          {page.items.map((item) => (
            <EvidenceReference key={item.id} item={item} onOpen={onOpen} full />
          ))}
        </div>
      )}
      {page && page.total > 10 && (
        <nav className="pagination" aria-label="Evidence pages">
          <button
            type="button"
            className="quiet"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - 10))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 10, page.total)} of {page.total}
          </span>
          <button
            type="button"
            className="quiet"
            disabled={!page.hasMore}
            onClick={() => setOffset((value) => value + 10)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
