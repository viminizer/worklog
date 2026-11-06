import { DateTime } from 'luxon';
import { useState } from 'react';
import type { AppStatus } from '../shared/domain.js';
import { DEFAULT_SCAN_DEPTH, MAX_SCAN_DEPTH } from '../shared/scan-depth.js';
import { api } from './api.js';

export function Settings({
  status,
  onSaved,
  onClose,
}: {
  status: AppStatus;
  onSaved: (status: AppStatus) => void;
  onClose: () => void;
}) {
  const [workRoot, setWorkRoot] = useState(status.workRoot ?? '');
  const [scanDepth, setScanDepth] = useState(String(status.scanDepth ?? DEFAULT_SCAN_DEPTH));
  const [gitlabUrl, setGitlabUrl] = useState(status.gitlabUrl ?? '');
  const [token, setToken] = useState('');
  const [remoteCollection, setRemoteCollection] = useState(status.remoteCollection);
  const [timezone, setTimezone] = useState(
    status.configured ? status.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [automatic, setAutomatic] = useState(status.automatic);
  const [startDate, setStartDate] = useState(status.collectionStartDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = await api<AppStatus>('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workRoot,
          scanDepth: Number(scanDepth),
          gitlabUrl,
          token,
          remoteCollection,
          timezone,
          automatic,
          collectionStartDate: startDate,
        }),
      });
      setToken('');
      onSaved(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Cannot save settings.');
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    setConnection('');
    setError('');
    try {
      const value = await api<{ userId: number }>('/api/connection', { method: 'POST' });
      setConnection(`Connected as GitLab user #${value.userId}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Connection failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings notice">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h2>{status.configured ? 'Workspace settings' : 'Connect your work.'}</h2>
        </div>
        {status.configured && (
          <button className="quiet" type="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <form onSubmit={save}>
        <div className="settings-grid">
          <label>
            Work folder
            <input
              required
              value={workRoot}
              onChange={(e) => setWorkRoot(e.target.value)}
              placeholder="~/work"
              autoComplete="off"
            />
          </label>
          <label>
            Scan depth
            <input
              type="number"
              required
              min={0}
              max={MAX_SCAN_DEPTH}
              step={1}
              value={scanDepth}
              onChange={(event) => setScanDepth(event.target.value)}
              aria-describedby="scan-depth-help"
            />
            <span className="field-help" id="scan-depth-help">
              Repository discovery only. Work folder = 0; default 3 includes three levels below it.
              Increase to find deeper projects.
            </span>
          </label>
          <label>
            Reporting timezone
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Asia/Seoul"
            />
          </label>
          <label>
            History starts
            <input
              type="date"
              required
              value={startDate}
              max={DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd')}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={automatic}
              onChange={(e) => setAutomatic(e.target.checked)}
            />{' '}
            Collect automatically every 30 minutes
          </label>
        </div>
        <details className="optional-integration">
          <summary>Optional GitLab integration</summary>
          <p className="muted">
            Local repository and AI session collection works without credentials. Enable this only
            to also query GitLab.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remoteCollection}
              onChange={(event) => setRemoteCollection(event.target.checked)}
            />
            Include remote GitLab activity
          </label>
          {remoteCollection && (
            <div className="settings-grid">
              {' '}
              <label>
                GitLab instance
                <input
                  required={remoteCollection}
                  type="url"
                  value={gitlabUrl}
                  onChange={(e) => setGitlabUrl(e.target.value)}
                  placeholder="https://gitlab.example.com"
                />
              </label>
              <label>
                Read-only GitLab token
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    status.configured
                      ? 'Leave blank to keep saved token'
                      : 'Personal access token with read_api'
                  }
                  autoComplete="new-password"
                />
              </label>
            </div>
          )}
        </details>
        <p className="muted">
          Settings and records stay on this computer. Agent tasks process selected activity through
          your configured providers.
        </p>
        {status.activeJob && (
          <p role="status" className="muted">
            A task is running. Settings can be saved when it finishes.
          </p>
        )}
        {error && (
          <p className="job-error" role="alert">
            {error}
          </p>
        )}
        {connection && <p role="status">{connection}</p>}
        <div className="settings-actions">
          <button disabled={busy || Boolean(status.activeJob)} type="submit">
            {busy ? 'Working…' : 'Save workspace'}
          </button>
          {status.configured && status.remoteCollection && (
            <button className="quiet" type="button" disabled={busy} onClick={check}>
              Check saved GitLab connection
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
