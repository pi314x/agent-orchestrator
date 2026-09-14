import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../src/core/bus.js';
import { migratedDb } from '../helpers.js';

describe('MessageBus', () => {
  it('sends a message and lists it back', async () => {
    const bus = new MessageBus(await migratedDb());
    const sent = await bus.send({ toAgentId: 'agt_1', body: 'hello' });

    expect(await bus.list({ agentId: 'agt_1' })).toEqual([sent]);
  });

  it('requires at least one recipient', async () => {
    const bus = new MessageBus(await migratedDb());
    await expect(bus.send({ body: 'nowhere' })).rejects.toThrow(/recipient/);
  });

  it('markRead only touches the given ids, once', async () => {
    const bus = new MessageBus(await migratedDb());
    const a = await bus.send({ toAgentId: 'agt_1', body: 'a' });
    const b = await bus.send({ toAgentId: 'agt_1', body: 'b' });

    expect(await bus.markRead([a.messageId])).toBe(1);
    expect(await bus.markRead([a.messageId])).toBe(0); // already read
    const unread = await bus.list({ agentId: 'agt_1', unreadOnly: true });
    expect(unread.map(m => m.messageId)).toEqual([b.messageId]);
  });

  describe('createChannel', () => {
    it('creates a channel with its own id kind, not a message id', async () => {
      const bus = new MessageBus(await migratedDb());
      const channel = await bus.createChannel('team', ['alice']);

      expect(channel.channelId).toMatch(/^chan_/);
      expect(channel.members).toEqual(['alice']);
    });

    it('returns the existing channel for a repeated name instead of erroring', async () => {
      const bus = new MessageBus(await migratedDb());
      const first = await bus.createChannel('team', ['alice']);
      const second = await bus.createChannel('team', ['bob']);

      expect(second.channelId).toBe(first.channelId);
      // The second call's members are ignored — the channel already exists.
      expect(second.members).toEqual(['alice']);
    });

    // Regression: createChannel used to SELECT for an existing name and only
    // INSERT if none was found — two steps, not one. `name` carries a UNIQUE
    // constraint, so two callers whose SELECTs both ran before either
    // INSERT committed (two instances sharing a database, or just bad
    // timing) would both try to INSERT, and the loser got a raw SQLite
    // constraint violation instead of the channel the winner just created.
    //
    // This can't be reproduced by calling createChannel() twice in a test:
    // it is one synchronous call, so the second call's own SELECT always
    // sees whatever the first already committed, in both the old and the
    // new code — the guard itself hides the bug from a single-threaded
    // reproduction. What actually changed is the INSERT statement, so that
    // is what this asserts directly: two inserts for the same name, with no
    // SELECT in between (exactly what two racing callers would each run
    // once their SELECTs had both already missed the row), must not throw.
    // The plain INSERT this replaced would raise SQLITE_CONSTRAINT_UNIQUE
    // here; ON CONFLICT (name) DO UPDATE must not.
    it("the channel insert survives a name collision the caller's own guard cannot see coming", async () => {
      const db = await migratedDb();
      const insert = db.prepare(
        `INSERT INTO channels (id, name, members, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET name = excluded.name`
      );

      insert.run('chan_a', 'team', JSON.stringify(['alice']), new Date().toISOString());
      expect(() => insert.run('chan_b', 'team', JSON.stringify(['bob']), new Date().toISOString())).not.toThrow();

      const row = (await db.prepare('SELECT * FROM channels WHERE name = ?').get('team')) as { id: string };
      expect(row.id).toBe('chan_a');
    });
  });

  it('listChannels lists every channel, alphabetically', async () => {
    const bus = new MessageBus(await migratedDb());
    await bus.createChannel('zeta');
    await bus.createChannel('alpha');

    expect((await bus.listChannels()).map(c => c.name)).toEqual(['alpha', 'zeta']);
  });
});
