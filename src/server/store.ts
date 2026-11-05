import Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';
import { DateTime } from 'luxon';
import type { DailyView, Evidence, Job } from '../shared/domain.js';
import type { CollectionResult } from './agent.js';
import { StorageFailure } from './errors.js';
import { retainPushContext } from './evidence.js';
import { createReportStore } from './report-store.js';
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
  if (!db.prepare('SELECT version FROM migrations WHERE version=3').get()) {
    db.transaction(() => {
      db.exec(`ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'collect';
        ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN nextRunAt TEXT;
        ALTER TABLE jobs ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
        CREATE INDEX jobs_pending ON jobs(status,nextRunAt);
        CREATE TABLE scheduler_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      db.prepare('INSERT INTO migrations VALUES(3)').run();
    })();
  }
  const reports = createReportStore(db);
  db.prepare(
    "UPDATE jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END, error='Interrupted by application shutdown; resuming when possible.' WHERE status='running'",
  ).run();
  const interrupted = db
    .prepare(
      "SELECT MIN(day) AS day FROM jobs WHERE status='failed' AND kind='collect' AND NOT EXISTS(SELECT 1 FROM coverage WHERE coverage.day=jobs.day)",
    )
    .get() as { day: string | null };
  if (interrupted.day)
    db.prepare(
      "INSERT INTO scheduler_state(key,value) VALUES('backfill_day',?) ON CONFLICT(key) DO UPDATE SET value=MIN(value,excluded.value)",
    ).run(interrupted.day);
  return {
    ...reports,
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
          'INSERT INTO activity(id,day,data,scope) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET day=excluded.day,data=excluded.data',
        );
        for (const item of evidence) {
          const day = DateTime.fromISO(item.time).setZone(timezone).toISODate();
          const data = JSON.stringify(item);
          const old = db
            .prepare('SELECT day,data FROM activity WHERE id=? AND scope=?')
            .get(item.id, reports.scope()) as { day: string; data: string } | undefined;
          if (!old || old.data !== data || old.day !== day) {
            const bump = db.prepare(
              'INSERT INTO day_revisions(scope,day,revision) VALUES(?,?,1) ON CONFLICT(scope,day) DO UPDATE SET revision=revision+1',
            );
            bump.run(reports.scope(), day);
            if (old && old.day !== day) bump.run(reports.scope(), old.day);
            db.prepare('DELETE FROM coverage WHERE day=? OR day=?').run(day, old?.day ?? day);
            db.prepare(
              "INSERT INTO scheduler_state(key,value) VALUES('backfill_day',?) ON CONFLICT(key) DO UPDATE SET value=MIN(value,excluded.value)",
            ).run(old && old.day < (day ?? '') ? old.day : day);
          }
          insert.run(item.id, day, data, reports.scope());
        }
        db.prepare(
          'INSERT INTO session_cursors(path,data) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data',
        ).run(path, JSON.stringify(cursor));
      })();
    },
    sessionEvidence(day: string, workRoot: string): Evidence[] {
      const rows = db
        .prepare(
          "SELECT data FROM activity WHERE day=? AND scope=? AND id LIKE 'session:%' AND json_extract(data,'$.session.workRoot')=? ORDER BY json_extract(data,'$.time') LIMIT 5001",
        )
        .all(day, reports.scope(), workRoot) as { data: string }[];
      if (rows.length > 5000)
        throw new Error(
          'This day has more than 5,000 session messages; reduce session scope before synthesis.',
        );
      return rows.map((row) => JSON.parse(row.data) as Evidence);
    },
    evidence(id: string, scope = reports.scope()): Evidence | undefined {
      const row = db.prepare('SELECT data FROM activity WHERE id=? AND scope=?').get(id, scope) as
        | { data: string }
        | undefined;
      return row ? (JSON.parse(row.data) as Evidence) : undefined;
    },
    state(key: string): string | null {
      return (
        (
          db.prepare('SELECT value FROM scheduler_state WHERE key=?').get(key) as
            | { value: string }
            | undefined
        )?.value ?? null
      );
    },
    setState(key: string, value: string) {
      db.prepare(
        'INSERT INTO scheduler_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, value);
    },
    enqueue(
      id: string,
      day: string,
      kind = 'collect',
      payload = '{}',
      now = new Date().toISOString(),
    ) {
      const existing = db
        .prepare(
          "SELECT id,status FROM jobs WHERE day=? AND kind=? AND json_extract(payload,'$.reportId') IS json_extract(?,'$.reportId') AND status IN ('queued','running') LIMIT 1",
        )
        .get(day, kind, payload) as { id: string; status: string } | undefined;
      if (existing) {
        if (kind === 'report' && existing.status === 'queued' && JSON.parse(payload).force)
          db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(payload, existing.id);
        return existing.id;
      }
      db.prepare(
        'INSERT INTO jobs(id,day,status,createdAt,kind,payload,nextRunAt) VALUES(?,?,?,?,?,?,?)',
      ).run(id, day, 'queued', now, kind, payload, now);
      return id;
    },
    claim(now = new Date().toISOString()): Job | undefined {
      return db.transaction(() => {
        const job = db
          .prepare(
            "SELECT * FROM jobs WHERE status='queued' AND (nextRunAt IS NULL OR nextRunAt<=?) ORDER BY CASE WHEN kind='report' THEN 0 ELSE 1 END,createdAt,rowid LIMIT 1",
          )
          .get(now) as Job | undefined;
        if (!job) return undefined;
        db.prepare(
          "UPDATE jobs SET status='running', nextRunAt=NULL, attempts=attempts+1, agent=NULL, fallback=NULL WHERE id=?",
        ).run(job.id);
        return { ...job, status: 'running', attempts: job.attempts + 1 };
      })();
    },
    retry(job: Job, error: string, now = Date.now()) {
      const retry = job.attempts < 3;
      const next = new Date(now + 30000 * 2 ** Math.max(0, job.attempts - 1)).toISOString();
      db.prepare('UPDATE jobs SET status=?,error=?,nextRunAt=? WHERE id=?').run(
        retry ? 'queued' : 'failed',
        error,
        retry ? next : null,
        job.id,
      );
      if (!retry && job.kind === 'collect')
        db.prepare(
          "INSERT INTO scheduler_state(key,value) VALUES('backfill_day',?) ON CONFLICT(key) DO UPDATE SET value=MIN(value,excluded.value)",
        ).run(job.day);
    },
    running(): Job | null {
      return (
        (db.prepare("SELECT * FROM jobs WHERE status='running' LIMIT 1").get() as
          | Job
          | undefined) ?? null
      );
    },
    queueCount(): number {
      return (
        db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'").get() as {
          count: number;
        }
      ).count;
    },
    lastCollected(): string | null {
      return (
        db.prepare('SELECT MAX(collectedAt) AS time FROM coverage').get() as { time: string | null }
      ).time;
    },
    cancelQueued() {
      db.prepare(
        "UPDATE jobs SET status='cancelled',error='Settings changed before this task ran.' WHERE status='queued'",
      ).run();
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
          'INSERT INTO activity(id,day,data,scope) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET day=excluded.day, data=excluded.data',
        );
        for (const item of result.audit.evidence) {
          const old = db
            .prepare('SELECT data FROM activity WHERE id=? AND scope=?')
            .get(item.id, reports.scope()) as { data: string } | undefined;
          const value = JSON.stringify(
            retainPushContext(item, old ? (JSON.parse(old.data) as Evidence) : undefined),
          );
          if (old?.data !== value)
            db.prepare(
              'INSERT INTO day_revisions(scope,day,revision) VALUES(?,?,1) ON CONFLICT(scope,day) DO UPDATE SET revision=revision+1',
            ).run(reports.scope(), day);
          insert.run(item.id, day, value, reports.scope());
        }
        const previous = (
          db
            .prepare('SELECT data FROM accomplishments WHERE day=? AND scope=? ORDER BY id')
            .all(day, reports.scope()) as {
            data: string;
          }[]
        ).map((row) => JSON.parse(row.data));
        if (JSON.stringify(previous) !== JSON.stringify(result.result.accomplishments)) {
          db.prepare('DELETE FROM accomplishments WHERE day=? AND scope=?').run(
            day,
            reports.scope(),
          );
          const accomplishment = db.prepare(
            'INSERT INTO accomplishments(day,data,scope) VALUES(?,?,?)',
          );
          for (const item of result.result.accomplishments)
            accomplishment.run(day, JSON.stringify(item), reports.scope());
          db.prepare(
            'INSERT INTO day_revisions(scope,day,revision) VALUES(?,?,1) ON CONFLICT(scope,day) DO UPDATE SET revision=revision+1',
          ).run(reports.scope(), day);
        }
        if (result.warning)
          db.prepare(
            "INSERT INTO scheduler_state(key,value) VALUES('backfill_day',?) ON CONFLICT(key) DO UPDATE SET value=MIN(value,excluded.value)",
          ).run(day);
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
    invalidateCoverage() {
      db.prepare('DELETE FROM coverage').run();
    },
    coverage(day: string): { collectedAt: string } | undefined {
      return db.prepare('SELECT collectedAt FROM coverage WHERE day=?').get(day) as
        | { collectedAt: string }
        | undefined;
    },
    daily(day: string, offset = 0, scope = reports.scope()): DailyView {
      const evidence = (
        db
          .prepare(
            "SELECT data FROM activity WHERE day=? AND scope=? ORDER BY json_extract(data,'$.time') DESC, id LIMIT 101 OFFSET ?",
          )
          .all(day, scope, offset) as { data: string }[]
      ).map((row) => JSON.parse(row.data) as Evidence);
      const accomplishments = (
        db
          .prepare(
            'SELECT id,data FROM accomplishments WHERE day=? AND scope=? ORDER BY id LIMIT 101 OFFSET ?',
          )
          .all(day, scope, offset) as { id: number; data: string }[]
      ).map((row) => ({ ...JSON.parse(row.data), id: row.id }));
      const jobs = db
        .prepare('SELECT * FROM jobs WHERE day=? ORDER BY createdAt DESC LIMIT 20')
        .all(day) as Job[];
      const hasMore = evidence.length > 100 || accomplishments.length > 100;
      const page = accomplishments.slice(0, 100);
      const ids = new Set(page.flatMap((item) => item.evidenceIds));
      const find = db.prepare('SELECT data FROM activity WHERE id=? AND scope=?');
      const supportingEvidence = [...ids].flatMap((id) => {
        const row = find.get(id, scope) as { data: string } | undefined;
        return row ? [JSON.parse(row.data) as Evidence] : [];
      });
      return {
        evidence: evidence.slice(0, 100),
        supportingEvidence,
        accomplishments: page,
        jobs: scope === reports.scope() ? jobs : [],
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
