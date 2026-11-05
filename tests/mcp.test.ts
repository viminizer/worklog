import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('exposes only read-only scoped collection tools over the real stdio transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklog-mcp-test-'));
  const config = join(directory, 'config.json');
  const task = join(directory, 'task.json');
  await writeFile(
    config,
    JSON.stringify({
      workRoot: directory,
      gitlabUrl: 'https://git.example',
      token: 'fixture-only',
      timezone: 'UTC',
    }),
  );
  await writeFile(
    task,
    JSON.stringify({
      projects: ['team/app'],
      start: '2026-11-05T00:00:00Z',
      end: '2026-11-06T00:00:00Z',
    }),
  );
  const client = new Client({ name: 'worklog-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('src/server/mcp.ts'),
      task,
      join(directory, 'audit.json'),
      config,
    ],
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'collect_project_activity',
      'read_activity_detail',
    ]);
    const result = await client.callTool({
      name: 'collect_project_activity',
      arguments: { project: 'outside/scope' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('outside this task');
    expect(JSON.stringify(result)).not.toContain('fixture-only');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
