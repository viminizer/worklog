import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import type {
  AgentResult,
  Evidence,
  Job,
  ReportDraft,
  ReportMaterial,
  ReportView,
  Workspace,
} from '../shared/domain.js';
import { isDayFinalized } from './config.js';

interface ReportRow extends Omit<ReportView, 'evidenceIds' | 'warnings'> {
  evidenceIds: string;
  warnings: string;
}
function view(row: ReportRow | undefined): ReportView | null {
  return row
    ? { ...row, evidenceIds: JSON.parse(row.evidenceIds), warnings: JSON.parse(row.warnings) }
    : null;
}
export function createReportStore(db: Database.Database) {
  if (!db.prepare('SELECT version FROM migrations WHERE version=4').get()) {
    db.transaction(() => {
      db.exec(`CREATE TABLE reports(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fromDay TEXT NOT NULL,toDay TEXT NOT NULL,
        draft TEXT NOT NULL,edited TEXT,draftVersion INTEGER NOT NULL,editVersion INTEGER NOT NULL DEFAULT 0,
        editedFromVersion INTEGER,generatedAt TEXT NOT NULL,editedAt TEXT,evidenceIds TEXT NOT NULL,warnings TEXT NOT NULL,
        inputHash TEXT NOT NULL,sourceRevision TEXT NOT NULL,agent TEXT NOT NULL,fallback TEXT);
        CREATE TABLE day_revisions(day TEXT PRIMARY KEY,revision INTEGER NOT NULL);
        INSERT INTO day_revisions SELECT day,1 FROM activity GROUP BY day;
        CREATE TABLE report_revisions(reportId TEXT NOT NULL REFERENCES reports(id),version INTEGER NOT NULL,draft TEXT NOT NULL,
        generatedAt TEXT NOT NULL,evidenceIds TEXT NOT NULL,warnings TEXT NOT NULL,inputHash TEXT NOT NULL,agent TEXT NOT NULL,fallback TEXT,
        PRIMARY KEY(reportId,version));`);
      db.prepare('INSERT INTO migrations VALUES(4)').run();
    })();
  }
  if (!db.prepare('SELECT version FROM migrations WHERE version=5').get()) {
    db.transaction(() => {
      db.exec(
        `CREATE TABLE activity_scoped(id TEXT NOT NULL,day TEXT NOT NULL,data TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'legacy',PRIMARY KEY(scope,id));
        INSERT INTO activity_scoped SELECT id,day,data,'legacy' FROM activity;
        DROP TABLE activity;ALTER TABLE activity_scoped RENAME TO activity;
        ALTER TABLE accomplishments ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE reports ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy';
        CREATE UNIQUE INDEX reports_scoped_range ON reports(scope,kind,fromDay,toDay);
        CREATE TABLE revisions_scoped(scope TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,day));
        INSERT INTO revisions_scoped SELECT 'legacy',day,revision FROM day_revisions;
        DROP TABLE day_revisions;ALTER TABLE revisions_scoped RENAME TO day_revisions;
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,workRoot TEXT,gitlabUrl TEXT,timezone TEXT NOT NULL,lastUsedAt TEXT NOT NULL);
        INSERT INTO workspaces SELECT 'legacy',NULL,NULL,'UTC',datetime('now') WHERE EXISTS(SELECT 1 FROM activity) OR EXISTS(SELECT 1 FROM reports);`,
      );
      db.prepare('INSERT INTO migrations VALUES(5)').run();
    })();
  }
  const currentScope = () =>
    (
      db.prepare("SELECT value FROM scheduler_state WHERE key='data_scope'").get() as
        | { value: string }
        | undefined
    )?.value ?? 'legacy';
  function warnings(fromDay: string, toDay: string, timezone: string, scope = currentScope()) {
    const result: string[] = [];
    if (scope !== currentScope()) return result;
    const today = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
    for (
      let date = DateTime.fromISO(fromDay, { zone: timezone });
      date.toFormat('yyyy-MM-dd') <= toDay;
      date = date.plus({ days: 1 })
    ) {
      const day = date.toFormat('yyyy-MM-dd');
      const coverage = db.prepare('SELECT collectedAt FROM coverage WHERE day=?').get(day) as
        | { collectedAt: string }
        | undefined;
      const latest = db
        .prepare(
          "SELECT status FROM jobs WHERE day=? AND kind='collect' ORDER BY createdAt DESC,rowid DESC LIMIT 1",
        )
        .get(day) as { status: string } | undefined;
      if (
        !coverage ||
        (day < today && !isDayFinalized(day, timezone, coverage.collectedAt)) ||
        (latest && latest.status !== 'succeeded')
      )
        result.push(`Collection is incomplete for ${day}.`);
      else if (day === today)
        result.push(
          `Day in progress for ${day}; only activity available at the last collection is included.`,
        );
    }
    return result;
  }
  return {
    reportSnapshot(
      fromDay: string,
      toDay: string,
      timezone: string,
      workspace = currentScope(),
    ): string {
      const scope =
        (
          db.prepare("SELECT value FROM scheduler_state WHERE key='source_scope'").get() as
            | { value: string }
            | undefined
        )?.value ?? null;
      const versions = db
        .prepare(
          'SELECT day,revision FROM day_revisions WHERE scope=? AND day BETWEEN ? AND ? ORDER BY day',
        )
        .all(workspace, fromDay, toDay);
      return JSON.stringify({
        scope,
        versions,
        warnings: warnings(fromDay, toDay, timezone, workspace),
      });
    },
    scope: currentScope,
    workspaces(): Workspace[] {
      return db
        .prepare('SELECT * FROM workspaces ORDER BY lastUsedAt DESC LIMIT 100')
        .all() as Workspace[];
    },
    hasWorkspace(id: string): boolean {
      return (
        id === currentScope() || Boolean(db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(id))
      );
    },
    registerWorkspace(input: Workspace) {
      db.prepare(
        'INSERT INTO workspaces(id,workRoot,gitlabUrl,timezone,lastUsedAt) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workRoot=excluded.workRoot,gitlabUrl=excluded.gitlabUrl,timezone=excluded.timezone,lastUsedAt=excluded.lastUsedAt',
      ).run(input.id, input.workRoot, input.gitlabUrl, input.timezone, input.lastUsedAt);
    },
    reportForRange(scope: string, kind: string, fromDay: string, toDay: string) {
      return view(
        db
          .prepare('SELECT * FROM reports WHERE scope=? AND kind=? AND fromDay=? AND toDay=?')
          .get(scope, kind, fromDay, toDay) as ReportRow | undefined,
      );
    },
    report(id: string) {
      return view(db.prepare('SELECT * FROM reports WHERE id=?').get(id) as ReportRow | undefined);
    },
    hasActivity(day: string): boolean {
      return Boolean(
        db
          .prepare('SELECT 1 FROM activity WHERE day=? AND scope=? LIMIT 1')
          .get(day, currentScope()),
      );
    },
    reportMaterial(
      fromDay: string,
      toDay: string,
      timezone: string,
      scope = currentScope(),
    ): ReportMaterial {
      const result: ReportMaterial = {
        evidence: [],
        accomplishments: [],
        warnings: warnings(fromDay, toDay, timezone, scope),
      };
      const evidence = new Map<string, Evidence>();
      for (
        let date = DateTime.fromISO(fromDay, { zone: timezone });
        date.toFormat('yyyy-MM-dd') <= toDay;
        date = date.plus({ days: 1 })
      ) {
        const day = date.toFormat('yyyy-MM-dd');
        const rows = db
          .prepare(
            'SELECT data FROM accomplishments WHERE day=? AND scope=? ORDER BY id LIMIT 1001',
          )
          .all(day, scope) as { data: string }[];
        if (rows.length > 1000)
          throw new Error('Too many accomplishments; choose a shorter report range.');
        const accomplishments = rows.map((row) => ({
          ...(JSON.parse(row.data) as AgentResult['accomplishments'][number]),
          day,
        }));
        result.accomplishments.push(...accomplishments);
        const coverage = db.prepare('SELECT collectedAt FROM coverage WHERE day=?').get(day) as
          | { collectedAt: string }
          | undefined;
        const latest = db
          .prepare(
            "SELECT status FROM jobs WHERE day=? AND kind='collect' ORDER BY createdAt DESC,rowid DESC LIMIT 1",
          )
          .get(day) as { status: string } | undefined;
        if (accomplishments.length && coverage && latest?.status === 'succeeded') {
          const find = db.prepare('SELECT data FROM activity WHERE id=? AND scope=?');
          for (const item of accomplishments)
            for (const id of item.evidenceIds) {
              const source = find.get(id, scope) as { data: string } | undefined;
              if (source) evidence.set(id, JSON.parse(source.data));
            }
        } else {
          const sources = db
            .prepare('SELECT data FROM activity WHERE day=? AND scope=? ORDER BY id LIMIT 5001')
            .all(day, scope) as { data: string }[];
          if (sources.length > 5000)
            throw new Error(
              'More than 5,000 unorganized source records; collect this day before generating a report.',
            );
          for (const source of sources) {
            const item = JSON.parse(source.data) as Evidence;
            evidence.set(item.id, item);
          }
        }
        if (result.accomplishments.length > 2000 || evidence.size > 5000)
          throw new Error('Report input is too large; choose a shorter range.');
      }
      result.evidence = [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id));
      return result;
    },
    saveDraft(input: {
      jobId: string;
      id: string;
      kind: 'daily' | 'weekly';
      fromDay: string;
      toDay: string;
      draft: ReportDraft;
      scope?: string;
      inputHash: string;
      sourceRevision: string;
      warnings: string[];
      agent: string;
      fallback: string | null;
    }) {
      db.transaction(() => {
        const now = new Date().toISOString();
        const previous = db.prepare('SELECT draftVersion FROM reports WHERE id=?').get(input.id) as
          | { draftVersion: number }
          | undefined;
        const version = (previous?.draftVersion ?? 0) + 1;
        const values = [
          input.scope ?? currentScope(),
          input.id,
          input.kind,
          input.fromDay,
          input.toDay,
          input.draft.text,
          version,
          now,
          JSON.stringify(input.draft.evidenceIds),
          JSON.stringify(input.warnings),
          input.inputHash,
          input.sourceRevision,
          input.agent,
          input.fallback,
        ];
        db.prepare(`INSERT INTO reports(scope,id,kind,fromDay,toDay,draft,draftVersion,generatedAt,evidenceIds,warnings,inputHash,sourceRevision,agent,fallback)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft,draftVersion=excluded.draftVersion,
          generatedAt=excluded.generatedAt,evidenceIds=excluded.evidenceIds,warnings=excluded.warnings,inputHash=excluded.inputHash,sourceRevision=excluded.sourceRevision,agent=excluded.agent,fallback=excluded.fallback`).run(
          ...values,
        );
        db.prepare(
          'INSERT INTO report_revisions(reportId,version,draft,generatedAt,evidenceIds,warnings,inputHash,agent,fallback) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          input.id,
          version,
          input.draft.text,
          now,
          JSON.stringify(input.draft.evidenceIds),
          JSON.stringify(input.warnings),
          input.inputHash,
          input.agent,
          input.fallback,
        );
        db.prepare(
          "UPDATE jobs SET status='succeeded',agent=?,fallback=?,error=NULL,nextRunAt=NULL WHERE id=?",
        ).run(input.agent, input.fallback, input.jobId);
      })();
    },
    saveEdit(id: string, text: string, editVersion: number, baseDraftVersion: number): boolean {
      return (
        db
          .prepare(
            'UPDATE reports SET edited=?,editVersion=editVersion+1,editedFromVersion=?,editedAt=? WHERE id=? AND editVersion=? AND draftVersion>=?',
          )
          .run(text, baseDraftVersion, new Date().toISOString(), id, editVersion, baseDraftVersion)
          .changes === 1
      );
    },
    completeUnchanged(id: string, reportId: string, sourceRevision: string) {
      db.prepare('UPDATE reports SET sourceRevision=? WHERE id=?').run(sourceRevision, reportId);
      db.prepare(
        "UPDATE jobs SET status='succeeded',agent='unchanged',error=NULL,nextRunAt=NULL WHERE id=?",
      ).run(id);
    },
    reportJobs(id: string) {
      return db
        .prepare(
          "SELECT * FROM jobs WHERE kind='report' AND json_extract(payload,'$.reportId')=? ORDER BY createdAt DESC,rowid DESC LIMIT 10",
        )
        .all(id) as Job[];
    },
  };
}
