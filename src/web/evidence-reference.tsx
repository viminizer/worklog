import { useState } from 'react';
import type { Evidence } from '../shared/domain.js';
export function EvidenceReference({
  item,
  onOpen,
  full = false,
}: {
  item: Evidence;
  onOpen: (item: Evidence) => void;
  full?: boolean;
}) {
  const provider =
    item.session?.provider === 'codex'
      ? 'Codex'
      : item.session
        ? 'Claude Code'
        : item.localGit
          ? 'Local Git'
          : 'GitLab';
  const label = `${item.project} · ${provider} ↗`;
  const children = full ? (
    <>
      <span>{label}</span>
      <p>{item.title}</p>
    </>
  ) : (
    label
  );
  const className = full ? 'evidence' : 'source-link';
  return item.session || item.localGit ? (
    <button
      type="button"
      className={className}
      title={item.title}
      aria-label={`Open ${provider} evidence: ${item.title.slice(0, 160)}`}
      onClick={() => onOpen(item)}
    >
      {children}
    </button>
  ) : (
    <a
      className={className}
      title={item.title}
      aria-label={`Open GitLab evidence in a new tab: ${item.title.slice(0, 160)}`}
      href={item.url}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

export function EvidenceLinks({
  items,
  onOpen,
}: {
  items: Evidence[];
  onOpen: (item: Evidence) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="citation-group">
      <div className={`sources${expanded ? ' expanded-citations' : ''}`}>
        {items.slice(0, expanded ? items.length : 3).map((item) => (
          <EvidenceReference key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
      {items.length > 3 && (
        <button
          type="button"
          className="quiet citation-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Fewer sources' : `+${items.length - 3} more sources`}
        </button>
      )}
    </div>
  );
}
