import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { agentSettings } from '../src/server/agent-settings.js';

it('preserves normal Codex provider loading while disabling base and selected-profile tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklog-settings-'));
  try {
    await writeFile(
      join(directory, 'config.toml'),
      'model_provider="company"\n[mcp_servers.unrelated]\ncommand="unsafe"\n[model_providers.company]\nbase_url="https://gateway.example"\nhttp_headers={Authorization="fixture-secret"}\n',
    );
    await writeFile(
      join(directory, 'company.config.toml'),
      '[mcp_servers."other.tool"]\ncommand="unsafe"\n',
    );
    const args = await agentSettings('codex', directory, {
      CODEX_HOME: directory,
      WORKLOG_CODEX_PROFILE: 'company',
    });
    expect(args.join(' ')).toContain('"unrelated"={enabled=false}');
    expect(args.join(' ')).toContain('"other.tool"={enabled=false}');
    expect(args).toContain('company');
    expect(args).not.toContain('--ignore-user-config');
    expect(args.join(' ')).not.toContain('fixture-secret');
    expect(args).toContain('hooks');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('copies only Claude provider settings into a private file while retaining its auth home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklog-settings-'));
  try {
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          ANTHROPIC_AUTH_TOKEN: 'fixture-secret',
        },
        apiKeyHelper: 'company-auth',
        model: 'company-model',
        hooks: { SessionStart: [{ command: 'unsafe' }] },
        enabledPlugins: { unsafe: true },
        permissions: { defaultMode: 'bypassPermissions' },
      }),
    );
    const args = await agentSettings('claude', directory, { CLAUDE_CONFIG_DIR: directory });
    const path = args[args.indexOf('--settings') + 1] as string;
    const settings = JSON.parse(await readFile(path, 'utf8'));
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-secret');
    expect(settings.apiKeyHelper).toBe('company-auth');
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.hooks).toBeUndefined();
    expect(settings.enabledPlugins).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(args.join(' ')).not.toContain('fixture-secret');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('does not silently select default public providers after invalid user configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklog-settings-'));
  try {
    await writeFile(join(directory, 'config.toml'), 'token="fixture-secret"\ninvalid=[');
    await expect(agentSettings('codex', directory, { CODEX_HOME: directory })).rejects.toThrow(
      'Cannot safely load codex',
    );
    await writeFile(join(directory, 'settings.json'), '{"private":"fixture-secret",');
    await expect(
      agentSettings('claude', directory, { CLAUDE_CONFIG_DIR: directory }),
    ).rejects.toThrow('Cannot safely load claude');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
