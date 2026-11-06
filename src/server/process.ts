import { spawn } from 'node:child_process';
import { AgentFailure } from './errors.js';

export interface Command {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
}
export type Execute = (command: Command, signal: AbortSignal) => Promise<string>;
export const execute: Execute = (command, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let size = 0;
    let failure: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    function kill(force = false) {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
    function stop(reason: string) {
      failure ??= reason;
      kill();
      escalation ??= setTimeout(() => kill(true), 1000);
    }
    const timeout = setTimeout(() => stop('Agent timed out.'), command.timeoutMs);
    const abort = () => stop('Agent run was cancelled.');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const consume = (chunk: Buffer, save: boolean) => {
      size += chunk.length;
      if (size > 2_000_000) stop('Agent output exceeded 2 MB.');
      else if (save) stdout += chunk.toString();
    };
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.stdin.on('error', () => {
      /* Process exit is handled below. */
    });
    child.stdin.end(command.input);
    child.on('error', () => {
      failure = `Cannot start ${command.executable}. Check installation and authentication.`;
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      // MCP descendants must not survive the owning agent, including successful runs.
      kill(true);
      if (failure || code !== 0)
        reject(
          new AgentFailure({
            message:
              failure ??
              `${command.executable} exited with code ${code}. Check its authentication or usage limits.`,
          }),
        );
      else resolve(stdout);
    });
  });

// For displayed manual repair commands only; subprocess execution always uses argument arrays.
export function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
