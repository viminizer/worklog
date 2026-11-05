import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { AgentFailure } from './errors.js';

async function optional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function agentSettings(
  agent: 'codex' | 'claude',
  directory: string,
  env = process.env,
): Promise<string[]> {
  try {
    if (agent === 'codex') {
      const home = env.CODEX_HOME ?? join(homedir(), '.codex');
      const config = parse((await optional(join(home, 'config.toml'))) ?? '');
      const profile = env.WORKLOG_CODEX_PROFILE ?? config.profile;
      const args: string[] = [];
      const servers = new Set(Object.keys((config.mcp_servers ?? {}) as object));
      if (profile !== undefined) {
        if (typeof profile !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error();
        const content = await optional(join(home, `${profile}.config.toml`));
        if (content === undefined) throw new Error();
        const selected = parse(content);
        for (const name of Object.keys((selected.mcp_servers ?? {}) as object)) servers.add(name);
        args.push('--profile', profile);
      }
      // Keep the original auth home and provider configuration. Disable unrelated execution surfaces.
      if (servers.size)
        args.push(
          '-c',
          `mcp_servers={${[...servers].map((name) => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`,
        );
      for (const feature of [
        'hooks',
        'plugins',
        'apps',
        'shell_tool',
        'unified_exec',
        'browser_use',
        'computer_use',
        'multi_agent',
        'memories',
        'skill_mcp_dependency_install',
      ])
        args.push('--disable', feature);
      args.push(
        '--ignore-rules',
        '-c',
        'web_search="disabled"',
        '-c',
        'notify=[]',
        '-c',
        'project_doc_max_bytes=0',
      );
      return args;
    }
    const content = await optional(
      join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'),
    );
    const original = content === undefined ? {} : JSON.parse(content);
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error();
    const settings: Record<string, unknown> = { disableAllHooks: true, autoMemoryEnabled: false };
    for (const key of [
      'env',
      'apiKeyHelper',
      'awsAuthRefresh',
      'awsCredentialExport',
      'gcpAuthRefresh',
      'model',
      'effortLevel',
      'availableModels',
      'forceLoginMethod',
      'forceLoginOrgUUID',
      'forceLoginGatewayUrl',
      'otelHeadersHelper',
    ])
      if (Object.hasOwn(original, key)) settings[key] = original[key];
    const path = join(directory, 'claude-settings.json');
    await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
    return ['--setting-sources', '', '--settings', path, '--disable-slash-commands'];
  } catch {
    throw new AgentFailure({
      message: `Cannot safely load ${agent} provider settings. Check its user configuration and selected profile.`,
    });
  }
}
