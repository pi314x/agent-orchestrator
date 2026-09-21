import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/core/principal.js';
import { registerPrompts } from '../../src/prompts/index.js';
import { closeServices, testServices } from '../helpers.js';

type PromptCallback = (args: Record<string, string>) => { messages: { content: { text: string } }[] };

/** Captures every prompt `registerPrompts` registers, keyed by name. */
function capturePrompts(services: Awaited<ReturnType<typeof testServices>>, principal: Principal) {
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
    const services = await testServices();
    await services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-only-remote',
      instructions: ''
    });

    const bobHandlers = capturePrompts(services, bob);
    const rendered = await bobHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).not.toContain('alice-only-remote');
    expect(text).toContain('No remote agents are registered');
    await closeServices(services);
  });

  it("lists the caller's own registered remote agent", async () => {
    const services = await testServices();
    await services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-own-remote',
      instructions: ''
    });

    const aliceHandlers = capturePrompts(services, alice);
    const rendered = await aliceHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).toContain('alice-own-remote');
    await closeServices(services);
  });

  it('lets an admin see every registered remote agent', async () => {
    const services = await testServices();
    await services.agents.create({
      ownerId: alice.ownerId,
      kind: 'remote',
      name: 'alice-remote-for-admin',
      instructions: ''
    });

    const adminHandlers = capturePrompts(services, admin);
    const rendered = await adminHandlers.get('cross_vendor_review')?.({ brief: 'x' });
    const text = rendered?.messages[0]?.content.text ?? '';

    expect(text).toContain('alice-remote-for-admin');
    await closeServices(services);
  });
});

describe('dashboard prompt', () => {
  it('registers a dashboard that names live tools and never invents rows', async () => {
    const services = await testServices();
    const handlers = capturePrompts(services, alice);

    expect(handlers.has('dashboard')).toBe(true);
    const rendered = await handlers.get('dashboard')?.({ section: 'jobs' });
    const text = rendered?.messages[0]?.content.text ?? '';
    expect(text).toContain('job_list');
    expect(text).toContain('Never invent rows');
    await closeServices(services);
  });
});

describe('audit prompts', () => {
  it('registers the five specialist audit prompts and routes to the right template', async () => {
    const services = await testServices();
    const handlers = capturePrompts(services, alice);

    const expectations: [string, Record<string, string>, string][] = [
      ['security_audit', { target: 'auth/' }, 'security-engineer'],
      ['perf_check', { target: 'query' }, 'performance-engineer'],
      ['debug_workflow', { symptom: '500 on login' }, 'debugger'],
      ['a11y_audit', { target: 'form' }, 'accessibility-specialist'],
      ['compliance_check', { target: 'retention' }, 'compliance-reviewer']
    ];

    for (const [name, args, template] of expectations) {
      const rendered = await handlers.get(name)?.(args);
      const text = rendered?.messages[0]?.content.text ?? '';
      expect(text).toContain(template);
    }
    await closeServices(services);
  });

  it('routes simple work to delegate and larger work to a workflow', async () => {
    const services = await testServices();
    const handlers = capturePrompts(services, alice);

    const rendered = await handlers.get('task_classify')?.({ task: 'fix typo' });
    const text = rendered?.messages[0]?.content.text ?? '';
    expect(text).toContain('delegate');
    expect(text).toContain('workflow_start');
    await closeServices(services);
  });
});
