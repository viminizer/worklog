import { useRef, useState } from 'react';
import type { RepositoryCheckout } from '../shared/domain.js';

export function RepairCard({
  checkout,
  disabled,
  checking,
  onRecheck,
}: {
  checkout: RepositoryCheckout;
  disabled: boolean;
  checking: boolean;
  onRecheck: () => void;
}) {
  const command = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState('');
  async function copy() {
    if (!checkout.repair?.command) return;
    try {
      await navigator.clipboard.writeText(checkout.repair.command);
      setNotice('Command copied. Replace placeholders before running it in your terminal.');
    } catch {
      if (command.current) {
        const range = document.createRange();
        range.selectNodeContents(command.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setNotice('Command selected. Press ⌘C or Ctrl+C to copy.');
    }
  }
  return (
    <div className={`repair-card${checkout.repair ? ' needs-repair' : ' ready'}`}>
      <p className="repair-path">{checkout.path}</p>
      <h3>{checkout.repair?.title ?? 'Basic checks passed'}</h3>
      {checkout.repair ? (
        <>
          <p>{checkout.repair.message}</p>
          <ol>
            {checkout.repair.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {checkout.repair.command && (
            <>
              <pre className="repair-command">
                <code ref={command}>{checkout.repair.command}</code>
              </pre>
              <button type="button" className="quiet" onClick={copy}>
                Copy manual command
              </button>
            </>
          )}
        </>
      ) : (
        <p className="muted">
          Git metadata, author identity, and a basic history read are available. Collect the
          affected date again to confirm recovery.
        </p>
      )}
      <div className="repair-actions">
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={onRecheck}
          aria-label={`Recheck ${checkout.path}`}
        >
          {checking ? 'Checking…' : 'Recheck'}
        </button>
        <span className="muted">
          Checked{' '}
          {new Date(checkout.checkedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
