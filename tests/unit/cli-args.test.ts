import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRunner } from '../../src/runners/cli.js';
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
    // `printf` proves the arguments arrived: it only prints them if it got them.
    const runner = new CliRunner({
      command: 'printf',
      args: ['%s|%s', 'exec', '--headless'],
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

  it('still runs a bare command when no arguments are configured', async () => {
    const runner = new CliRunner({ command: 'cat', workspaceDirs: [dir], allowNetwork: true });

    const events = [];
    for await (const event of runner.run({ job: job('von stdin') }, new AbortController().signal)) {
      events.push(event);
    }

    // `cat` echoes the instruction the runner wrote to stdin.
    expect(events.find(e => e.type === 'text')).toMatchObject({ text: 'von stdin' });
  });
});
