import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertInstructionSafe, CliRunner } from '../../src/runners/cli.js';
import type { JobRecord } from '../../src/core/jobs.js';

/**
 * `ORCH_CLI_COMMAND` on its own can only invoke a bare command, and several
 * coding-agent CLIs need a subcommand or flag before they will run headless
 * (`codex exec`). `CliRunner` always accepted `args`; the config never passed
 * any, so those CLIs simply could not be used.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-cliargs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function job(instruction: string): JobRecord {
  return {
    id: 'job_1', ownerId: '', backend: 'local', agentId: 'a1', state: 'running', attempt: 1,
    instruction, depth: 0, priority: 0, createdAt: '', updatedAt: '',
    agentSnapshot: { agentId: 'a1', name: 'x', instructions: '', runner: 'cli', toolGrants: [], limits: {} }
  } as unknown as JobRecord;
}

describe('cli runner arguments', () => {
  it('passes configured arguments through to the process', async () => {
    // Node echoes the argv it received: it only prints them if they arrived.
    // (`printf` did this job before, but it doesn't exist on Windows while the
    // Node binary running the tests always does.)
    const runner = new CliRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'exec', '--headless'],
      workspaceDirs: [dir],
      allowNetwork: true
    });

    const events = [];
    for await (const event of runner.run({ job: job('ignored') }, new AbortController().signal)) {
      events.push(event);
    }

    const text = events.find(e => e.type === 'text');
    expect(text).toMatchObject({ type: 'text', text: 'exec|--headless' });
  });

  it('refuses an instruction that destroys outside any project', async () => {
    expect(() => assertInstructionSafe('run rm -rf / to clean up')).toThrow(/destructive filesystem/);
    expect(() => assertInstructionSafe('implement the feature in src/')).not.toThrow();
  });

  it('still runs a bare command when no arguments are configured', async () => {
    // Pipes stdin straight back to stdout, like `cat` did before it — `cat`
    // doesn't exist on Windows.
    const runner = new CliRunner({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      workspaceDirs: [dir],
      allowNetwork: true
    });

    const events = [];
    for await (const event of runner.run({ job: job('von stdin') }, new AbortController().signal)) {
      events.push(event);
    }

    // The script echoes the instruction the runner wrote to stdin.
    expect(events.find(e => e.type === 'text')).toMatchObject({ text: 'von stdin' });
  });
});
