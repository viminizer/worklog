import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Schema } from 'effect';
import { DateTime } from 'luxon';
import { validateScanDepth } from '../shared/scan-depth.js';

const ConfigSchema = Schema.Struct({
  workRoot: Schema.String,
  scanDepth: Schema.optionalKey(Schema.Number),
  gitlabUrl: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
  remoteCollection: Schema.optionalKey(Schema.Boolean),
  includedProjects: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(200))),
  includeSharedSessions: Schema.optionalKey(Schema.Boolean),
  timezone: Schema.String,
  automatic: Schema.optionalKey(Schema.Boolean),
  collectionStartDate: Schema.optionalKey(Schema.String),
});
export type AppConfig = typeof ConfigSchema.Type;
export const dataDir = resolve(
  process.env.WORKLOG_DATA_DIR ?? join(homedir(), '.local/share/worklog'),
);
export const configPath = resolve(process.env.WORKLOG_CONFIG ?? join(dataDir, 'config.json'));
async function assertPrivateLocation(path: string) {
  let parent = await realpath(dirname(path));
  while (true) {
    try {
      await stat(join(parent, '.git'));
      throw new Error('Worklog data and credentials must be stored outside Git repositories.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}
export async function prepareDataDir() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const info = await stat(dataDir);
  if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid()))
    throw new Error('Use a private data directory owned by this user with permissions 0700.');
  await assertPrivateLocation(join(dataDir, 'worklog.db'));
}
export function validateConfig(input: unknown): AppConfig {
  const scanDepth = validateScanDepth(
    input && typeof input === 'object' ? (input as Record<string, unknown>).scanDepth : undefined,
  );
  let config: AppConfig;
  try {
    config = Schema.decodeUnknownSync(ConfigSchema)(
      input && typeof input === 'object' && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
        : input,
    );
  } catch {
    throw new Error('Settings require a work folder and timezone.');
  }
  let gitlabUrl: string | undefined;
  if (config.gitlabUrl?.trim()) {
    let url: URL;
    try {
      url = new URL(config.gitlabUrl);
    } catch {
      throw new Error('Enter a valid HTTPS GitLab URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('GitLab URL must use HTTPS without credentials or query parameters.');
    gitlabUrl = url.href.replace(/\/$/, '');
  }
  const token = config.token?.trim() || undefined;
  if (config.remoteCollection && (!gitlabUrl || !token))
    throw new Error(
      'Optional GitLab collection requires an instance URL and a read-only token. Leave it off to collect local repositories.',
    );
  if (!DateTime.now().setZone(config.timezone).isValid)
    throw new Error('Enter a valid IANA timezone, such as Asia/Seoul.');
  const workRoot =
    config.workRoot === '~'
      ? homedir()
      : config.workRoot.startsWith('~/')
        ? join(homedir(), config.workRoot.slice(2))
        : config.workRoot;
  if (!workRoot.startsWith(sep))
    throw new Error('Work folder must be an absolute path or start with ~/.');
  if (config.collectionStartDate) {
    dayWindow(config.collectionStartDate, config.timezone);
    if (config.collectionStartDate > DateTime.now().setZone(config.timezone).toFormat('yyyy-MM-dd'))
      throw new Error('History start cannot be in the future.');
  }
  if (config.includedProjects?.some((id) => !/^[a-f0-9]{24}$/.test(id)))
    throw new Error('Invalid project selection. Reload the project list.');
  if (config.includedProjects?.length === 0 && config.includeSharedSessions !== true)
    throw new Error('Select a project or include shared workspace sessions.');
  return {
    ...config,
    scanDepth,
    workRoot,
    token,
    gitlabUrl,
    ...(config.includedProjects
      ? { includedProjects: [...new Set(config.includedProjects)].sort() }
      : {}),
  };
}
export async function loadConfig(path = configPath): Promise<AppConfig> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('Cannot read configuration JSON.');
  }
  return validateConfig(input);
}
export async function saveConfig(input: unknown, path = configPath): Promise<AppConfig> {
  const values = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const old = await loadConfig(path).catch(() => undefined);
  const token =
    old && values.token === '' && values.gitlabUrl === old.gitlabUrl ? old.token : values.token;
  const candidate = { ...values };
  if (token === undefined) delete candidate.token;
  else candidate.token = token;
  const config = validateConfig(candidate);
  const workRoot = await realpath(config.workRoot).catch(() => {
    throw new Error('Work folder does not exist or is not readable.');
  });
  if (!(await stat(workRoot)).isDirectory()) throw new Error('Work folder must be a directory.');
  const effective = {
    ...config,
    workRoot,
    ...(!Object.hasOwn(values, 'includedProjects') &&
    old?.workRoot === workRoot &&
    old.includedProjects !== undefined
      ? { includedProjects: old.includedProjects, includeSharedSessions: old.includeSharedSessions }
      : {}),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertPrivateLocation(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(effective, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return effective;
}
export function dayWindow(day: string, timezone: string) {
  const start = DateTime.fromISO(day, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !start.isValid || start.toISODate() !== day) {
    throw new Error('Choose a valid calendar date.');
  }
  return {
    start: start.startOf('day').toUTC().toJSDate().toISOString(),
    end: start.plus({ days: 1 }).startOf('day').toUTC().toJSDate().toISOString(),
  };
}

export function isDayFinalized(day: string, timezone: string, collectedAt: string): boolean {
  return Date.parse(collectedAt) >= Date.parse(dayWindow(day, timezone).end);
}
