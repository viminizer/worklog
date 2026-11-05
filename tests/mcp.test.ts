import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      sessionEvidence: Array.from({ length: 11 }, (_, index) => ({
        id: `session:${index}`,
        project: 'app',
        time: '2026-11-05T00:00:00Z',
        action: 'user',
        title: 'Work',
        url: '/api/evidence',
        targetType: 'codex',
        targetIid: null,
      })),
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
      'collect_session_activity',
      'read_activity_detail',
      'read_report_evidence',
      'read_report_material',
    ]);
    const result = await client.callTool({
      name: 'collect_project_activity',
      arguments: { project: 'outside/scope' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('outside this task');
    expect(JSON.stringify(result)).not.toContain('fixture-only');
    const first = await client.callTool({ name: 'collect_session_activity', arguments: {} });
    expect(JSON.stringify(first)).toContain('hasMore\\":true');
    let audit = JSON.parse(await readFile(join(directory, 'audit.json'), 'utf8'));
    expect(audit.covered).not.toContain('local-sessions');
    await client.callTool({ name: 'collect_session_activity', arguments: {} });
    audit = JSON.parse(await readFile(join(directory, 'audit.json'), 'utf8'));
    expect(audit.covered).toContain('local-sessions');
    expect(audit.evidence).toHaveLength(11);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
