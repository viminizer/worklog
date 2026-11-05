import Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';
import { DateTime } from 'luxon';
import type { DailyView, Evidence, Job } from '../shared/domain.js';
import type { CollectionResult } from './agent.js';
import { StorageFailure } from './errors.js';
import type { SessionCursor } from './sessions.js';

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL,
      agent TEXT, fallback TEXT, error TEXT, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, day TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accomplishments(id INTEGER PRIMARY KEY, day TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coverage(day TEXT PRIMARY KEY, collectedAt TEXT NOT NULL);
    INSERT OR IGNORE INTO migrations VALUES(1);`);
  if (!db.prepare('SELECT version FROM migrations WHERE version=2').get()) {
    db.transaction(() => {
      db.exec('CREATE TABLE session_cursors(path TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.prepare('INSERT INTO migrations VALUES(2)').run();
    })();
  }
  db.prepare(
    "UPDATE jobs SET status='failed', error='Application stopped before collection completed. Collect again to retry.' WHERE status IN ('queued','running')",
  ).run();
  return {
    close: () => db.close(),
    sessionCursor(path: string): SessionCursor | undefined {
      const row = db.prepare('SELECT data FROM session_cursors WHERE path=?').get(path) as
        | { data: string }
        | undefined;
      return row ? (JSON.parse(row.data) as SessionCursor) : undefined;
    },
    ingestSession(path: string, cursor: SessionCursor, evidence: Evidence[], timezone: string) {
      db.transaction(() => {
        const insert = db.prepare(
          'INSERT INTO activity(id,day,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,data=excluded.data',
        );
        for (const item of evidence)
          insert.run(
            item.id,
            DateTime.fromISO(item.time).setZone(timezone).toISODate(),
            JSON.stringify(item),
          );
        db.prepare(
          'INSERT INTO session_cursors(path,data) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data',
        ).run(path, JSON.stringify(cursor));
      })();
    },
    sessionEvidence(day: string, workRoot: string): Evidence[] {
      const rows = db
        .prepare(
          "SELECT data FROM activity WHERE day=? AND id LIKE 'session:%' AND json_extract(data,'$.session.workRoot')=? ORDER BY json_extract(data,'$.time') LIMIT 5001",
        )
        .all(day, workRoot) as { data: string }[];
      if (rows.length > 5000)
        throw new Error(
          'This day has more than 5,000 session messages; reduce session scope before synthesis.',
        );
      return rows.map((row) => JSON.parse(row.data) as Evidence);
    },
    evidence(id: string): Evidence | undefined {
      const row = db.prepare('SELECT data FROM activity WHERE id=?').get(id) as
        | { data: string }
        | undefined;
      return row ? (JSON.parse(row.data) as Evidence) : undefined;
    },
    enqueue(id: string, day: string) {
      db.prepare('INSERT INTO jobs(id,day,status,createdAt) VALUES(?,?,?,?)').run(
        id,
        day,
        'queued',
        new Date().toISOString(),
      );
    },
    active() {
      return db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1").get() as
        | { id: string }
        | undefined;
    },
    attempt(id: string, agent: string, fallback: string | null) {
      db.prepare("UPDATE jobs SET status='running', agent=?, fallback=? WHERE id=?").run(
        agent,
        fallback,
        id,
      );
    },
    fail(id: string, error: string) {
      db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run(error, id);
    },
    commit(id: string, day: string, result: CollectionResult) {
      db.transaction(() => {
        const insert = db.prepare(
          'INSERT INTO activity(id,day,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day, data=excluded.data',
        );
        for (const item of result.audit.evidence) insert.run(item.id, day, JSON.stringify(item));
        db.prepare('DELETE FROM accomplishments WHERE day=?').run(day);
        const accomplishment = db.prepare('INSERT INTO accomplishments(day,data) VALUES(?,?)');
        for (const item of result.result.accomplishments)
          accomplishment.run(day, JSON.stringify(item));
        if (!result.warning)
          db.prepare(
            'INSERT INTO coverage(day,collectedAt) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET collectedAt=excluded.collectedAt',
          ).run(day, new Date().toISOString());
        db.prepare('UPDATE jobs SET status=?, agent=?, fallback=?, error=? WHERE id=?').run(
          result.warning ? 'partial' : 'succeeded',
          result.agent,
          result.fallback,
          result.warning ?? null,
          id,
        );
      })();
    },
    coverage(day: string): { collectedAt: string } | undefined {
      return db.prepare('SELECT collectedAt FROM coverage WHERE day=?').get(day) as
        | { collectedAt: string }
        | undefined;
    },
    daily(day: string, offset = 0): DailyView {
      const evidence = (
        db
          .prepare(
            "SELECT data FROM activity WHERE day=? ORDER BY json_extract(data,'$.time') DESC, id LIMIT 101 OFFSET ?",
          )
          .all(day, offset) as { data: string }[]
      ).map((row) => JSON.parse(row.data) as Evidence);
      const accomplishments = (
        db
          .prepare('SELECT id,data FROM accomplishments WHERE day=? ORDER BY id LIMIT 101 OFFSET ?')
          .all(day, offset) as { id: number; data: string }[]
      ).map((row) => ({ ...JSON.parse(row.data), id: row.id }));
      const jobs = db
        .prepare('SELECT * FROM jobs WHERE day=? ORDER BY createdAt DESC LIMIT 20')
        .all(day) as Job[];
      const hasMore = evidence.length > 100 || accomplishments.length > 100;
      const page = accomplishments.slice(0, 100);
      const ids = new Set(page.flatMap((item) => item.evidenceIds));
      const find = db.prepare('SELECT data FROM activity WHERE id=?');
      const supportingEvidence = [...ids].flatMap((id) => {
        const row = find.get(id) as { data: string } | undefined;
        return row ? [JSON.parse(row.data) as Evidence] : [];
      });
      return {
        evidence: evidence.slice(0, 100),
        supportingEvidence,
        accomplishments: page,
        jobs,
        hasMore,
      };
    },
  };
}
export type StoreApi = ReturnType<typeof openStore>;
export class Store extends Context.Service<Store, StoreApi>()('worklog/Store') {}
export const storeLayer = (path: string) =>
  Layer.effect(
    Store,
    Effect.acquireRelease(
      Effect.try({
        try: () => openStore(path),
        catch: () => new StorageFailure({ message: 'Cannot open local database.' }),
      }),
      (store) => Effect.sync(() => store.close()),
    ),
  );
