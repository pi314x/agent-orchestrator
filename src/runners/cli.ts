import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { JobRecord } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

const DEFAULT_TIMEOUT_SEC = 600;
/** How long to wait for trailing output after the child itself has exited. */
const FLUSH_GRACE_MS = 250;

/**
 * Backstop for instructions that ask the CLI to destroy outside any project.
 * The workspace allow-list is the real boundary; this only catches the
 * unambiguous cases (`rm -rf /`, writes to raw devices) that are never a
 * legitimate coding task, wherever the workspace points.
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /rm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME|\/\*)/i,
  /\bmkfs\b/i,
  /\bdd\s+[^|;]*\bof=\/dev\//i
];

export function assertInstructionSafe(instruction: string): void {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(instruction)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        'The cli instruction looks like a destructive filesystem operation.',
        'Narrow it to the workspace directory, or run it yourself outside the orchestrator.'
      );
    }
  }
}

export interface CliRunnerOptions {
  /** Absolute workspace roots the runner may operate inside. */
  workspaceDirs?: readonly string[];
  command?: string;
  args?: readonly string[];
  /**
   * When false the child's proxy env vars are cleared and `NO_PROXY=*` is set.
   * That steers well-behaved clients away from the network; it is not a sandbox
   * and does not stop a process that opens its own sockets.
   */
  allowNetwork?: boolean;
}

/**
 * Spawns a headless coding-agent CLI in a sandboxed workspace directory. The
 * workspace allow-list is the security boundary: without one configured the
 * runner refuses to run at all rather than defaulting to the whole filesystem.
 */
export class CliRunner implements Runner {
  readonly name = 'cli' as const;

  private readonly workspaceDirs: string[];
  private readonly command: string;
  private readonly args: string[];
  private readonly allowNetwork: boolean;

  constructor(options: CliRunnerOptions = {}) {
    this.workspaceDirs = (options.workspaceDirs ?? []).map(dir => resolve(dir));
    this.command = options.command ?? '';
    this.args = [...(options.args ?? [])];
    this.allowNetwork = options.allowNetwork ?? false;
  }

  health(): RunnerHealth {
    if (this.command === '') {
      return { name: this.name, available: false, reason: 'ORCH_CLI_COMMAND is not set.' };
    }
    if (this.workspaceDirs.length === 0) {
      return { name: this.name, available: false, reason: 'ORCH_CLI_WORKSPACE_DIRS is not set.' };
    }
    return { name: this.name, available: true, defaultModel: this.command };
  }

  /** Resolve the requested workspace and refuse anything outside the allow-list. */
  private resolveWorkspace(job: JobRecord): string {
    const requested = job.context?.['workspace'];
    const candidate = typeof requested === 'string' ? resolve(requested) : this.workspaceDirs[0];

    if (candidate === undefined) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        'The cli runner has no configured workspace directory.',
        'Set ORCH_CLI_WORKSPACE_DIRS.'
      );
    }

    const permitted = this.workspaceDirs.some(dir => candidate === dir || candidate.startsWith(`${dir}/`));

    if (!permitted) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Workspace "${candidate}" is outside the configured directories.`,
        `Allowed: ${this.workspaceDirs.join(', ')}.`
      );
    }

    return candidate;
  }

  async *run({ job }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const health = this.health();
    if (!health.available) {
      throw new OrchestratorError('RUNNER_FAILED', health.reason ?? 'The cli runner is not configured.');
    }

    assertInstructionSafe(job.instruction);
    const cwd = this.resolveWorkspace(job);
    const startedAt = Date.now();

    yield { type: 'progress', message: `Running ${this.command} in ${cwd}.` };

    const timeoutSec = job.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const result = await this.spawnProcess(cwd, job.instruction, timeoutSec, signal);

    // A killed child closes with a null exit code. Reading that as 0 would hand
    // back whatever partial stdout it had managed to write, as a success.
    if (result.signal !== null) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        result.timedOut
          ? `${this.command} did not finish within ${timeoutSec}s and was killed.`
          : `${this.command} was killed (${result.signal}) before it finished.`,
        result.timedOut ? 'Raise timeoutSec, or split the work into smaller jobs.' : undefined
      );
    }

    if (result.code !== 0) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `${this.command} exited with code ${result.code}: ${result.stderr.slice(0, 500)}`
      );
    }

    yield { type: 'text', text: result.stdout };
    yield { type: 'usage', usage: { durationMs: Date.now() - startedAt } };
  }

  private spawnProcess(
    cwd: string,
    instruction: string,
    timeoutSec: number,
    signal: AbortSignal
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }> {
    return new Promise((resolvePromise, reject) => {
      const env = this.allowNetwork
        ? process.env
        : { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' };

      // Its own process group, so a kill reaches the whole tree. A coding-agent
      // CLI spawns subprocesses; signalling only the leader orphans them.
      const child = spawn(this.command, this.args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });

      const killTree = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // No process groups on Windows (a negative pid throws ESRCH there),
          // and a tree that already exited throws anywhere — signal the leader
          // itself. Without this fallback a timed-out or aborted job never
          // dies on Windows: the throw is swallowed and the child runs on.
          try {
            child.kill(sig);
          } catch {
            // Already gone.
          }
        }
      };

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGKILL');
      }, timeoutSec * 1000);

      const onAbort = (): void => killTree('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });

      let flushTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        signal.removeEventListener('abort', onAbort);
      };

      child.on('error', error => {
        cleanup();
        reject(new OrchestratorError('RUNNER_FAILED', `Could not start ${this.command}: ${error.message}`));
      });

      let settled = false;
      const settle = (code: number | null, killedBy: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({ code: code ?? -1, stdout, stderr, signal: killedBy, timedOut });
      };

      // `close` waits for every holder of the stdio pipes, and a surviving
      // grandchild holds them forever — so `exit` is what ends the run, with a
      // short grace period for output still in flight.
      child.on('close', settle);
      child.on('exit', (code, killedBy) => {
        flushTimer = setTimeout(() => settle(code, killedBy), FLUSH_GRACE_MS);
      });

      // A child that exits before reading its instruction makes stdin emit
      // EPIPE; unhandled, that error takes the whole orchestrator down.
      child.stdin.on('error', () => undefined);
      child.stdin.write(instruction);
      child.stdin.end();
    });
  }
}
