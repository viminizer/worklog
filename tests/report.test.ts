import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentRunner, makeAgentRunner, validateReport } from '../src/server/agent.js';
import { AgentFailure } from '../src/server/errors.js';
import { generateReport, reportId, reportInputHash, validateRange } from '../src/server/report.js';
import { openStore, Store, type StoreApi } from '../src/server/store.js';
import type { Evidence } from '../src/shared/domain.js';
import { isOlderReport, mergeSavedReport } from '../src/web/report-state.js';

const evidence: Evidence = {
  id: 'event:one',
  project: 'app',
  time: '2026-11-05T10:00:00Z',
  action: 'merged',
  title: 'Implemented sign-in',
  url: 'https://git.example/app/-/merge_requests/1',
  targetType: 'MergeRequest',
  targetIid: 1,
};
const input = { kind: 'daily' as const, fromDay: '2026-11-05', toDay: '2026-11-05' };
const id = reportId(input);
const stores: StoreApi[] = [];
function store() {
  const value = openStore(':memory:');
  stores.push(value);
  return value;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const value of stores.splice(0)) value.close();
});
function seed(database: StoreApi) {
  database.enqueue('collect', input.fromDay);
  database.commit('collect', input.fromDay, {
    result: {
      accomplishments: [
        { title: 'Implemented sign-in', state: 'completed', evidenceIds: [evidence.id] },
      ],
    },
    audit: { covered: ['app'], evidence: [evidence] },
    agent: 'codex',
    fallback: null,
  });
}
function draft(database: StoreApi, text: string, jobId = 'report') {
  database.enqueue(jobId, input.toDay, 'report', JSON.stringify({ ...input, reportId: id }));
  database.saveDraft({
    jobId,
    id,
    ...input,
    draft: { text, evidenceIds: [evidence.id] },
    inputHash: text,
    sourceRevision: database.reportSnapshot(input.fromDay, input.toDay, 'UTC'),
    warnings: [],
    agent: 'codex',
    fallback: null,
  });
}
it('preserves saved edits and their lineage across new AI drafts', () => {
  const database = store();
  seed(database);
  draft(database, 'First draft.');
  expect(database.saveEdit(id, 'My reviewed wording.', 0, 1)).toBe(true);
  draft(database, 'New AI wording.', 'second');
  const report = database.report(id);
  expect(report?.draft).toBe('New AI wording.');
  expect(report?.edited).toBe('My reviewed wording.');
  expect(report?.draftVersion).toBe(2);
  expect(report?.editVersion).toBe(1);
  expect(report?.editedFromVersion).toBe(1);
});
it('preserves explicitly cleared user text instead of falling back to a draft', () => {
  const database = store();
  seed(database);
  draft(database, 'Draft.');
  database.saveEdit(id, '', 0, 1);
  draft(database, 'Replacement.', 'second');
  expect(database.report(id)?.edited).toBe('');
});
it('rejects stale edit versions from another tab', () => {
  const database = store();
  seed(database);
  draft(database, 'Draft.');
  expect(database.saveEdit(id, 'First tab.', 0, 1)).toBe(true);
  expect(database.saveEdit(id, 'Stale second tab.', 0, 1)).toBe(false);
  expect(database.report(id)?.edited).toBe('First tab.');
});
it('detects changed evidence with stable source IDs and keeps original drafts until regeneration', () => {
  const database = store();
  seed(database);
  draft(database, 'Original.');
  const report = database.report(id);
  database.enqueue('updated', input.fromDay);
  database.commit('updated', input.fromDay, {
    result: { accomplishments: [] },
    audit: { covered: ['app'], evidence: [{ ...evidence, title: 'Updated source title' }] },
    agent: 'codex',
    fallback: null,
  });
  expect(database.reportSnapshot(input.fromDay, input.toDay, 'UTC')).not.toBe(
    report?.sourceRevision,
  );
  expect(database.report(id)?.draft).toBe('Original.');
});
it('does not make a report stale merely by re-collecting identical source data', () => {
  const database = store();
  seed(database);
  draft(database, 'Original.');
  const snapshot = database.reportSnapshot(input.fromDay, input.toDay, 'UTC');
  database.enqueue('again', input.fromDay);
  database.commit('again', input.fromDay, {
    result: {
      accomplishments: [
        { title: 'Implemented sign-in', state: 'completed', evidenceIds: [evidence.id] },
      ],
    },
    audit: { covered: ['app'], evidence: [evidence] },
    agent: 'codex',
    fallback: null,
  });
  expect(database.reportSnapshot(input.fromDay, input.toDay, 'UTC')).toBe(snapshot);
});
it('uses organized accomplishments and retains their evidence, with warnings for uncollected dates', () => {
  const database = store();
  seed(database);
  const material = database.reportMaterial('2026-11-04', '2026-11-05', 'UTC');
  expect(material.accomplishments).toHaveLength(1);
  expect(material.evidence[0]?.id).toBe(evidence.id);
  expect(material.warnings).toContain('Collection is incomplete for 2026-11-04.');
  expect(reportInputHash(input, material)).not.toBe(
    reportInputHash(input, { ...material, accomplishments: [] }),
  );
});
it('keeps daily and weekly report jobs distinct and upgrades queued manual regeneration', () => {
  const database = store();
  const daily = JSON.stringify({ ...input, reportId: id, force: false });
  const weekly = JSON.stringify({
    ...input,
    kind: 'weekly',
    reportId: 'weekly:range',
    force: false,
  });
  expect(database.enqueue('daily', input.toDay, 'report', daily)).toBe('daily');
  expect(database.enqueue('weekly', input.toDay, 'report', weekly)).toBe('weekly');
  expect(
    database.enqueue(
      'manual',
      input.toDay,
      'report',
      JSON.stringify({ ...input, reportId: id, force: true }),
    ),
  ).toBe('daily');
  expect(JSON.parse(database.claim()?.payload ?? '{}').force).toBe(true);
});
it('validates range length, calendar dates, and report evidence', () => {
  expect(validateRange(input, 'UTC')).toEqual(input);
  expect(() => validateRange({ ...input, toDay: '2026-11-06' }, 'UTC')).toThrow();
  expect(() => validateRange({ ...input, kind: 'weekly', fromDay: '2026-01-01' }, 'UTC')).toThrow();
  expect(() =>
    validateReport(
      { text: 'Invented.', evidenceIds: ['missing'] },
      { covered: ['report-material'], evidence: [evidence] },
    ),
  ).toThrow();
  expect(() =>
    validateReport(
      { text: 'Draft.', evidenceIds: [evidence.id] },
      { covered: [], evidence: [evidence] },
    ),
  ).toThrow();
});
it('falls back to Claude for report generation using the same evidence contract', async () => {
  const calls: string[] = [];
  const runner = makeAgentRunner(async (command) => {
    calls.push(command.executable);
    if (command.executable === 'codex') throw new AgentFailure({ message: 'Fixture unavailable.' });
    const task = JSON.parse(await readFile(join(command.cwd, 'task.json'), 'utf8'));
    expect(task.reportMaterial.evidence[0].id).toBe(evidence.id);
    await writeFile(
      join(command.cwd, 'audit.json'),
      JSON.stringify({ covered: ['report-material'], evidence: [evidence] }),
    );
    return JSON.stringify({
      structured_output: { text: '- Implemented sign-in.', evidenceIds: [evidence.id] },
    });
  });
  const value = await Effect.runPromise(
    runner.report({
      task: {
        projects: [],
        start: input.fromDay,
        end: input.toDay,
        reportMaterial: { evidence: [evidence], accomplishments: [], warnings: [] },
      },
      configFile: '/fixture',
      onAttempt: () => {},
    }),
  );
  expect(calls).toEqual(['codex', 'claude']);
  expect(value.result.text).toContain('sign-in');
});

