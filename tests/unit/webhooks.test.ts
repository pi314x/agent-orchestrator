import { describe, expect, it } from 'vitest';
import { WebhookStore, notifyOwner } from '../../src/core/webhooks.js';
import { migratedDb, silentLogger } from '../helpers.js';

const posted: { url: string; body: unknown }[] = [];
const stubFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  posted.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body as string) });
  return new Response('ok');
};

describe('WebhookStore', () => {
  it('registers, lists and removes callbacks', async () => {
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);

    const hook = await webhooks.register('user_alice', 'https://hooks.example.com/done', ['job.succeeded']);
    expect(hook).toMatchObject({ ownerId: 'user_alice', events: ['job.succeeded'] });
    expect((await webhooks.list())).toHaveLength(1);
    expect(await webhooks.remove(hook.webhookId)).toBe(true);
    expect(await webhooks.remove(hook.webhookId)).toBe(false);
    await db.close();
  });

  it('refuses bad urls, private targets and unknown events at register time', async () => {
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);

    await expect(webhooks.register('u', 'not-a-url', ['job.succeeded'])).rejects.toThrow();
    await expect(webhooks.register('u', 'http://169.254.169.254/x', ['job.succeeded'])).rejects.toThrow();
    await expect(webhooks.register('u', 'https://hooks.example.com/x', ['job.exploded'])).rejects.toThrow(
      /Cannot subscribe/
    );
    await expect(webhooks.register('u', 'https://hooks.example.com/x', [])).rejects.toThrow(/at least one/);
    await expect(webhooks.register('u', 'https://other.example.com/x', ['job.succeeded'], ['hooks.example.com'])).rejects.toThrow(
      /allow-list/
    );
    await db.close();
  });

  it('matches only the owner’s hooks for the settled type', async () => {
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);

    await webhooks.register('user_alice', 'https://hooks.example.com/a', ['job.succeeded', 'job.failed']);
    await webhooks.register('user_bob', 'https://hooks.example.com/b', ['job.succeeded']);

    expect((await webhooks.matching('user_alice', 'job.succeeded')).map(h => h.ownerId)).toEqual(['user_alice']);
    expect(await webhooks.matching('user_alice', 'job.failed')).toHaveLength(1);
    expect(await webhooks.matching('user_alice', 'workflow.succeeded')).toHaveLength(0);
    await db.close();
  });
});

describe('notifyOwner', () => {
  it('posts the settle event and tolerates a failing callback', async () => {
    posted.length = 0;
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);
    await webhooks.register('user_alice', 'https://hooks.example.com/done', ['job.succeeded']);

    await notifyOwner({ webhooks, fetchImpl: stubFetch, logger: silentLogger() }, 'user_alice', 'job.succeeded', {
      jobId: 'job_1'
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      url: 'https://hooks.example.com/done',
      body: { type: 'job.succeeded', jobId: 'job_1' }
    });
    await db.close();
  });

  it('delivers to every matching hook', async () => {
    posted.length = 0;
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);
    await webhooks.register('user_alice', 'https://hooks.example.com/one', ['job.succeeded']);
    await webhooks.register('user_alice', 'https://hooks.example.com/two', ['job.succeeded']);

    await notifyOwner({ webhooks, fetchImpl: stubFetch, logger: silentLogger() }, 'user_alice', 'job.succeeded', {
      jobId: 'job_1'
    });

    expect(posted.map(p => p.url).sort()).toEqual([
      'https://hooks.example.com/one',
      'https://hooks.example.com/two'
    ]);
    await db.close();
  });

  it('never lets a dead callback fail the settlement', async () => {
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);
    await webhooks.register('user_alice', 'https://hooks.example.com/dead', ['job.failed']);

    const failing = async (): Promise<Response> => {
      throw new Error('connection refused');
    };
    await expect(
      notifyOwner({ webhooks, fetchImpl: failing, logger: silentLogger() }, 'user_alice', 'job.failed', {
        jobId: 'job_1'
      })
    ).resolves.toBeUndefined();
    await db.close();
  });

  it('re-validates the url at send time against a tightened allow-list', async () => {
    posted.length = 0;
    const db = await migratedDb();
    const webhooks = new WebhookStore(db);
    await webhooks.register('user_alice', 'https://hooks.example.com/done', ['job.succeeded']);

    await notifyOwner(
      { webhooks, fetchImpl: stubFetch, allowedHosts: ['other.example.com'], logger: silentLogger() },
      'user_alice',
      'job.succeeded',
      { jobId: 'job_1' }
    );

    expect(posted).toHaveLength(0);
    await db.close();
  });
});
