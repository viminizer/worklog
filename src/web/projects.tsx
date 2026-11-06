import { useEffect, useRef, useState } from 'react';
import type { AppStatus, ProjectCatalog, RepositoryCheckout } from '../shared/domain.js';
import { api } from './api.js';
import { RepairCard } from './repair-card.js';

export function Projects({
  active,
  configured,
  onSaved,
  repairFocus = 0,
}: {
  active: boolean;
  configured: boolean;
  onSaved: (status: AppStatus) => void;
  repairFocus?: number;
}) {
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [selected, setSelected] = useState<string[]>([]);
  const [shared, setShared] = useState(true);
  const [search, setSearch] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (repairFocus > 0) {
      setIssuesOnly(true);
      heading.current?.focus();
    }
  }, [repairFocus]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const requestId = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const savedIds = catalog?.selection ?? catalog?.groups.map((group) => group.id) ?? [];
  const baseline = savedIds.filter((id) => catalog?.groups.some((group) => group.id === id));
  const missingSelection = savedIds.length - baseline.length;
  const dirty = Boolean(
    catalog &&
      (JSON.stringify([...selected].sort()) !== JSON.stringify([...baseline].sort()) ||
        shared !== catalog.includeSharedSessions),
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    mounted.current = true;
    const protect = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener('beforeunload', protect);
    };
  }, []);
  async function load() {
    const id = ++requestId.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy('load');
    setError('');
    try {
      const value = await api<ProjectCatalog>('/api/projects', { signal: abort.signal });
      if (mounted.current && id === requestId.current) {
        setCatalog(value);
        setSelected(
          (value.selection ?? value.groups.map((group) => group.id)).filter((id) =>
            value.groups.some((group) => group.id === id),
          ),
        );
        setShared(value.includeSharedSessions);
        return value;
      }
    } catch (error) {
      if (mounted.current && id === requestId.current)
        setError(error instanceof Error ? error.message : 'Cannot discover projects.');
    } finally {
      if (mounted.current && id === requestId.current) setBusy('');
    }
  }
  useEffect(() => {
    if (active && configured && !catalog && !busy) void load();
  }, [active, configured]);
  async function save() {
    if (!catalog) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const value = await api<AppStatus>('/api/projects/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: catalog.workspaceId,
          includedProjects: selected,
          includeSharedSessions: shared,
        }),
      });
      if (mounted.current) {
        setCatalog({
          ...catalog,
          workspaceId: value.workspaceId,
          selection: [...selected],
          includeSharedSessions: shared,
        });
        setNotice(
          'Project choices saved. Previous records remain in History. Collect a date to build the selected record.',
        );
        onSaved(value);
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Cannot save project choices.');
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function recheck(checkout: RepositoryCheckout) {
    if (!catalog || dirty) return;
    setBusy(`recheck:${checkout.id}`);
    setError('');
    setNotice('');
    try {
      await api<{ checkout: RepositoryCheckout }>('/api/projects/recheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: catalog.workspaceId, checkoutId: checkout.id }),
      });
      if (!mounted.current) return;
      const refreshed = await load();
      if (!mounted.current) return;
      if (!refreshed) {
        setNotice('Checkout check completed. Rescan projects to refresh grouping.');
        return;
      }
      const latest = refreshed.groups
        .flatMap((group) => group.checkouts)
        .find((item) => item.id === checkout.id);
      if (!latest) {
        setNotice(
          'The checkout is no longer detected. Review the refreshed grouping and project choices.',
        );
        return;
      }
      if (mounted.current)
        setNotice(
          latest.repair
            ? 'The checkout still needs attention. Review its updated repair card.'
            : 'Basic checks passed. Grouping has been refreshed; review your choices, then collect the affected date again.',
        );
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Cannot recheck checkout.');
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  const visible =
    catalog?.groups.filter(
      (group) =>
        (!issuesOnly || group.checkouts.some((item) => item.repair)) &&
        `${group.path} ${group.checkouts.map((item) => item.path).join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <section className="projects-pane" aria-label="Projects">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR COLLECTION SCOPE</p>
          <h2 ref={heading} tabIndex={-1}>
            Choose your projects
          </h2>
        </div>
        <span className="muted">Worktrees stay together.</span>
      </div>
      {!configured ? (
        <p className="empty">Save a work folder in Settings to discover projects.</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="notice">
              {notice}
            </p>
          )}
          {!catalog && (
            <p className="empty" role="status">
              {busy
                ? 'Discovering local checkouts…'
                : 'Project discovery is unavailable. Try rescanning.'}
            </p>
          )}
          <div className="project-toolbar">
            <label>
              Find projects
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Project or checkout"
              />
            </label>
            <button
              type="button"
              className="quiet"
              disabled={Boolean(busy) || dirty}
              onClick={load}
            >
              Rescan projects
            </button>
          </div>
          {catalog && (
            <>
              <p className="muted">
                {catalog.root} · Scan depth {catalog.scanDepth} · {selected.length} of{' '}
                {catalog.groups.length} projects selected
              </p>
              {missingSelection > 0 && (
                <p className="notice">
                  {missingSelection} previously selected project
                  {missingSelection === 1 ? ' is' : 's are'} no longer detected. Review the
                  available projects and save updated choices.
                </p>
              )}
              <button
                type="button"
                className="quiet"
                aria-pressed={issuesOnly}
                onClick={() => setIssuesOnly((value) => !value)}
              >
                {issuesOnly
                  ? 'Show all projects'
                  : `Needs attention (${catalog.groups.flatMap((group) => group.checkouts).filter((item) => item.repair).length})`}
              </button>
              {dirty && (
                <p className="muted">Save or reset your pending choices before rechecking setup.</p>
              )}
              <div className="project-bulk">
                <button
                  type="button"
                  className="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => setSelected(catalog.groups.map((group) => group.id))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => setSelected([])}
                >
                  Clear selection
                </button>
              </div>
              <div className="project-grid">
                {visible.map((group) => (
                  <article className="project-card" key={group.id}>
                    <label className="project-choice">
                      <input
                        type="checkbox"
                        checked={selected.includes(group.id)}
                        disabled={Boolean(busy)}
                        onChange={(event) =>
                          setSelected((old) =>
                            event.target.checked
                              ? [...old, group.id]
                              : old.filter((id) => id !== group.id),
                          )
                        }
                      />
                      <span>
                        {group.path === '.' ? catalog.root.split('/').at(-1) : group.path}
                      </span>
                    </label>
                    <p className="muted">
                      {group.members.length} checkout{group.members.length === 1 ? '' : 's'}
                      {group.checkouts.some((item) => item.error) ? ' · Setup needs attention' : ''}
                    </p>
                    <details open={group.checkouts.some((item) => item.repair)}>
                      <summary>Inspect checkouts</summary>
                      <div className="checkout-repairs">
                        {group.checkouts.map((item) => (
                          <RepairCard
                            key={`${item.id}:${item.checkedAt}`}
                            checkout={item}
                            disabled={Boolean(busy) || dirty}
                            checking={busy === `recheck:${item.id}`}
                            onRecheck={() => void recheck(item)}
                          />
                        ))}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
              {visible.length === 0 && <p className="empty">No matching projects.</p>}
              <label className="checkbox shared-session-choice">
                <input
                  type="checkbox"
                  checked={shared}
                  disabled={Boolean(busy)}
                  onChange={(event) => setShared(event.target.checked)}
                />
                Include shared workspace sessions
              </label>
              <p className="muted">
                Shared sessions begin outside individual checkouts and can span projects. Leave this
                off for strict project-only collection.
              </p>
              <p className="muted">
                Saving choices makes newly discovered projects opt-in. Existing reports stay in
                History; collection and new drafts use your selected projects.
              </p>
              <div className="editor-actions">
                <button
                  type="button"
                  onClick={save}
                  disabled={
                    Boolean(busy) ||
                    (!selected.length && !shared) ||
                    (!dirty && catalog.selection !== null && !missingSelection)
                  }
                >
                  {busy === 'save' ? 'Saving…' : 'Save project choices'}
                </button>
                {dirty && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setSelected([...baseline]);
                      setShared(catalog.includeSharedSessions);
                    }}
                  >
                    Reset choices
                  </button>
                )}
                {!selected.length && !shared && (
                  <span className="job-error">Select a project or include shared sessions.</span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