it('skips unchanged automatic drafts but honors explicit regeneration without touching saved edits', async () => {
  const database = store();
  seed(database);
  let calls = 0;
  const agents = AgentRunner.of({
    collect: () => Effect.fail(new AgentFailure({ message: 'unused' })),
    report: () =>
      Effect.sync(() => {
        calls++;
        return {
          result: { text: `Draft${calls}`, evidenceIds: [evidence.id] },
          audit: { covered: ['report-material'], evidence: [evidence] },
          agent: 'codex' as const,
          fallback: null,
        };
      }),
  });
  const layer = Layer.mergeAll(Layer.succeed(Store, database), Layer.succeed(AgentRunner, agents));
  const run = (jobId: string, force: boolean) =>
    Effect.runPromise(generateReport(jobId, input, 'UTC', force).pipe(Effect.provide(layer)));
  database.enqueue('auto1', input.toDay, 'report', JSON.stringify({ ...input, reportId: id }));
  await run('auto1', false);
  database.saveEdit(id, 'Reviewed text.', 0, 1);
  database.enqueue('auto2', input.toDay, 'report', JSON.stringify({ ...input, reportId: id }));
  await run('auto2', false);
  expect(calls).toBe(1);
  database.enqueue(
    'manual',
    input.toDay,
    'report',
    JSON.stringify({ ...input, reportId: id, force: true }),
  );
  await run('manual', true);
  expect(calls).toBe(2);
  expect(database.report(id)?.edited).toBe('Reviewed text.');
});

