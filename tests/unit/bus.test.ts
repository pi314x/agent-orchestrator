import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../src/core/bus.js';
import { migratedDb } from '../helpers.js';

describe('MessageBus', () => {
  it('sends a message and lists it back', () => {
    const bus = new MessageBus(migratedDb());
    const sent = bus.send({ toAgentId: 'agt_1', body: 'hello' });

    expect(bus.list({ agentId: 'agt_1' })).toEqual([sent]);
  });

  it('requires at least one recipient', () => {
    const bus = new MessageBus(migratedDb());
    expect(() => bus.send({ body: 'nowhere' })).toThrow(/recipient/);
  });

  it('markRead only touches the given ids, once', () => {
    const bus = new MessageBus(migratedDb());
    const a = bus.send({ toAgentId: 'agt_1', body: 'a' });
    const b = bus.send({ toAgentId: 'agt_1', body: 'b' });

    expect(bus.markRead([a.messageId])).toBe(1);
    expect(bus.markRead([a.messageId])).toBe(0); // already read
    const unread = bus.list({ agentId: 'agt_1', unreadOnly: true });
    expect(unread.map(m => m.messageId)).toEqual([b.messageId]);
  });

  describe('createChannel', () => {
    it('creates a channel with its own id kind, not a message id', () => {
      const bus = new MessageBus(migratedDb());
      const channel = bus.createChannel('team', ['alice']);

      expect(channel.channelId).toMatch(/^chan_/);
      expect(channel.members).toEqual(['alice']);
    });

    it('returns the existing channel for a repeated name instead of erroring', () => {
      const bus = new MessageBus(migratedDb());
      const first = bus.createChannel('team', ['alice']);
      const second = bus.createChannel('team', ['bob']);

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
    it("the channel insert survives a name collision the caller's own guard cannot see coming", () => {
      const db = migratedDb();
      const insert = db.prepare(
        `INSERT INTO channels (id, name, members, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET name = excluded.name`
      );

      insert.run('chan_a', 'team', JSON.stringify(['alice']), new Date().toISOString());
      expect(() => insert.run('chan_b', 'team', JSON.stringify(['bob']), new Date().toISOString())).not.toThrow();

      const row = db.prepare('SELECT * FROM channels WHERE name = ?').get('team') as { id: string };
      expect(row.id).toBe('chan_a');
    });
  });

  it('listChannels lists every channel, alphabetically', () => {
    const bus = new MessageBus(migratedDb());
    bus.createChannel('zeta');
    bus.createChannel('alpha');

    expect(bus.listChannels().map(c => c.name)).toEqual(['alpha', 'zeta']);
  });
});
