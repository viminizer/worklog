# Worklog

A local work journal that investigates repositories beneath your work folder and turns local commits and AI sessions into source-linked accomplishments. Codex performs collection through read-only tools;
Claude Code takes over automatically if Codex fails.

## Requirements

- macOS or Linux, Node.js 22.12 or newer, npm, and Git.
- Codex and Claude Code installed on PATH and authenticated independently.
- Local project checkouts beneath one work folder.

The backend uses TypeScript and Effect 4, SQLite stores records locally, and React
provides the dashboard. The application listens only on `127.0.0.1`.

## Run

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4318>. Complete **Connect your work** with a work folder,
timezone, and history start date. `~` and `~/work` expand to your home directory.
No GitHub or GitLab credentials are required. Settings cannot change during an
active background task.

The default collector reads local repository history without fetching or making
host API calls. GitLab API collection is off unless explicitly enabled under
**Optional GitLab integration**; that option requires its URL and a saved read-only
token. Existing saved tokens stay saved on a blank same-instance update.

Stop the application before editing configuration manually. For manual configuration, create `~/.local/share/worklog/config.json` outside this repository:

```json
{
  "workRoot": "/absolute/path/to/work",
  "timezone": "Asia/Seoul",
  "automatic": true,
  "collectionStartDate": "2026-11-01"
}
```

Keep the containing directory private and restrict the configuration file:

```sh
chmod 700 ~/.local/share/worklog
chmod 600 ~/.local/share/worklog/config.json
```

Select a date and click **Collect activity**. Worklog discovers Git repositories
under your work folder, asks the agent to inspect each repository, validates
source coverage and evidence references, and saves the daily record atomically.
Repeated collection updates the record without duplicating evidence.

For optional GitLab API collection, the token's authenticated GitLab user determines whose remote activity is collected.
GitLab URL must use HTTPS; SSH and HTTPS Git remotes are supported, including nested
namespaces. Multiple checkouts of the same project count once. Worklog does not
write to GitLab.

GitLab collection uses its Events API. It includes supported push, merge
request, issue, and discussion events; it is not a complete audit trail of every
GitLab interaction. The agent can inspect pushed-commit ranges through the
[GitLab comparison API](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits),
showing up to 25 titles with explicit omissions. When the previous ref is missing,
only the tip commit is available. Pushing a coworker's commits does not establish
authorship. Inspected commit context is retained with the source evidence. Daily and weekly reports use the stored record and can be generated even when GitLab is currently unreachable.

## Local repository collection

Worktrees sharing a Git common directory are grouped as one project. Collection reads
all existing refs once and includes configured author emails from the valid member
checkouts. Broken checkouts remain visible; Worklog never prunes or deletes them.
Existing citations remain accessible when duplicate commit evidence is grouped.

The agent reads commits across refs already present in each repository and can inspect
commit summaries and changed-file statistics. No remote is required. It never runs
fetch, pull, push, or writes to repositories. Commits are attributed by each
repository's effective `git config user.email` and grouped by commit time in your
reporting timezone. Configure the correct email locally in repositories that use a
different work identity. A local commit does not prove deployment or passing tests.

Only committed Git history is collected; ongoing uncommitted work can still be
represented by eligible AI sessions. Empty repositories and days without commits
are valid. Missing author configuration, unreadable repositories, and collection
limits appear in **Collection status** with manual repair guidance. Fix the setup
on this computer, then collect that date again. Healthy sources remain available
and partial collections do not mark the date complete.

## Agent behavior

Each run uses a temporary workspace and the same scoped MCP tools for either CLI.
Codex runs read-only with an ephemeral session; Claude Code runs without built-in
tools or session persistence. Both retain their existing CLI authentication homes. Codex keeps its configured model,
provider, authentication helpers, and network transport; unrelated MCP servers,
plugins, lifecycle hooks, shell/browser tools, and extra agents are disabled for
Worklog runs. Set `WORKLOG_CODEX_PROFILE=company` when you normally select a named
Codex profile. Claude copies user-level environment, model, and authentication
helper settings into a private temporary file; unrelated hooks and plugin settings
are excluded. Organization-managed policy remains enforced by the CLIs. Start
Worklog from the same approved shell environment you use for those CLIs.

Provider settings follow the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference).
Worklog does not change either CLI's saved settings.

If Codex fails, times out, or returns invalid or incomplete results, Worklog tries
Claude Code once. GitLab access failures are reported without switching agents.
If both agents fail, the previous daily record remains intact. No checkpoint is
advanced for a failed collection. Interrupted jobs resume on restart within their attempt budget.

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

## Local AI sessions