it('rejects delayed polls and preserves working text when save acknowledgements arrive out of order', () => {
  const database = store();
  seed(database);
  draft(database, 'Initial.');
  const first = database.report(id);
  if (!first) throw new Error('Expected report.');
  const editor = {
    key: 'daily-key',
    text: 'My working copy.',
    dirty: true,
    editVersion: 0,
    baseDraftVersion: 1,
  };
  database.saveEdit(id, editor.text, 0, 1);
  const acknowledgement = database.report(id);
  if (!acknowledgement) throw new Error('Expected saved report.');
  draft(database, 'Newer generated draft.', 'next');
  const newDraft = database.report(id);
  if (!newDraft) throw new Error('Expected new draft.');
  expect(isOlderReport(first, acknowledgement)).toBe(true);
  const merged = mergeSavedReport(editor, acknowledgement, newDraft, 'another-range');
  expect(merged.report.draftVersion).toBe(2);
  expect(merged.editor.text).toBe(editor.text);
  expect(merged.applyToCurrent).toBe(false);
  database.saveEdit(id, 'Another tab saved later.', 1, 2);
  const laterEdit = database.report(id);
  if (!laterEdit) throw new Error('Expected later edits.');
  const conflict = mergeSavedReport(editor, acknowledgement, laterEdit, 'daily-key');
  expect(conflict.newerEdits).toBe(true);
  expect(conflict.editor.dirty).toBe(true);
  expect(conflict.editor.text).toBe(editor.text);
  expect(conflict.report.editVersion).toBe(2);
});

it('keeps archived evidence out of current report inputs while preserving accessible history', () => {
  const database = store();
  database.setState('data_scope', 'old-scope');
  database.registerWorkspace({
    id: 'old-scope',
    workRoot: '/old',
    gitlabUrl: 'https://old.example',
    timezone: 'UTC',
    lastUsedAt: '2026-11-05',
  });
  seed(database);
  database.setState('data_scope', 'new-scope');
  database.registerWorkspace({
    id: 'new-scope',
    workRoot: '/new',
    gitlabUrl: 'https://new.example',
    timezone: 'UTC',
    lastUsedAt: '2026-11-05',
  });
  expect(database.reportMaterial(input.fromDay, input.toDay, 'UTC').evidence).toHaveLength(0);
  expect(database.reportMaterial(input.fromDay, input.toDay, 'UTC').accomplishments).toHaveLength(
    0,
  );
  expect(database.daily(input.fromDay, 0, 'old-scope').evidence).toHaveLength(1);
  database.enqueue('new-source', input.fromDay);
  database.commit('new-source', input.fromDay, {
    result: { accomplishments: [] },
    audit: { covered: [], evidence: [{ ...evidence, title: 'New scope copy' }] },
    agent: 'codex',
    fallback: null,
  });
  expect(database.evidence(evidence.id, 'old-scope')?.title).toBe('Implemented sign-in');
  expect(database.evidence(evidence.id, 'new-scope')?.title).toBe('New scope copy');
});

it('warns that today is still in progress even after successful collection', () => {
  const database = store();
  seed(database);
  expect(database.reportMaterial(input.fromDay, input.toDay, 'UTC').warnings.join(' ')).toContain(
    'Day in progress',
  );
});
