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

beforeEach(async () => {
  services = await testServices();
  workspace = mkdtempSync(join(tmpdir(), 'cli-runner-'));
});

afterEach(async () => {
  await closeServices(services);
  rmSync(workspace, { recursive: true, force: true });
});

async function makeJob(overrides: Partial<JobRecord> = {}): Promise<JobRecord> {
  const agent = await services.agents.create({
    name: `cli-${Date.now()}`,
    instructions: 'Be useful.',
    runner: 'cli'
  });

  return await services.jobs.create({
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

/**
 * `node -e` with the script inline, so no fixture files are needed — and the
 * suite runs on every OS (`/bin/sh`, `cat` and `sleep` don't exist on
 * Windows, while the Node binary running the tests always does).
 */
const nodeRunner = (script: string, workspaceDirs: string[]): CliRunner =>
  new CliRunner({ command: process.execPath, args: ['-e', script], workspaceDirs });

describe('cli runner', () => {
  it('returns the child process stdout', async () => {
    // The double backslash survives the template literal so `node -e` sees
    // the `\n` escape; a single one would splice a real newline into `-e`.
    const runner = nodeRunner(`process.stdin.resume();process.stdout.write('done\\n')`, [workspace]);

    await expect(collect(runner, await makeJob())).resolves.toBe('done\n');
  });

  it('refuses a workspace outside the allow-list', async () => {
    const runner = nodeRunner(`process.stdout.write('hi')`, [workspace]);
    const job = await makeJob({ context: { workspace: '/etc' } });

    await expect(collect(runner, job)).rejects.toThrow(/outside the configured directories/);
  });

  it('reports a non-zero exit with the child stderr', async () => {
    const runner = nodeRunner(`process.stderr.write('it broke');process.exit(3)`, [workspace]);

    await expect(collect(runner, await makeJob())).rejects.toThrow(/exited with code 3.*it broke/s);
  });

  // Regression: `close` waits for every holder of the stdio pipes, so a child
  // that leaves a background process behind never closed them and the job hung
  // forever. Settling on `exit` is what ends the run.
  it('returns as soon as the child exits, even if a grandchild holds the pipes', async () => {
    const runner = nodeRunner(
      `const {spawn}=require('child_process');` +
        // The grandchild must not keep the test's temp dir as its cwd: on
        // Windows an inherited cwd locks the directory and afterEach rmdir
        // fails EBUSY. The pipes are still inherited, which is the part this
        // test needs.
        `const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'inherit',cwd:require('os').tmpdir()});` +
        `g.unref();process.stdout.write('done')`,
      [workspace]
    );

    await expect(collect(runner, await makeJob())).resolves.toContain('done');
  }, 10_000);

  // Regression: a killed child closes with a null exit code, which was read as
  // 0 — so a timed-out job succeeded, carrying whatever partial stdout existed.
  it('fails a timed-out run instead of returning its partial output', async () => {
    const runner = nodeRunner(`process.stdout.write('partial');setTimeout(()=>{},30000)`, [workspace]);
    const job = await makeJob({ timeoutSec: 1 });

    await expect(collect(runner, job)).rejects.toThrow(/did not finish within 1s/);
  });

  it('fails an aborted run rather than reporting success', async () => {
    const runner = nodeRunner(`process.stdout.write('partial');setTimeout(()=>{},30000)`, [workspace]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const run = async (): Promise<void> => {
      for await (const event of runner.run({ job: await makeJob() }, controller.signal)) {
        void event;
      }
    };

    await expect(run()).rejects.toThrow(/was killed/);
  });

  // Regression: writing the instruction to a child that already exited emits
  // EPIPE on stdin, and an unhandled stream error would kill the orchestrator.
  it('survives a child that exits before reading its instruction', async () => {
    const runner = nodeRunner('process.exit(0)', [workspace]);

    await expect(collect(runner, await makeJob({ instruction: 'x'.repeat(100_000) }))).resolves.toBe('');
  });

  it('is unavailable until both a command and a workspace are configured', async () => {
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
