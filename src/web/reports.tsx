import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import type { AppStatus, Evidence, ReportResponse, ReportView } from '../shared/domain.js';
import { api } from './api.js';
import { EvidenceLinks } from './evidence-reference.js';
import { type ReportEditor as Editor, isOlderReport, mergeSavedReport } from './report-state.js';

export function Reports({
  day,
  scope,
  archived,
  status,
  active,
  onEvidence,
}: {
  day: string;
  scope: string;
  archived: boolean;
  status: AppStatus | undefined;
  active: boolean;
  onEvidence: (item: Evidence) => void;
}) {
  const [selection, setSelection] = useState({ kind: 'daily', fromDay: day, toDay: day });
  const key = JSON.stringify({ ...selection, scope });
  const selectedKey = useRef(key);
  selectedKey.current = key;
  const latestReports = useRef(new Map<string, ReportView>());
  const cache = useRef(new Map<string, Editor>());
  const initial = { key, text: '', dirty: false, editVersion: 0, baseDraftVersion: 0 };
  const [editor, setEditor] = useState<Editor>(initial);
  const editorRef = useRef(editor);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [result, setResult] = useState<{ key: string; data: ReportResponse }>();
  const [problem, setProblem] = useState<{ key: string; text: string }>();
  const [loadProblem, setLoadProblem] = useState<{ key: string; text: string }>();
  const error =
    problem?.key === key ? problem.text : loadProblem?.key === key ? loadProblem.text : undefined;
  const [noticeState, setNoticeState] = useState<{ key: string; text: string }>();
  const notice = noticeState?.key === key ? noticeState.text : '';
  function setNotice(text: string) {
    setNoticeState({ key, text });
  }
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const data = result?.key === key ? result.data : undefined;
  const report = data?.report;
  const current = editor.key === key ? editor : initial;
  function update(value: Editor) {
    editorRef.current = value;
    cache.current.set(value.key, value);
    setEditor(value);
  }
  function fromServer(value: ReportView): Editor {
    return {
      key,
      text: value.edited ?? value.draft,
      dirty: false,
      editVersion: value.editVersion,
      baseDraftVersion: value.editedFromVersion ?? value.draftVersion,
    };
  }
  useEffect(() => {
    setSelection((value) => ({
      ...value,
      fromDay:
        value.kind === 'weekly'
          ? DateTime.fromISO(day).startOf('week').toFormat('yyyy-MM-dd')
          : day,
      toDay: day,
    }));
  }, [day]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if ([...cache.current.values()].some((value) => value.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  useEffect(() => {
    if (!active || !scope) return;
    let mounted = true;
    let loading = false;
    const controller = new AbortController();
    const cached = cache.current.get(key) ?? {
      key,
      text: '',
      dirty: false,
      editVersion: 0,
      baseDraftVersion: 0,
    };
    editorRef.current = cached;
    setEditor(cached);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await api<ReportResponse>(
          `/api/report?kind=${selection.kind}&fromDay=${selection.fromDay}&toDay=${selection.toDay}&refresh=${refresh}&scope=${encodeURIComponent(scope)}`,
          { signal: controller.signal },
        );
        if (!mounted) return;
        const known = latestReports.current.get(key);
        if (value.report && isOlderReport(value.report, known)) return;
        if (value.report) latestReports.current.set(key, value.report);
        setResult({ key, data: value });
        setLoadProblem(undefined);
        const current = editorRef.current;
        if (value.report && current.key === key && !current.dirty) {
          const next = {
            key,
            text: value.report.edited ?? value.report.draft,
            dirty: false,
            editVersion: value.report.editVersion,
            baseDraftVersion: value.report.editedFromVersion ?? value.report.draftVersion,
          };
          editorRef.current = next;
          cache.current.set(key, next);
          setEditor(next);
        }
      } catch (error) {
        if (mounted)
          setLoadProblem({
            key,
            text: error instanceof Error ? error.message : 'Cannot load report.',
          });
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [key, active, refresh, scope, selection.kind, selection.fromDay, selection.toDay]);
  async function generate() {
    setBusy('generate');
    setProblem(undefined);
    try {
      await api('/api/report/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selection, scope }),
      });
      setNotice('Queued. Your draft will appear when it is ready.');
      setRefresh((value) => value + 1);
    } catch (error) {
      setProblem({ key, text: error instanceof Error ? error.message : 'Cannot generate report.' });
    } finally {
      setBusy('');
    }
  }
  async function save() {
    if (!report) return;
    const snapshot = editorRef.current;
    setBusy('save');
    setProblem(undefined);
    try {
      const value = await api<{ report: ReportView }>('/api/report/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: report.id,
          text: snapshot.text,
          editVersion: snapshot.editVersion,
          baseDraftVersion: snapshot.baseDraftVersion,
        }),
      });
      const merged = mergeSavedReport(
        snapshot,
        value.report,
        latestReports.current.get(snapshot.key),
        selectedKey.current,
      );
      latestReports.current.set(snapshot.key, merged.report);
      cache.current.set(snapshot.key, merged.editor);
      if (merged.applyToCurrent) {
        update(merged.editor);
        setResult((previous) =>
          previous?.key === snapshot.key
            ? { ...previous, data: { ...previous.data, report: merged.report } }
            : previous,
        );
        setNotice(
          merged.newerEdits
            ? 'Another tab saved newer edits after your save. Your text is preserved here.'
            : 'Saved on this computer.',
        );
      }
    } catch (error) {
      setProblem({ key, text: error instanceof Error ? error.message : 'Cannot save edits.' });
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(editorRef.current.text);
      setNotice('Report copied.');
    } catch {
      textarea.current?.focus();
      textarea.current?.select();
      setNotice('Text selected. Press ⌘C or Ctrl+C to copy.');
    }
  }
  const pending = data?.jobs.some((job) => ['queued', 'running'].includes(job.status));
  const conflict = Boolean(report && current.dirty && current.editVersion !== report.editVersion);
  const newDraft = Boolean(report && report.draftVersion > current.baseDraftVersion);
  return (
    <section className="report-pane" aria-label="Reports">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FROM ACTIVITY TO ACCOUNT</p>
          <h2>Your reports</h2>
        </div>
        <span className="muted">Draft first. Your words last.</span>
      </div>
      <div className="report-controls">
        <label>
          Report
          <select
            value={selection.kind}
            disabled={Boolean(busy)}
            onChange={(event) =>
              setSelection({
                kind: event.target.value,
                fromDay:
                  event.target.value === 'weekly'
                    ? DateTime.fromISO(day).startOf('week').toFormat('yyyy-MM-dd')
                    : day,
                toDay: day,
              })
            }
          >
            <option value="daily">Daily summary</option>
            <option value="weekly">Weekly report</option>
          </select>
        </label>
        <label>
          {selection.kind === 'daily' ? 'Date' : 'From'}
          <input
            type="date"
            value={selection.fromDay}
            max={
              selection.kind === 'daily'
                ? DateTime.now()
                    .setZone(status?.timezone ?? 'UTC')
                    .toFormat('yyyy-MM-dd')
                : selection.toDay
            }
            disabled={Boolean(busy)}
            onChange={(event) => {
              const value = event.target.value;
              if (value)
                setSelection((old) => ({
                  ...old,
                  fromDay: value,
                  ...(old.kind === 'daily' ? { toDay: value } : {}),
                }));
            }}
          />
        </label>
        {selection.kind === 'weekly' && (
          <label>
            Through
            <input
              type="date"
              value={selection.toDay}
              min={selection.fromDay}
              max={DateTime.now()
                .setZone(status?.timezone ?? 'UTC')
                .toFormat('yyyy-MM-dd')}
              disabled={Boolean(busy)}
              onChange={(event) => {
                if (event.target.value)
                  setSelection((old) => ({ ...old, toDay: event.target.value }));
              }}
            />
          </label>
        )}
        <button
          type="button"
          onClick={generate}
          disabled={!status?.configured || Boolean(busy) || pending || archived}
        >
          {pending ? 'Generating…' : report ? 'Generate new draft' : 'Generate draft'}
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="report-notice">
          {notice}
        </p>
      )}
      {data?.jobs[0]?.error && (
        <p className="notice error" role="alert">
          Last generation: {data.jobs[0].error}
        </p>
      )}
      {!data && !error && (
        <p role="status" className="empty">
          Loading report…
        </p>
      )}
      {data && !report && (
        <div className="empty">
          <span className="empty-mark">↳</span>
          <h3>{pending ? 'Putting the pieces together.' : 'A draft worth starting from.'}</h3>
          <p>
            {pending
              ? 'You can keep browsing while the agent prepares your report.'
              : 'Collect your work, then generate a report for this range.'}
          </p>
        </div>
      )}
      {report && (
        <>
          {report.warnings.length > 0 && (
            <div className="notice coverage">
              <p className="eyebrow">PARTIAL SOURCE COVERAGE</p>
              <p>{report.warnings.join(' ')}</p>
              <p>Review the available record before sharing.</p>
            </div>
          )}
          {data?.stale && (
            <p className="notice">
              Activity or collection status has changed. Generate a fresh draft to include the
              latest record.
            </p>
          )}
          {conflict && (
            <div className="notice error">
              <p>
                Saved edits changed in another tab. Your text is still here; copy it before loading
                the saved version.
              </p>
              <button
                type="button"
                className="quiet"
                disabled={Boolean(busy)}
                onClick={() => {
                  update(fromServer(report));
                  setProblem(undefined);
                }}
              >
                Load saved version
              </button>
            </div>
          )}
          {newDraft && (
            <div className="notice">
              <p>A newer AI draft is available. Your saved edits are preserved.</p>
              <button
                type="button"
                className="quiet"
                disabled={Boolean(busy)}
                onClick={() =>
                  update({
                    ...current,
                    text: report.draft,
                    baseDraftVersion: report.draftVersion,
                    dirty: true,
                  })
                }
              >
                Use latest draft
              </button>
            </div>
          )}
          <div className="editor-heading">
            <label htmlFor="report-text">
              {report.edited !== null ? 'YOUR VERSION' : 'REPORT DRAFT'}
            </label>
            <span>
              {current.dirty
                ? 'Unsaved changes'
                : report.edited !== null
                  ? 'Saved locally'
                  : 'AI generated'}{' '}
              · {current.text.length.toLocaleString()}/32,000
            </span>
          </div>
          <textarea
            id="report-text"
            ref={textarea}
            className="report-editor"
            value={current.text}
            readOnly={busy === 'save'}
            maxLength={32000}
            onChange={(event) => update({ ...current, text: event.target.value, dirty: true })}
          />
          <div className="editor-actions">
            <button
              type="button"
              onClick={save}
              disabled={!current.dirty || Boolean(busy) || conflict}
            >
              {busy === 'save' ? 'Saving…' : 'Save edits'}
            </button>
            <button type="button" className="quiet" onClick={copy} disabled={!current.text.trim()}>
              Copy report
            </button>
            <span className="muted">
              Draft {report.draftVersion} ·{' '}
              {DateTime.fromISO(report.generatedAt).toLocaleString(DateTime.DATETIME_SHORT)}
            </span>
          </div>
          <details className="draft-preview">
            <summary>View latest AI draft</summary>
            <pre>{report.draft}</pre>
          </details>
          <section className="report-sources">
            <p className="eyebrow">SUPPORTING RECORDS</p>
            <EvidenceLinks items={data?.evidence ?? []} onOpen={onEvidence} />
          </section>
        </>
      )}
    </section>
  );
}
