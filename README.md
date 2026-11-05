# Worklog

A local work journal that collects your GitLab activity and turns it into
source-linked accomplishments. Codex performs collection through read-only tools;
Claude Code takes over automatically if Codex fails.

## Requirements

- Node.js 22.12 or newer, npm, and Git.
- Codex and Claude Code installed on PATH and authenticated independently.
- Access to your company's GitLab and a personal token with `read_api` access.
- Local project checkouts beneath one work folder.

The backend uses TypeScript and Effect 4, SQLite stores records locally, and React
provides the dashboard. The application listens only on `127.0.0.1`.

## Run

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4318>. The dashboard works before configuration and shows
where to create your settings file.

Create `~/.local/share/worklog/config.json` outside this repository:

```json
{
  "workRoot": "/absolute/path/to/work",
  "gitlabUrl": "https://gitlab.example.com",
  "token": "your-read-only-token",
  "timezone": "Asia/Seoul"
}
```

Keep the containing directory private and restrict the configuration file:

```sh
chmod 700 ~/.local/share/worklog
chmod 600 ~/.local/share/worklog/config.json
```

Select a date and click **Collect activity**. Worklog discovers GitLab repositories
under your work folder, asks the agent to collect each project's activity, validates
source coverage and evidence references, and saves the daily record atomically.
Repeated collection updates the record without duplicating evidence.

The token's authenticated GitLab user determines whose activity is collected.
GitLab URL must use HTTPS; SSH and HTTPS Git remotes are supported, including nested
namespaces. Multiple checkouts of the same project count once. Worklog does not
write to GitLab.

Collection currently uses GitLab's Events API. It includes supported push, merge
request, issue, and discussion events; it is not a complete audit trail of every
GitLab interaction. Local AI session ingestion, automatic schedules, report editing,
and weekly reports are subsequent implementation phases.

## Agent behavior

Each run uses a temporary workspace and the same scoped MCP tools for either CLI.
Codex runs read-only with an ephemeral session; Claude Code runs without built-in
tools or session persistence. Both retain their own existing CLI authentication.

If Codex fails, times out, or returns invalid or incomplete results, Worklog tries
Claude Code once. GitLab access failures are reported without switching agents.
If both agents fail, the previous daily record remains intact. No checkpoint is
advanced for a failed collection. Interrupted jobs are marked failed on restart.

Records stay on this computer. Selected source content is processed by the configured
agent providers; use your company's approved configurations. Credentials, transcripts,
work records, and database files must not be committed.

## Development

Use two terminals:

```sh
npm run server
npm run dev
```

Vite serves the frontend at <http://127.0.0.1:5173> and proxies API calls to port
4318. The production command serves the built frontend and API together.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`WORKLOG_CONFIG` overrides the configuration file path. `WORKLOG_DATA_DIR` overrides
the application data directory and must point outside the code repository. `PORT`
overrides the backend port; update the Vite proxy if developing on another port.
Back up the data directory with the application stopped. There is no device sync or
work-data transfer.
