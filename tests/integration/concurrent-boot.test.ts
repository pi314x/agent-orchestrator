import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/core/registry.js';
import type { AgentFileDefinition } from '../../src/core/agent-files.js';
import { migratedDb } from '../helpers.js';

/**
 * Every instance syncs the agents directory as it comes up. Two instances
 * starting together — a rolling deploy, a scale-up, a restarted pod pair —
 * both read "this agent is not there yet" and both insert it. The loser used
 * to die on the way up with CONFLICT, which meant a second instance simply
 * could not be started against a fresh database.
 */
const files: AgentFileDefinition[] = [
  { name: 'coder', instructions: 'write code', toolGrants: [], sourcePath: 'agents/coder.md' },
  { name: 'critic', instructions: 'review code', toolGrants: [], sourcePath: 'agents/critic.md' }
];

describe('two instances syncing the agents directory at once', () => {
  it('both come up, and the agents land exactly once', async () => {
    const db = await migratedDb();

    const results = await Promise.allSettled([
      new AgentRegistry(db).syncFromFiles(files),
      new AgentRegistry(db).syncFromFiles(files)
    ]);

    // Neither instance fails to boot.
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);

    // Every agent exists once. Whoever lost the insert took the update path,
    // so the file's definition landed either way.
    const { agents } = await new AgentRegistry(db).list({ limit: 50 });
    const active = agents.filter(a => a.source === 'file');
    const names = active.map(a => a.name);
    expect([...names].sort()).toEqual(['coder', 'critic']);
    expect(new Set(names).size).toBe(names.length);

    // And it is the file's content that landed, not an empty shell.
    const coder = active.find(a => a.name === 'coder');
    expect(coder?.instructions).toBe('write code');

    await db.close();
  });
});
