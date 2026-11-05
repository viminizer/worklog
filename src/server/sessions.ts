import { createHash } from 'node:crypto';
import { type FileHandle, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DateTime } from 'luxon';
import type { Evidence } from '../shared/domain.js';
import type { StoreApi } from './store.js';

export interface SessionCursor {
  offset: number;
  fingerprint: string;
  cwd: string;
  modified: number;
  scope: string;
  consumedHash: string;
}
interface SessionOptions {
  workRoot: string;
  timezone: string;
  store: StoreApi;
  codexDir?: string;
  claudeDir?: string;
  signal?: AbortSignal;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const item = record(part);
      return ['text', 'input_text', 'output_text'].includes(String(item.type)) &&
        typeof item.text === 'string'
        ? item.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}
async function prefixHash(file: FileHandle, end: number, signal?: AbortSignal) {
  const digest = createHash('sha256');
  for (let position = 0; position < end; ) {
    signal?.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(262144, end - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (!bytesRead) throw new Error('Session changed while reading; retry collection.');
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest;
}
async function sessionMetadata(
  file: FileHandle,
  size: number,
  provider: string,
  signal?: AbortSignal,
) {
  let buffer = Buffer.alloc(0);
  let position = 0;
  let firstLine = '';
  const limit = 8 * 1024 * 1024;
  while (position < size && position < limit) {
    signal?.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(262144, size - position, limit - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0 || (position === size && buffer.length > 0)) {
      const length = newline >= 0 ? newline : buffer.length;
      const line = buffer.subarray(0, length).toString('utf8');
      buffer = buffer.subarray(length + (newline >= 0 ? 1 : 0));
      firstLine ||= line;
      let value: Record<string, unknown>;
      try {
        value = record(JSON.parse(line));
      } catch {
        throw new Error('Session metadata is incomplete or malformed.');
      }
      const payload = record(value.payload);
      const cwd = provider === 'codex' ? payload.cwd : value.cwd;
      if (typeof cwd === 'string')
        return { cwd, firstLine, excluded: payload.originator === 'worklog' };
    }
  }
  if (size)
    throw new Error('Cannot determine session folder within the supported 8 MB metadata limit.');
  return null;
}
export async function ingestSessions(
  options: SessionOptions,
): Promise<{ files: number; records: number; hasMore: boolean; warnings: string[] }> {
  const root = await realpath(options.workRoot);
  const scope = `${root}:${options.timezone}`;
  const warnings: string[] = [];
  let files = 0;
  let records = 0;
  let readBytes = 0;
  const roots: Array<['codex' | 'claude', string]> = [
    [
      'codex',
      options.codexDir ??
        process.env.WORKLOG_CODEX_SESSIONS_DIR ??
        join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
    ],
    [
      'claude',
      options.claudeDir ??
        process.env.WORKLOG_CLAUDE_SESSIONS_DIR ??
        join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
    ],
  ];
  async function* find(directory: string, depth = 0): AsyncGenerator<string> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) yield* find(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(directory, entry.name);
    }
  }
  for (const [provider, directory] of roots) {
    try {
      for await (const path of find(directory)) {
        try {
          options.signal?.throwIfAborted();
          const info = await stat(path);
          const previous = options.store.sessionCursor(path);
          if (
            previous &&
            previous.scope === scope &&
            info.size === previous.offset &&
            info.mtimeMs === previous.modified
          )
            continue;
          const file = await open(path, 'r');
          try {
            const metadata = await sessionMetadata(file, info.size, provider, options.signal);
            if (
              !metadata ||
              metadata.excluded ||
              basename(metadata.cwd).startsWith('worklog-agent-')
            )
              continue;
            let cwd = metadata.cwd;
            const canonical = await realpath(cwd).catch(() => resolve(cwd));
            if (!inside(root, canonical)) continue;
            files++;
            const fingerprint = `${info.dev}:${info.ino}:${hash(metadata.firstLine)}`;
            let consumed = createHash('sha256');
            let resume = false;
            if (
              previous &&
              previous.scope === scope &&
              previous.fingerprint === fingerprint &&
              info.size >= previous.offset
            ) {
              consumed = await prefixHash(file, previous.offset, options.signal);
              resume = consumed.copy().digest('hex') === previous.consumedHash;
            }
            if (!resume) consumed = createHash('sha256');
            let position = resume && previous ? previous.offset : 0;
            if (resume && previous) cwd = previous.cwd;
            let committed = position;
            let buffer = Buffer.alloc(0);
            const evidence: Evidence[] = [];
            const processLine = async (line: Buffer, offset: number) => {
              if (!line.toString().trim()) return;
              const value = record(JSON.parse(line.toString('utf8')));
              const payload = record(value.payload);
              const candidate = provider === 'codex' ? payload.cwd : value.cwd;
              if (typeof candidate === 'string')
                cwd = await realpath(candidate).catch(() => resolve(candidate));
              if (!inside(root, cwd) || value.isSidechain === true) return;
              const message =
                provider === 'codex' && value.type === 'response_item' && payload.type === 'message'
                  ? payload
                  : provider === 'claude' && ['user', 'assistant'].includes(String(value.type))
                    ? record(value.message)
                    : {};
              if (!['user', 'assistant'].includes(String(message.role))) return;
              const text = textContent(message.content).trim();
              if (
                !text ||
                /^<(?:environment_context|user_instructions)>|^# AGENTS\.md instructions/.test(text)
              )
                return;
              const time =
                typeof value.timestamp === 'string' ? DateTime.fromISO(value.timestamp) : null;
              if (!time?.isValid)
                throw new Error(`Session message has no valid timestamp: ${basename(path)}`);
              const sessionId =
                typeof value.sessionId === 'string' ? value.sessionId : basename(path, '.jsonl');
              const entryId = typeof value.uuid === 'string' ? value.uuid : String(offset);
              const id = `session:${provider}:${hash(`${path}:${fingerprint}`)}:${entryId}`;
              evidence.push({
                id,
                project: relative(root, cwd) || basename(root),
                time: time.toUTC().toJSDate().toISOString(),
                action: String(message.role),
                title: text.slice(0, 240),
                excerpt:
                  text.length > 12000
                    ? `${text.slice(0, 6000)}\n[Middle of message omitted]\n${text.slice(-6000)}`
                    : text,
                url: `/api/evidence?id=${encodeURIComponent(id)}`,
                targetType: provider,
                targetIid: null,
                session: { provider, id: sessionId, file: path, entry: entryId, workRoot: root },
              });
            };
            while (position < info.size && readBytes < 64 * 1024 * 1024) {
              options.signal?.throwIfAborted();
              const chunk = Buffer.alloc(Math.min(262144, info.size - position));
              const { bytesRead: count } = await file.read(chunk, 0, chunk.length, position);
              if (!count) break;
              position += count;
              readBytes += count;
              buffer = Buffer.concat([buffer, chunk.subarray(0, count)]);
              let newline: number;
              while ((newline = buffer.indexOf(10)) >= 0) {
                await processLine(buffer.subarray(0, newline), committed);
                consumed.update(buffer.subarray(0, newline + 1));
                committed += newline + 1;
                buffer = buffer.subarray(newline + 1);
              }
              if (buffer.length > 8 * 1024 * 1024)
                throw new Error(`Session entry exceeds 8 MB: ${basename(path)}`);
            }
            if (position === info.size && buffer.length) {
              // A valid final JSON object is safe to ingest even without a newline.
              try {
                JSON.parse(buffer.toString('utf8'));
              } catch {
                buffer = Buffer.alloc(0);
              }
              if (buffer.length) {
                await processLine(buffer, committed);
                consumed.update(buffer);
                committed += buffer.length;
              }
            }
            options.signal?.throwIfAborted();
            const consumedHash = consumed.digest('hex');
            if ((await prefixHash(file, committed, options.signal)).digest('hex') !== consumedHash)
              throw new Error('Session changed during collection; retry.');
            options.store.ingestSession(
              path,
              { offset: committed, fingerprint, cwd, modified: info.mtimeMs, scope, consumedHash },
              evidence,
              options.timezone,
            );
            records += evidence.length;
            if (readBytes >= 64 * 1024 * 1024) return { files, records, hasMore: true, warnings };
          } finally {
            await file.close();
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          warnings.push(
            `${provider} ${basename(path)}: ${error instanceof Error ? error.message : 'Cannot read session.'}`,
          );
        }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      warnings.push(
        `${provider}: ${error instanceof Error ? error.message : 'Cannot scan session directory.'}`,
      );
    }
  }
  return { files, records, hasMore: false, warnings };
}
