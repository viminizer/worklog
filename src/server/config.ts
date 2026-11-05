import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Schema } from 'effect';
import { DateTime } from 'luxon';

const ConfigSchema = Schema.Struct({
  workRoot: Schema.String,
  gitlabUrl: Schema.String,
  token: Schema.String,
  timezone: Schema.String,
});
export type AppConfig = typeof ConfigSchema.Type;
export const dataDir = resolve(
  process.env.WORKLOG_DATA_DIR ?? join(homedir(), '.local/share/worklog'),
);
export const configPath = resolve(process.env.WORKLOG_CONFIG ?? join(dataDir, 'config.json'));
export async function prepareDataDir() {
  const directory = process.cwd();
  if (dataDir === directory || dataDir.startsWith(directory + sep)) {
    throw new Error('WORKLOG_DATA_DIR must be outside the application repository.');
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
}
export async function loadConfig(path = configPath): Promise<AppConfig> {
  const config = Schema.decodeUnknownSync(ConfigSchema)(JSON.parse(await readFile(path, 'utf8')));
  const url = new URL(config.gitlabUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'GitLab URL must be an HTTPS instance URL without credentials or query parameters.',
    );
  }
  if (!config.token.trim() || !DateTime.now().setZone(config.timezone).isValid) {
    throw new Error('A GitLab token and valid IANA timezone are required.');
  }
  if (!config.workRoot.startsWith(sep)) throw new Error('workRoot must be an absolute path.');
  return { ...config, gitlabUrl: url.href.replace(/\/$/, '') };
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
