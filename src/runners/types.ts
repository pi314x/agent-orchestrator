import type { JobRecord, JobUsage } from '../core/jobs.js';
import type { RunnerName } from '../core/templates.js';
import type { AgentToolkit } from './toolkit.js';

export type RunnerEvent =
  | { type: 'progress'; message: string }
  | { type: 'text'; text: string }
  | { type: 'structured'; value: unknown }
  | { type: 'usage'; usage: JobUsage }
  /**
   * A local agent stores its own artifacts directly through the toolkit's
   * artifact_put, which has direct store access — this event exists for a
   * runner that has no toolkit at all, namely the A2A gateway normalizing a
   * remote task's file/data parts into the same artifact store local jobs use.
   */
  | { type: 'artifact'; name: string; content: string; mimeType?: string };

export interface RunnerInput {
  job: JobRecord;
  /** Present for local agents only; remote A2A agents never get one. */
  toolkit?: AgentToolkit;
  maxSteps?: number;
}

export type RunnerHealth = {
  name: RunnerName;
  available: boolean;
  reason?: string;
  defaultModel?: string;
};

/**
 * A runner executes an agent we own. The A2A gateway is deliberately not a
 * runner (PLAN §9) but implements the same shape, so the scheduler can drive
 * local and remote work through one path in M4.
 */
export interface Runner {
  readonly name: RunnerName;
  health(): RunnerHealth;
  run(input: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent>;
}

export class RunnerRegistry {
  private readonly runners = new Map<RunnerName, Runner>();

  constructor(runners: readonly Runner[] = []) {
    for (const runner of runners) this.runners.set(runner.name, runner);
  }

  register(runner: Runner): void {
    this.runners.set(runner.name, runner);
  }

  get(name: RunnerName): Runner | undefined {
    return this.runners.get(name);
  }

  list(): Runner[] {
    return [...this.runners.values()];
  }
}
