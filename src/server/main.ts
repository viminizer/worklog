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
import { configPath, dataDir, dayWindow, loadConfig, prepareDataDir } from './config.js';
import { message } from './errors.js';
import { acquireInstance } from './instance.js';
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
const port = Number(process.env.PORT ?? 4318);
const webRoot = resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
const controller = new AbortController();
let collection: Promise<void> | undefined;
const dayInput = Schema.Struct({ day: Schema.String });
async function status(): Promise<AppStatus> {
  try {
    const config = await loadConfig();
    return {
      configured: true,
      configPath,
      workRoot: config.workRoot,
      gitlabUrl: config.gitlabUrl,
      timezone: config.timezone,
      setupError: null,
    };
  } catch (error) {
    return {
      configured: false,
      configPath,
      workRoot: null,
      gitlabUrl: null,
      timezone: 'UTC',
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
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 16384) throw new Error('Request is too large.');
  }
  return JSON.parse(text);
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
    if (request.method === 'GET' && url.pathname === '/api/evidence') {
      const item = store.evidence(url.searchParams.get('id') ?? '');
      return item
        ? json(response, 200, item)
        : json(response, 404, { error: 'Evidence not found.' });
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
      return json(response, 200, store.daily(day, offset));
    }
    if (request.method === 'POST' && url.pathname === '/api/collect') {
      const config = await loadConfig().catch(() => {
        throw new Error('Configure Worklog with a valid local settings file before collection.');
      });
      const { day } = Schema.decodeUnknownSync(dayInput)(await body(request));
      dayWindow(day, config.timezone);
      const active = store.active();
      if (active)
        return json(response, 409, { error: 'A collection is already running.', jobId: active.id });
      const id = randomUUID();
      store.enqueue(id, day);
      collection = runtime
        .runPromise(
          collectDay(id, day, config).pipe(
            Effect.catchCause((cause) => Effect.sync(() => store.fail(id, String(cause)))),
          ),
          { signal: controller.signal },
        )
        .catch(() => store.fail(id, 'Collection interrupted. Collect again to retry.'));
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
server.listen(port, '127.0.0.1', () => console.log(`Worklog: http://127.0.0.1:${port}`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  controller.abort();
  if (server.listening) server.close();
  void Promise.resolve(collection).finally(() => runtime.dispose().finally(releaseInstance));
}
server.on('error', (error) => {
  console.error(message(error));
  process.exitCode = 1;
  shutdown();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, shutdown);