Collection also incrementally reads Codex JSONL history (`$CODEX_HOME/sessions`,
otherwise `~/.codex/sessions`) and Claude Code history (`$CLAUDE_CONFIG_DIR/projects`,
otherwise `~/.claude/projects`). Sessions must begin under the configured work root;
messages after a recorded move outside that root are excluded. Symlinks are resolved.
Claude sidechain messages are excluded to avoid duplicating parent conversations.

Only user and assistant text is selected; system instructions, tool outputs, and
reasoning traces are excluded. Long messages retain the first and last 6,000 characters with an explicit omission marker.
Click a local session source to inspect its stored excerpt in the dashboard.
An AI session is evidence of discussion or attempted work, not proof of completion.

Offsets and selected evidence are committed together per session file. Appended
messages are read next time; incomplete trailing JSON is retained until complete.
Replacing or truncating files resets reading within the same workspace without discarding existing evidence. Files that cross a workspace boundary retain an isolation barrier; if their consumed contents change, start a new coding session as indicated by the source warning.
Worklog's automated agents use ephemeral/nonpersistent sessions in temporary folders
outside the work root, preventing self-collection.

Each ingestion pass reads at most 64 MB of eligible new session data. If more remains,
the job is marked partial and asks you to collect again; already ingested data and progress are preserved.
A malformed completed entry or entry over 8 MB produces a visible source warning; GitLab collection can still proceed.
Session ingestion commits independently before GitLab calls, so a later GitLab failure
does not discard new local evidence.

For nonstandard session storage, `WORKLOG_CODEX_SESSIONS_DIR` and
`WORKLOG_CLAUDE_SESSIONS_DIR` override the reader directories independently of the
CLI authentication homes.

## Automatic collection and recovery

Automatic collection checks every 30 minutes while the process runs. On startup or
wake it schedules today and catches up missing dates from the configured history
start, in bounded batches. The default history start is six days before setup.
Missing historical dates remain eligible after failures. Set a later history start
to bound initial catch-up; older dates can always be collected manually.

SQLite stores queued tasks and retry times. Duplicate requests for a pending day
coalesce. One agent task runs at a time, with at most three job attempts and 30/60-second
retry delays. Codex-to-Claude fallback happens within each attempt. Interrupted
jobs resume after restart while retaining their attempt budget; exhausted historical
jobs can be retried by a later automatic check. The dashboard shows global queue
status, per-day attempts, and last complete collection.

Turn automatic collection off in Settings for manual-only use. Saving settings
cancels queued tasks and restarts the scheduler from the chosen history scope; it
does not remove stored records. Stop the process with Ctrl+C before backups.
Data and credentials must be outside Git repositories, including symlinked locations.

A historical day is finalized only by collection after that day ends in the configured
timezone. New session evidence invalidates affected dates for catch-up. Changing the
work root, GitLab instance, token, or timezone clears completeness markers while
preserving stored records, so historical dates are checked against the new sources.

## Reports and editing

Open **Reports** to read today's daily summary or select **Weekly report** and a
range. Ranges are inclusive and can span 1–31 days; future dates are excluded.
Reports draw on organized accomplishments and their source evidence. When a day
has not been organized successfully, the available raw record is included instead.
Missing or unfinalized source coverage is displayed explicitly.

Each collection attempt with stored activity queues a daily draft. Automatic report
jobs skip regeneration when their input is unchanged. **Generate new draft** always
requests a fresh version. Both tasks use Codex first and automatically fall back to
Claude Code on agent failure. Source records are read locally for reporting; reports
do not need another GitLab collection.

Edit the text and click **Save edits**. Generated drafts and your saved version are
separate: new drafts never replace saved edits, including an intentionally empty
version. A newer draft remains available through **View latest AI draft** and
**Use latest draft**. Source links open GitLab or the stored session excerpt.

Unsaved text stays in memory when switching ranges or views, and the page warns
before leaving with unsaved changes. It is durable only after **Save edits**.
Conflicting saves from another tab are rejected while preserving your working text.
**Copy report** copies the current editor contents; if clipboard permission is
unavailable, it selects the text for manual copying. Nothing is posted to Slack,
GitLab, or another service automatically.

Activity or interpretation changes mark existing reports stale. Your saved text
remains accessible while you generate and review a new draft. Draft revisions are
retained in SQLite; changing settings does not delete reports or work history.

Changing the work folder or GitLab instance starts a separate workspace. Use
**History** to browse previous records and edit or copy saved reports. Archived
records are excluded from current collection and report generation. Existing data
from older versions appears as **Imported history**. Previously read session messages
remain in their original workspace; only newly appended messages enter the new one.
Today's reports explicitly state that the day is still in progress.

## Verification

`npm test` uses temporary databases, synthetic source files, mocked GitLab responses,
and fake CLI subprocesses. It does not need GitLab or model credentials. GitHub Actions
runs lint, typecheck, tests, and a production build on every main push and pull request.
Real Codex/Claude and company-network smoke checks are separate from these tests.
