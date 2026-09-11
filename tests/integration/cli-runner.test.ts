import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRunner } from '../../src/runners/cli.js';
import { toSnapshot } from '../../src/core/registry.js';
import type { JobRecord } from '../../src/core/jobs.js';
import { closeServices, testServices } from '../helpers.js';
import type { Services } from '../../src/services.js';

let services: Services;
let workspace: string;

beforeEach(() => {
  services = testServices();
  workspace = mkdtempSync(join(tmpdir(), 'cli-runner-'));
});

afterEach(async () => {
  await closeServices(services);
  rmSync(workspace, { recursive: true, force: true });
});

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const agent = services.agents.create({
    name: `cli-${Date.now()}`,
    instructions: 'Be useful.',
    runner: 'cli'
  });

  return services.jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do the thing',
    ...overrides
  });
}

async function collect(runner: CliRunner, job: JobRecord): Promise<string> {
  let text = '';
  for await (const event of runner.run({ job }, new AbortController().signal)) {
    if (event.type === 'text') text += event.text;
  }
  return text;
}

/** `sh -c` with the script inline, so no fixture files are needed. */
const shRunner = (script: string, workspaceDirs: string[]): CliRunner =>
  new CliRunner({ command: '/bin/sh', args: ['-c', script], workspaceDirs });

describe('cli runner', () => {
  it('returns the child process stdout', async () => {
    const runner = shRunner('cat > /dev/null; echo done', [workspace]);

    await expect(collect(runner, makeJob())).resolves.toBe('done\n');
  });

  it('refuses a workspace outside the allow-list', async () => {
    const runner = shRunner('echo hi', [workspace]);
    const job = makeJob({ context: { workspace: '/etc' } });

    await expect(collect(runner, job)).rejects.toThrow(/outside the configured directories/);
  });

  it('reports a non-zero exit with the child stderr', async () => {
    const runner = shRunner('echo "it broke" >&2; exit 3', [workspace]);

    await expect(collect(runner, makeJob())).rejects.toThrow(/exited with code 3.*it broke/s);
  });

  // Regression: `close` waits for every holder of the stdio pipes, so a child
  // that leaves a background process behind never closed them and the job hung
  // forever. Settling on `exit` is what ends the run.
  it('returns as soon as the child exits, even if a grandchild holds the pipes', async () => {
    const runner = shRunner('sleep 30 & echo done', [workspace]);

    await expect(collect(runner, makeJob())).resolves.toContain('done');
  }, 10_000);

  // Regression: a killed child closes with a null exit code, which was read as
  // 0 — so a timed-out job succeeded, carrying whatever partial stdout existed.
  it('fails a timed-out run instead of returning its partial output', async () => {
    const runner = shRunner('echo partial; sleep 30', [workspace]);
    const job = makeJob({ timeoutSec: 1 });

    await expect(collect(runner, job)).rejects.toThrow(/did not finish within 1s/);
  });

  it('fails an aborted run rather than reporting success', async () => {
    const runner = shRunner('echo partial; sleep 30', [workspace]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const run = async (): Promise<void> => {
      for await (const event of runner.run({ job: makeJob() }, controller.signal)) {
        void event;
      }
    };

    await expect(run()).rejects.toThrow(/was killed/);
  });

  // Regression: writing the instruction to a child that already exited emits
  // EPIPE on stdin, and an unhandled stream error would kill the orchestrator.
  it('survives a child that exits before reading its instruction', async () => {
    const runner = shRunner('exit 0', [workspace]);

    await expect(collect(runner, makeJob({ instruction: 'x'.repeat(100_000) }))).resolves.toBe('');
  });

  it('is unavailable until both a command and a workspace are configured', () => {
    expect(new CliRunner({ workspaceDirs: [workspace] }).health()).toMatchObject({
      available: false,
      reason: /ORCH_CLI_COMMAND/
    });
    expect(new CliRunner({ command: '/bin/sh' }).health()).toMatchObject({
      available: false,
      reason: /ORCH_CLI_WORKSPACE_DIRS/
    });
  });
});
