import Database from 'better-sqlite3';

// A separate rollback-mode SQLite file supplies an OS-backed lifetime lock.
// It releases automatically after a crash, without stale-PID or heartbeat races.
export function acquireInstance(path: string): () => void {
  const lock = new Database(path, { timeout: 0 });
  try {
    lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  } catch {
    lock.close();
    throw new Error(
      'Another Worklog instance is using this data directory. Stop it before starting another.',
    );
  }
  return () => {
    lock.close();
  };
}
