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
    item.session?.provider === 'codex' ? 'Codex' : item.session ? 'Claude Code' : 'GitLab';
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
  return item.session ? (
    <button
      type="button"
      className={className}
      title={item.title}
      aria-label={`Open ${provider} session evidence: ${item.title.slice(0, 160)}`}
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
