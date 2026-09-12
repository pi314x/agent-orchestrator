import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/core/principal.js';
import { registerPrompts } from '../../src/prompts/index.js';
import { closeServices, testServices } from '../helpers.js';

type PromptCallback = (args: Record<string, string>) => { messages: { content: { text: string } }[] };

/** Captures every prompt `registerPrompts` registers, keyed by name. */
function capturePrompts(services: ReturnType<typeof testServices>, principal: Principal) {
  const handlers = new Map<string, PromptCallback>();
  const fakeServer = {
    registerPrompt: (name: string, _config: unknown, callback: PromptCallback) => {
      handlers.set(name, callback);
    }
  };

  registerPrompts(fakeServer as never, services, principal);
  return handlers;
}

const alice: Principal = { ownerId: 'user_alice', isAdmin: false };
const bob: Principal = { ownerId: 'user_bob', isAdmin: false };
const admin: Principal = { ownerId: 'user_admin', isAdmin: true };

describe('cross_vendor_review prompt', () => {
  // Regression: registerPrompts never received a principal at all, so this
  // prompt listed every remote agent in the whole deployment — the same
  // "resources need the same scoping as tools" gap already found once for
  // orch:// resources, recurring on prompts, the third registration surface.
  it("does not list another user's registered remote agent", async () => {
    const services = testServices();
    services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-only-remote',
      instructions: ''
    });

    const bobHandlers = capturePrompts(services, bob);
    const rendered = bobHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).not.toContain('alice-only-remote');
    expect(text).toContain('No remote agents are registered');
    await closeServices(services);
  });

  it("lists the caller's own registered remote agent", async () => {
    const services = testServices();
    services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-own-remote',
      instructions: ''
    });

    const aliceHandlers = capturePrompts(services, alice);
    const rendered = aliceHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).toContain('alice-own-remote');
    await closeServices(services);
  });

  it('lets an admin see every registered remote agent', async () => {
    const services = testServices();
    services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-remote-for-admin',
      instructions: ''
    });

    const adminHandlers = capturePrompts(services, admin);
    const rendered = adminHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).toContain('alice-remote-for-admin');
    await closeServices(services);
  });
});
