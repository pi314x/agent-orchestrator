import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { JobRecord } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

const DEFAULT_TIMEOUT_SEC = 600;

export interface CliRunnerOptions {
  /** Absolute workspace roots the runner may operate inside. */
  workspaceDirs?: readonly string[];
  command?: string;
  args?: readonly string[];
  /** When false the child is spawned with no network-bearing env vars. */
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

    const cwd = this.resolveWorkspace(job);
    const startedAt = Date.now();

    yield { type: 'progress', message: `Running ${this.command} in ${cwd}.` };

    const result = await this.spawnProcess(
      cwd,
      job.instruction,
      job.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      signal
    );

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
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const env = this.allowNetwork
        ? process.env
        : { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' };

      const child = spawn(this.command, this.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };

      child.on('error', error => {
        cleanup();
        reject(new OrchestratorError('RUNNER_FAILED', `Could not start ${this.command}: ${error.message}`));
      });

      child.on('close', code => {
        cleanup();
        resolvePromise({ code: code ?? 0, stdout, stderr });
      });

      child.stdin.write(instruction);
      child.stdin.end();
    });
  }
}
