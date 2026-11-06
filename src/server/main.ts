import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { DateTime } from 'luxon';
import type { AppStatus } from '../shared/domain.js';
import { AgentRunnerLive } from './agent.js';
import { collectDay } from './collection.js';
import {
  configPath,
  dataDir,
  dayWindow,
  loadConfig,
  prepareDataDir,
  saveConfig,
} from './config.js';
import { message } from './errors.js';
import { GitLab } from './gitlab.js';
import { acquireInstance } from './instance.js';
import { createQueue, dataScope, syncSourceScope } from './queue.js';
import { generateReport, reportId, validateRange } from './report.js';
import { Store, storeLayer } from './store.js';

await prepareDataDir();
const releaseInstance = acquireInstance(join(dataDir, 'instance.db'));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(storeLayer(join(dataDir, 'worklog.db')), AgentRunnerLive),
);
const store = await runtime.runPromise(
  Effect.gen(function* () {
    return yield* Store;
  }),
);
const initialConfig = await loadConfig().catch(() => undefined);
if (initialConfig) syncSourceScope(store, initialConfig);
const port = Number(process.env.PORT ?? 4318);
const webRoot = resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
const queue = createQueue({
  store,
  config: loadConfig,
  run: async (job, config, signal) => {
    if (job.kind === 'report') {
      const payload = JSON.parse(job.payload) as {
        kind: unknown;
        fromDay: unknown;
        toDay: unknown;
        force?: boolean;
      };
      const input = validateRange(payload, config.timezone);
      await runtime.runPromise(
        generateReport(job.id, input, config.timezone, payload.force === true),
        { signal },
      );
    } else {
      try {
        await runtime.runPromise(collectDay(job.id, job.day, config), { signal });
      } finally {
        if (!signal.aborted && store.hasActivity(job.day)) {
          const input = { kind: 'daily' as const, fromDay: job.day, toDay: job.day };
          store.enqueue(
            randomUUID(),
            job.day,
            'report',
            JSON.stringify({ ...input, reportId: reportId(input, store.scope()), force: false }),
          );
        }
      }
    }
  },
});
let timer: ReturnType<typeof setInterval> | undefined;
function queueStatus() {
  const next = store.state('next_auto');
  return {
    activeJob: store.running(),
    queuedJobs: store.queueCount(),
    lastCollectedAt: store.lastCollected(),
    nextAutomaticAt: Number(next) > 0 ? new Date(Number(next)).toISOString() : null,
    workerError: queue.error(),
  };
}
const dayInput = Schema.Struct({ day: Schema.String });
async function status(): Promise<AppStatus> {
  try {
    const config = await loadConfig();
    return {
      configured: true,
      remoteCollection: config.remoteCollection === true,
      workspaceId: dataScope(config),
      workspaces: store.workspaces(),
      configPath,
      workRoot: config.workRoot,
      gitlabUrl: config.gitlabUrl ?? null,
      timezone: config.timezone,
      setupError: null,
      automatic: config.automatic !== false,
      collectionStartDate:
        config.collectionStartDate ??
        DateTime.now().setZone(config.timezone).minus({ days: 6 }).toFormat('yyyy-MM-dd'),
      ...queueStatus(),
    };
  } catch (error) {
    return {
      configured: false,
      remoteCollection: false,
      workspaceId: store.scope(),
      workspaces: store.workspaces(),
      configPath,
      workRoot: null,
      gitlabUrl: null,
      timezone: 'UTC',
      automatic: true,
      collectionStartDate: DateTime.now().minus({ days: 6 }).toFormat('yyyy-MM-dd'),
      ...queueStatus(),
      setupError:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? null
          : 'Configuration could not be read. Check its JSON, required fields, HTTPS URL, and timezone.',
    };
  }
}
function json(response: ServerResponse, code: number, data: unknown) {
  response.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 262144) throw new Error('Request is too large.');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = createServer(async (request, response) => {
  // Loopback binding alone does not protect against DNS rebinding or cross-site POSTs.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '')) {
    return json(response, 403, { error: 'Invalid host.' });
  }
  if (
    request.headers.origin &&
    ![
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ].includes(request.headers.origin)
  ) {
    return json(response, 403, { error: 'Invalid origin.' });
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/status')
      return json(response, 200, await status());
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      if (!queue.pause())
        return json(response, 409, {
          error: 'Wait for the current background task to finish before changing settings.',
        });
      try {
        const saved = await saveConfig(await body(request));
        syncSourceScope(store, saved);
        store.cancelQueued();
        store.setState('next_auto', '0');
        store.setState('auto_scope', '');
        return json(response, 200, await status());
      } finally {
        queue.resume();
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/connection') {
      const config = await loadConfig().catch(() => {
        throw new Error('Save valid settings before checking GitLab.');
      });
      if (!config.gitlabUrl || !config.token)
        throw new Error(
          'Optional GitLab connection is not configured. Local repository collection does not need it.',
        );
      const userId = await new GitLab(config.gitlabUrl, config.token).identity();
      return json(response, 200, { userId });
    }
    if (request.method === 'GET' && url.pathname === '/api/report') {
      const current = await status();
      const scope = url.searchParams.get('scope') ?? current.workspaceId;
      if (!store.hasWorkspace(scope)) return json(response, 404, { error: 'Workspace not found.' });
      const workspace = store.workspaces().find((item) => item.id === scope);
      const timezone = workspace?.timezone ?? current.timezone;
      const input = validateRange(Object.fromEntries(url.searchParams), timezone, true);
      const report = store.reportForRange(scope, input.kind, input.fromDay, input.toDay);
      const evidence =
        report?.evidenceIds.flatMap((id) => {
          const value = store.evidence(id, scope);
          return value ? [value] : [];
        }) ?? [];
      const archived = scope !== current.workspaceId;
      const stale =
        report !== null &&
        !archived &&
        report.sourceRevision !== store.reportSnapshot(input.fromDay, input.toDay, timezone, scope);
      return json(response, 200, {
        report,
        evidence,
        archived,
        stale,
        jobs: report ? store.reportJobs(report.id) : store.reportJobs(reportId(input, scope)),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/report/generate') {
      const config = await loadConfig().catch(() => {
        throw new Error('Configure the workspace before generating reports.');
      });
      const raw = await body(request);
      if (raw && typeof raw === 'object' && 'scope' in raw && raw.scope !== store.scope())
        return json(response, 400, {
          error:
            'Archived workspaces are not sent to the agent. Switch workspace settings before generating new drafts.',
        });
      const input = validateRange(raw, config.timezone);
      const material = store.reportMaterial(input.fromDay, input.toDay, config.timezone);
      if (!material.evidence.length)
        return json(response, 400, {
          error: 'No stored activity in this range. Collect activity first.',
        });
      const id = store.enqueue(
        randomUUID(),
        input.toDay,
        'report',
        JSON.stringify({ ...input, reportId: reportId(input, store.scope()), force: true }),
      );
      void queue.tick();
      return json(response, 202, { jobId: id });
    }
    if (request.method === 'POST' && url.pathname === '/api/report/edit') {
      const edit = Schema.decodeUnknownSync(
        Schema.Struct({
          id: Schema.String,
          text: Schema.String,
          editVersion: Schema.Number,
          baseDraftVersion: Schema.Number,
        }),
      )(await body(request));
      if (
        edit.text.length > 32000 ||
        !Number.isInteger(edit.editVersion) ||
        edit.editVersion < 0 ||
        !Number.isInteger(edit.baseDraftVersion) ||
        edit.baseDraftVersion < 1
      )
        throw new Error('Invalid report edit. Keep reports within 32,000 characters.');
      const report = store.report(edit.id);
      if (!report) return json(response, 404, { error: 'Report not found.' });
      if (!store.saveEdit(edit.id, edit.text, edit.editVersion, edit.baseDraftVersion))
        return json(response, 409, {
          error:
            'This report changed in another tab. Your text is preserved here; copy it before reloading the saved version.',
        });
      return json(response, 200, { report: store.report(edit.id) });
    }
    if (request.method === 'GET' && url.pathname === '/api/evidence') {
      const scope = url.searchParams.get('scope') ?? store.scope();
      if (!store.hasWorkspace(scope)) return json(response, 404, { error: 'Workspace not found.' });
      const item = store.evidence(url.searchParams.get('id') ?? '', scope);
      return item
        ? json(response, 200, item)
        : json(response, 404, { error: 'Evidence not found.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/evidence-list') {
      const current = await status();
      const day =
        url.searchParams.get('day') ??
        DateTime.now().setZone(current.timezone).toFormat('yyyy-MM-dd');
      dayWindow(day, current.timezone);
      const scope = url.searchParams.get('scope') ?? current.workspaceId;
      if (!store.hasWorkspace(scope)) return json(response, 404, { error: 'Workspace not found.' });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const query = url.searchParams.get('q') ?? '';
      const kind = url.searchParams.get('kind') ?? 'all';
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 1000000 ||
        query.length > 200 ||
        !['all', 'git', 'codex', 'claude', 'gitlab'].includes(kind)
      )
        throw new Error('Invalid evidence filters or page.');
      return json(response, 200, store.evidencePage(day, scope, offset, query, kind));
    }
    if (request.method === 'GET' && url.pathname === '/api/day') {
      const current = await status();
      const day =
        url.searchParams.get('day') ??
        DateTime.now().setZone(current.timezone).toFormat('yyyy-MM-dd');
      dayWindow(day, current.timezone);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000)
        throw new Error('Invalid page offset.');
      const scope = url.searchParams.get('scope') ?? current.workspaceId;
      if (!store.hasWorkspace(scope)) return json(response, 404, { error: 'Workspace not found.' });
      return json(response, 200, store.daily(day, offset, scope));
    }
    if (request.method === 'POST' && url.pathname === '/api/collect') {
      const config = await loadConfig().catch(() => {
        throw new Error('Configure Worklog with a valid local settings file before collection.');
      });
      const { day } = Schema.decodeUnknownSync(dayInput)(await body(request));
      dayWindow(day, config.timezone);
      if (day > DateTime.now().setZone(config.timezone).toFormat('yyyy-MM-dd'))
        throw new Error('Choose today or an earlier date for collection.');
      const id = store.enqueue(randomUUID(), day);
      void queue.tick();
      return json(response, 202, { jobId: id });
    }
    if (url.pathname.startsWith('/api/'))
      return json(response, 404, { error: 'Endpoint not found.' });
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
    const requested = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
    if (requested !== webRoot && !requested.startsWith(webRoot + sep))
      return json(response, 404, { error: 'Not found.' });
    let file = requested;
    try {
      if (!(await stat(file)).isFile()) file = join(webRoot, 'index.html');
    } catch {
      file = join(webRoot, 'index.html');
    }
    const content = await readFile(file);
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/html';
    response.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return json(response, 400, {
        error: 'Configure Worklog first, then build the dashboard with npm run build.',
      });
    json(response, 400, {
      error: error instanceof SyntaxError ? 'Invalid JSON request.' : message(error),
    });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Worklog: http://127.0.0.1:${port}`);
  timer = setInterval(() => {
    void queue.tick();
  }, 1000);
  void queue.tick();
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearInterval(timer);
  if (server.listening) server.close();
  void queue.stop().finally(() => runtime.dispose().finally(releaseInstance));
}
server.on('error', (error) => {
  console.error(message(error));
  process.exitCode = 1;
  shutdown();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, shutdown);
