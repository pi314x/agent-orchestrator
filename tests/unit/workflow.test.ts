import { describe, expect, it } from 'vitest';
import { validateWorkflow, type WorkflowSpec } from '../../src/core/workflow-engine.js';
import { closeServices, deferred, testServices } from '../helpers.js';

const step = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  instruction: `do ${id}`,
  template: 'coder',
  ...overrides
});

describe('validateWorkflow', () => {
  it('accepts a linear DAG', async () => {
    const spec: WorkflowSpec = { name: 'w', steps: [step('a'), step('b', { dependsOn: ['a'] })] };
    expect(() => validateWorkflow(spec)).not.toThrow();
  });

  it('rejects an empty workflow', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [] })).toThrow(/at least one step/);
  });

  it('rejects duplicate step ids', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a'), step('a')] })).toThrow(/Duplicate step id/);
  });

  it('rejects a dependency on an unknown step', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { dependsOn: ['ghost'] })] })).toThrow(
      /unknown step "ghost"/
    );
  });

  it('rejects a direct cycle', async () => {
    const spec: WorkflowSpec = {
      name: 'w',
      steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]
    };
    expect(() => validateWorkflow(spec)).toThrow(/dependency cycle/);
  });

  it('rejects a longer cycle', async () => {
    const spec: WorkflowSpec = {
      name: 'w',
      steps: [
        step('a', { dependsOn: ['c'] }),
        step('b', { dependsOn: ['a'] }),
        step('c', { dependsOn: ['b'] })
      ]
    };
    expect(() => validateWorkflow(spec)).toThrow(/dependency cycle/);
  });

  it('rejects a step with no target', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [{ id: 'a', instruction: 'x' }] })).toThrow(
      /has no target/
    );
  });

  it('rejects a blank instruction, a self-dependency and out-of-range retries', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { instruction: '  ' })] })).toThrow(
      /empty instruction/
    );
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { dependsOn: ['a'] })] })).toThrow(
      /cannot depend on itself/
    );
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { retries: 6 })] })).toThrow(
      /retries must be an integer 0-5/
    );
  });

  it('rejects an instruction referencing an unknown root variable', async () => {
    expect(() =>
      validateWorkflow({ name: 'w', steps: [step('a', { instruction: 'use {{bogus.value}}' })] })
    ).toThrow(/unknown variable/);
  });

  // Regression: templateVars builds `steps` from every step in the run, not
  // just a step's own declared dependencies, so {{steps.X...}} resolves
  // whether or not this step actually depends on X - but only a declared
  // dependency is guaranteed to have already run when this step starts. An
  // independent step (no edge between them) referencing another's output
  // rendered as an empty string whenever the scheduler happened to start it
  // first, silently, with no error at definition time or at render time.
  it('rejects a step that reads another step\'s output without depending on it', async () => {
    expect(() =>
      validateWorkflow({
        name: 'w',
        steps: [step('a'), step('b', { instruction: 'use {{steps.a.output}}' })]
      })
    ).toThrow(/does not depend on "a"/);
  });

  it('accepts the same reference once the dependency is declared', async () => {
    expect(() =>
      validateWorkflow({
        name: 'w',
        steps: [step('a'), step('b', { instruction: 'use {{steps.a.output}}', dependsOn: ['a'] })]
      })
    ).not.toThrow();
  });

  it('accepts a shared file when the steps are ordered', async () => {
    expect(() =>
      validateWorkflow({
        name: 'w',
        steps: [
          step('a', { files: ['src/auth.ts'] }),
          step('b', { files: ['src/auth.ts'], dependsOn: ['a'] }),
          step('c', { files: ['src/auth.ts'], dependsOn: ['b'] })
        ]
      })
    ).not.toThrow();
  });

  it('rejects unordered steps claiming the same file', async () => {
    expect(() =>
      validateWorkflow({
        name: 'w',
        steps: [step('a', { files: ['src/auth.ts'] }), step('b', { files: [' src/auth.ts '] })]
      })
    ).toThrow(/both claim file "src\/auth\.ts"/);
  });

  it('rejects an empty file entry', async () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { files: ['  '] })] })).toThrow(
      /lists an empty file/
    );
  });
});

describe('WorkflowEngine', () => {
  it('validateDraft accepts a good spec and rejects broken ones without throwing', async () => {
    const services = await testServices();

    expect(
      await services.workflows.validateDraft({
        name: 'w',
        steps: [{ id: 'a', instruction: 'do a', template: 'coder' }]
      })
    ).toEqual({ ok: true });

    expect(
      await services.workflows.validateDraft({
        name: 'w',
        steps: [{ id: 'a', instruction: 'do a', template: 'ghost' }]
      })
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    expect(
      await services.workflows.validateDraft({
        name: 'w',
        steps: [
          { id: 'a', instruction: 'do a', template: 'coder', files: ['f.ts'] },
          { id: 'b', instruction: 'do b', template: 'coder', files: ['f.ts'] }
        ]
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    expect(await services.workflows.validateDraft('just prose')).toMatchObject({ ok: false });
    expect(await services.workflows.validateDraft(null)).toMatchObject({ ok: false });

    await closeServices(services);
  });

  it('define rejects an unknown template before storing anything', async () => {
    const services = await testServices();

    await expect(
      services.workflows.define({ name: 'bad', steps: [step('a', { template: 'nonexistent' })] }, '')
    ).rejects.toThrow(/unknown template "nonexistent"/);
    expect(await services.workflows.listWorkflows(10, '')).toHaveLength(0);
    await closeServices(services);
  });

  it('define and start refuse a disabled template instead of failing mid-run', async () => {
    const services = await testServices();
    services.agents.setDisabledTemplates(['coder']);

    await expect(
      services.workflows.define({ name: 'bad', steps: [step('a')] }, '')
    ).rejects.toThrow(/disabled template "coder"/);
    await expect(
      services.workflows.start({ spec: { name: 'bad', steps: [step('a')] } })
    ).rejects.toThrow(/disabled template "coder"/);
    await closeServices(services);
  });

  it('posts a completion callback when a run settles', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const services = await testServices({
      notifyFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        posted.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body as string) });
        return new Response('ok');
      }) as typeof fetch
    });
    await services.webhooks.register('', 'https://hooks.example.com/runs', ['workflow.succeeded']);

    const run = await services.workflows.start({
      spec: { name: 'notified', steps: [step('a')] }
    });
    await services.scheduler.drain();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ type: 'workflow.succeeded', runId: run.runId });
    await closeServices(services);
  });

  it('runs a linear workflow to completion in dependency order', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: {
        name: 'linear',
        steps: [step('first'), step('second', { dependsOn: ['first'] })]
      }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.map(s => s.state)).toEqual(['succeeded', 'succeeded']);

    await closeServices(services);
  });

  it('passes an earlier step output into a later instruction', async () => {
    const services = await testServices({ mockScript: job => ({ text: `handled:${job.instruction}` }) });

    const run = await services.workflows.start({
      spec: {
        name: 'chained',
        steps: [
          step('plan', { instruction: 'make a plan' }),
          step('build', { instruction: 'build from {{steps.plan.output}}', dependsOn: ['plan'] })
        ]
      }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    const build = finished.steps.find(s => s.stepId === 'build');
    expect(build?.output).toContain('handled:make a plan');

    await closeServices(services);
  });

  it('substitutes run inputs into instructions', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: { name: 'parameterized', steps: [step('a', { instruction: 'review {{inputs.target}}' })] },
      inputs: { target: 'payments.ts' }
    });

    await services.scheduler.drain();

    expect((await services.workflows.getRun(run.runId)).steps[0]?.output).toContain('payments.ts');
    await closeServices(services);
  });

  it('skips a step whose when condition is falsy', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: {
        name: 'conditional',
        steps: [step('always'), step('maybe', { dependsOn: ['always'], when: '{{inputs.enabled}}' })]
      },
      inputs: { enabled: false }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.steps.find(s => s.stepId === 'maybe')?.state).toBe('skipped');
    expect(finished.state).toBe('succeeded');

    await closeServices(services);
  });

  it('skips dependents when a step fails, and fails the run', async () => {
    const services = await testServices({
      mockScript: job =>
        job.instruction.includes('broken')
          ? { fail: { code: 'RUNNER_FAILED', message: 'nope' } }
          : { text: 'fine' }
    });

    const run = await services.workflows.start({
      spec: {
        name: 'failing',
        steps: [step('broken', { instruction: 'do broken' }), step('after', { dependsOn: ['broken'] })]
      }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.steps.find(s => s.stepId === 'broken')?.state).toBe('failed');
    expect(finished.steps.find(s => s.stepId === 'after')?.state).toBe('skipped');
    expect(finished.state).toBe('failed');

    await closeServices(services);
  });

  it('retries a failing step up to its retry budget', async () => {
    let attempts = 0;
    const services = await testServices({
      mockScript: () => {
        attempts += 1;
        return attempts === 1 ? { fail: { code: 'RUNNER_FAILED', message: 'flaky' } } : { text: 'recovered' };
      }
    });

    const run = await services.workflows.start({
      spec: { name: 'retrying', steps: [step('flaky', { retries: 1 })] }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps[0]?.attempt).toBe(2);

    await closeServices(services);
  });

  it('runs independent steps in parallel and joins them', async () => {
    const services = await testServices({ config: { maxConcurrency: 4 } });

    const run = await services.workflows.start({
      spec: {
        name: 'diamond',
        steps: [
          step('start'),
          step('left', { dependsOn: ['start'] }),
          step('right', { dependsOn: ['start'] }),
          step('join', { dependsOn: ['left', 'right'] })
        ]
      }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.every(s => s.state === 'succeeded')).toBe(true);

    await closeServices(services);
  });

  // The M3 exit criterion from PLAN.md §14.
  it('pauses at an approval gate, then resumes and completes', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: {
        name: 'gated',
        steps: [
          step('draft'),
          step('review', { dependsOn: ['draft'] }),
          step('deploy', { dependsOn: ['review'], approval: true }),
          step('announce', { dependsOn: ['deploy'] })
        ]
      }
    });

    await services.scheduler.drain();

    const paused = await services.workflows.getRun(run.runId);
    expect(paused.state).toBe('paused');
    expect(paused.steps.find(s => s.stepId === 'deploy')?.state).toBe('awaiting_approval');
    expect(paused.steps.find(s => s.stepId === 'announce')?.state).toBe('pending');

    const pending = await services.approvals.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.stepId).toBe('deploy');

    await services.approvals.resolve(pending[0]!.approvalId, 'approve');
    await services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.every(s => s.state === 'succeeded')).toBe(true);

    await closeServices(services);
  });

  it('fails the gated step when the approval is rejected', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: { name: 'rejected', steps: [step('risky', { approval: true })] }
    });

    await services.scheduler.drain();

    const pending = await services.approvals.list({ status: 'pending' });
    await services.approvals.resolve(pending[0]!.approvalId, 'reject', { comment: 'too risky' });
    await services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.steps[0]?.state).toBe('failed');
    expect(finished.steps[0]?.error?.code).toBe('POLICY_DENIED');
    expect(finished.state).toBe('failed');

    await closeServices(services);
  });

  // Regression: the approval-resolution loop in advanceOnce used to do
  // `(await approvals.list({ limit: 100 })).find(a => a.runId === runId && ...)`,
  // which scans the 100 OLDEST approvals system-wide (ORDER BY created_at
  // ASC). Once a deployment has ever accumulated more than 100 approval rows
  // in total, a just-resolved decision for the current run falls outside
  // that window and the step hangs in awaiting_approval forever, even though
  // a human already decided. Seed 100 unrelated older approvals first so the
  // real one would be the 101st, exactly the case that broke.
  it('resolves an approval gate even with 100+ older approvals already in the system', async () => {
    const services = await testServices();
    for (let i = 0; i < 100; i += 1) {
      await services.approvals.create({ scope: 'job', summary: `unrelated ${i}` });
    }

    const run = await services.workflows.start({
      spec: { name: 'busy-system', steps: [step('risky', { approval: true })] }
    });
    await services.scheduler.drain();

    const pending = await services.approvals.findPendingForStep(run.runId, 'risky');
    expect(pending).toBeDefined();
    await services.approvals.resolve(pending!.approvalId, 'approve');
    await services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps[0]?.state).toBe('succeeded');

    await closeServices(services);
  });

  // Regression: retry_step reset the step itself but never touched its old
  // approval decision, so findForStep kept returning the same stale
  // 'rejected' record forever — the step re-failed instantly on retry_step,
  // never actually asking for approval again.
  it('retry_step re-gates a previously rejected approval step for a fresh decision', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: { name: 'retry-rejected', steps: [step('risky', { approval: true })] }
    });
    await services.scheduler.drain();

    const firstPending = await services.approvals.list({ status: 'pending' });
    await services.approvals.resolve(firstPending[0]!.approvalId, 'reject', { comment: 'not yet' });
    await services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    expect((await services.workflows.getRun(run.runId)).steps[0]?.state).toBe('failed');

    await services.workflows.control(run.runId, 'retry_step', 'risky');
    await services.scheduler.drain();

    const afterRetry = await services.workflows.getRun(run.runId);
    expect(afterRetry.steps[0]?.state).toBe('awaiting_approval');

    const secondPending = await services.approvals.findPendingForStep(run.runId, 'risky');
    expect(secondPending).toBeDefined();
    await services.approvals.resolve(secondPending!.approvalId, 'approve');
    await services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.steps[0]?.state).toBe('succeeded');
    expect(finished.state).toBe('succeeded');

    await closeServices(services);
  });

  it('returns the same run for a repeated idempotency key', async () => {
    const services = await testServices();
    const spec: WorkflowSpec = { name: 'once', steps: [step('a')] };

    const first = await services.workflows.start({ spec, idempotencyKey: 'k' });
    const second = await services.workflows.start({ spec, idempotencyKey: 'k' });

    expect(second.runId).toBe(first.runId);
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('cancels a run and its in-flight steps', async () => {
    const services = await testServices({ mockScript: () => ({ gate: new Promise<void>(() => {}) }) });

    const run = await services.workflows.start({ spec: { name: 'cancelme', steps: [step('a')] } });
    const cancelled = await services.workflows.control(run.runId, 'cancel');

    expect(cancelled.state).toBe('cancelled');
    await closeServices(services);
  });

  // Regression: retry_step reset the step_runs row unconditionally — state,
  // job_id and all — with no check that the step was actually in a state
  // retrying makes sense for. Calling it on a step whose job was still
  // running left that job going in the background (never cancelled, still
  // holding a concurrency slot and spending budget) while the very next
  // advance() pass started a brand new job for the same step, since the row
  // now read 'pending' with its dependencies already satisfied — two jobs
  // racing for one step, the original's result silently discarded because
  // the step's job_id no longer pointed at it.
  it('retry_step on a still-running step cancels the original job instead of orphaning it', async () => {
    const services = await testServices({ mockScript: () => ({ gate: new Promise<void>(() => {}) }) });

    const run = await services.workflows.start({ spec: { name: 'retry-while-running', steps: [step('a')] } });
    const originalJobId = (await services.workflows.getRun(run.runId)).steps[0]?.jobId;
    expect(originalJobId).toBeDefined();
    expect((await services.jobs.getOrThrow(originalJobId as string)).state).toBe('running');

    await services.workflows.control(run.runId, 'retry_step', 'a');

    // cancel() only signals the abort; the job settles asynchronously as the
    // runner observes it, same as any other cancellation. Wait on this one
    // job specifically rather than drain(), which would hang forever on the
    // brand new retry job's own never-resolving gate.
    await services.scheduler.wait([originalJobId as string], 'all', 2000);
    expect((await services.jobs.getOrThrow(originalJobId as string)).state).toBe('cancelled');

    await closeServices(services);
  });

  it('keeps run history after the definition is deleted', async () => {
    const services = await testServices();

    const workflow = await services.workflows.define({ name: 'temp', steps: [step('a')] });
    const run = await services.workflows.start({ workflowId: workflow.workflowId });
    await services.scheduler.drain();

    expect(await services.workflows.deleteWorkflow(workflow.workflowId, { ownerId: '', isAdmin: false })).toBe(true);
    expect((await services.workflows.getRun(run.runId)).state).toBe('succeeded');

    await closeServices(services);
  });
});

describe('failure propagation', () => {
  const failing = (instruction: string) =>
    testServices({
      mockScript: job =>
        job.instruction === instruction ? { fail: { code: 'RUNNER_FAILED' as const, message: 'boom' } } : {}
    });

  // Regression: a failed dependency skipped the step below it, but that skip
  // looked identical to a `when: false` skip — so the step two hops down ran
  // anyway, on whatever its template rendered to.
  it('carries a failure down the whole chain, not just one hop', async () => {
    const services = await failing('do a');

    const run = await services.workflows.start({
      spec: {
        name: 'chain',
        steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })]
      }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    const states = Object.fromEntries(finished.steps.map(s => [s.stepId, s.state]));

    expect(states).toEqual({ a: 'failed', b: 'skipped', c: 'skipped' });
    expect(finished.state).toBe('failed');
    await closeServices(services);
  });

  it('names the dependency that caused each skip', async () => {
    const services = await failing('do a');

    const run = await services.workflows.start({
      spec: {
        name: 'chain',
        steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })]
      }
    });

    await services.scheduler.drain();

    const steps = (await services.workflows.getRun(run.runId)).steps;
    const b = steps.find(s => s.stepId === 'b');
    const c = steps.find(s => s.stepId === 'c');

    expect(b?.error).toMatchObject({ code: 'DEPENDENCY_FAILED' });
    expect(b?.error?.message).toContain('"a"');
    expect(c?.error?.message).toContain('"b"');
    await closeServices(services);
  });

  // The bug in its most concrete form: a step consuming a dead step's output
  // used to run with that template rendered to the empty string.
  it('never runs a step on the empty output of a failed one', async () => {
    const services = await failing('make a plan');

    const run = await services.workflows.start({
      spec: {
        name: 'consume',
        steps: [
          step('plan', { instruction: 'make a plan' }),
          step('build', { instruction: 'build from {{steps.plan.output}}', dependsOn: ['plan'] }),
          step('ship', { instruction: 'ship {{steps.build.output}}', dependsOn: ['build'] })
        ]
      }
    });

    await services.scheduler.drain();

    const steps = (await services.workflows.getRun(run.runId)).steps;
    expect(steps.find(s => s.stepId === 'ship')?.state).toBe('skipped');
    expect(steps.find(s => s.stepId === 'ship')?.output).toBeUndefined();
    await closeServices(services);
  });

  // The other half of the distinction: a `when: false` skip is a branch the
  // author chose, so what comes after it is still meant to run.
  it('still runs the steps after a condition-skipped one', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      spec: {
        name: 'branching',
        steps: [
          step('always'),
          step('maybe', { dependsOn: ['always'], when: '{{inputs.enabled}}' }),
          step('after', { dependsOn: ['maybe'] })
        ]
      },
      inputs: { enabled: false }
    });

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    const states = Object.fromEntries(finished.steps.map(s => [s.stepId, s.state]));

    expect(states).toEqual({ always: 'succeeded', maybe: 'skipped', after: 'succeeded' });
    expect(finished.state).toBe('succeeded');
    await closeServices(services);
  });
});

describe('workflow ownership', () => {
  const alice = 'user_alice';

  // Regression: workflow_runs.owner_id existed since migration 7 but was never
  // read or written, and every job a workflow step submitted carried no owner
  // at all — so in any OAuth-enabled deployment, the person who started the
  // workflow could not find its jobs through job_list, which filters by their
  // own ownerId. Workflows were not merely "unisolated" (visible to everyone)
  // but invisible to their own creator.
  it('stamps the run with its owner, and every job it spawns inherits it', async () => {
    const services = await testServices();

    const run = await services.workflows.start({
      ownerId: alice,
      spec: { name: 'w', steps: [step('a'), step('b', { dependsOn: ['a'] })] }
    });

    expect(run.ownerId).toBe(alice);

    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.ownerId).toBe(alice);

    const jobIds = finished.steps.map(s => s.jobId).filter((id): id is string => id !== undefined);
    expect(jobIds).toHaveLength(2);
    for (const jobId of jobIds) {
      expect((await services.jobs.getOrThrow(jobId)).ownerId).toBe(alice);
    }

    // The point of the fix: the starting user can now find these through the
    // same job_list path every other owned job goes through.
    const aliceJobs = await services.jobs.list({ ownerId: alice });
    expect(aliceJobs.jobs.map(j => j.id).sort()).toEqual([...jobIds].sort());

    await closeServices(services);
  });

  it('retrying a step keeps the job owned by the run starter', async () => {
    let failNext = true;
    const services = await testServices({
      mockScript: job => {
        if (job.instruction !== 'do a' || !failNext) return {};
        failNext = false;
        return { fail: { code: 'RUNNER_FAILED' as const, message: 'transient' } };
      }
    });

    const run = await services.workflows.start({ ownerId: alice, spec: { name: 'w', steps: [step('a')] } });
    await services.scheduler.drain();
    expect((await services.workflows.getRun(run.runId)).steps[0]?.state).toBe('failed');

    await services.workflows.control(run.runId, 'retry_step', 'a');
    await services.scheduler.drain();

    const retried = await services.workflows.getRun(run.runId);
    const jobId = retried.steps[0]?.jobId;
    expect(jobId).toBeDefined();
    expect((await services.jobs.getOrThrow(jobId as string)).ownerId).toBe(alice);

    await closeServices(services);
  });

  it('omitting ownerId falls back to the single-owner sentinel', async () => {
    const services = await testServices();

    const run = await services.workflows.start({ spec: { name: 'w', steps: [step('a')] } });
    await services.scheduler.drain();

    expect(run.ownerId).toBe('');
    const jobId = (await services.workflows.getRun(run.runId)).steps[0]?.jobId;
    expect((await services.jobs.getOrThrow(jobId as string)).ownerId).toBe('');

    await closeServices(services);
  });

  it('reconcile re-runs steps that succeeded empty and leaves the rest alone', async () => {
    const services = await testServices({
      mockScript: job => (job.instruction === 'stay quiet' ? { text: '   ' } : { text: `done:${job.instruction}` })
    });
    const principal = { ownerId: '', isAdmin: false };

    const run = await services.workflows.start({
      spec: {
        name: 'patchy',
        steps: [step('quiet', { instruction: 'stay quiet' }), step('loud', { instruction: 'speak up' })]
      }
    });
    await services.scheduler.drain();
    expect((await services.workflows.getRun(run.runId)).state).toBe('succeeded');

    const { reconciled } = await services.workflows.reconcile(run.runId, undefined, principal);
    expect(reconciled).toEqual(['quiet']);

    await services.scheduler.drain();
    const after = await services.workflows.getRun(run.runId);
    expect(after.steps.find(s => s.stepId === 'quiet')?.attempt).toBe(2);
    expect(after.steps.find(s => s.stepId === 'loud')?.attempt).toBe(1);

    await closeServices(services);
  });

  it('reconcile is a no-op when every success has output', async () => {
    const services = await testServices();
    const principal = { ownerId: '', isAdmin: false };

    const run = await services.workflows.start({ spec: { name: 'solid', steps: [step('a')] } });
    await services.scheduler.drain();

    const { run: same, reconciled } = await services.workflows.reconcile(run.runId, undefined, principal);
    expect(reconciled).toEqual([]);
    expect(same.state).toBe('succeeded');

    await closeServices(services);
  });

  it('reconcile rejects an unknown step and a foreign run', async () => {
    const services = await testServices();
    const principal = { ownerId: '', isAdmin: false };

    const run = await services.workflows.start({ spec: { name: 'w', steps: [step('a')] } });
    await services.scheduler.drain();

    await expect(services.workflows.reconcile(run.runId, 'ghost', principal)).rejects.toThrow(
      /not part of this run/
    );
    await expect(
      services.workflows.reconcile(run.runId, undefined, { ownerId: 'user_bob', isAdmin: false })
    ).rejects.toThrow(/No workflow run/);

    await closeServices(services);
  });

  it('exportRun renders the run into an artifact the owner can read back', async () => {
    const services = await testServices();
    const principal = { ownerId: '', isAdmin: false };

    const run = await services.workflows.start({ spec: { name: 'ship', steps: [step('a')] } });
    await services.scheduler.drain();

    const exported = await services.workflows.exportRun(run.runId, principal);
    expect(exported).toMatchObject({ runId: run.runId, steps: 1 });
    expect(exported.sizeBytes).toBeGreaterThan(0);

    const { content } = await services.artifacts.readVisible(exported.artifactId, principal);
    expect(content).toContain('# Workflow export: ship');
    expect(content).toContain('do a');
    expect(content).toContain('succeeded');

    await closeServices(services);
  });

  it('exportRun refuses a run belonging to someone else', async () => {
    const services = await testServices();

    const run = await services.workflows.start({ spec: { name: 'w', steps: [step('a')] } });
    await services.scheduler.drain();

    await expect(
      services.workflows.exportRun(run.runId, { ownerId: 'user_bob', isAdmin: false })
    ).rejects.toThrow(/No workflow run/);

    await closeServices(services);
  });
});

describe('wedged steps and boot resume', () => {
  // Regression: a step stuck 'running' whose job row is gone (pruned after
  // finishing, or deleted out from under a run that never observed the
  // settle) was skipped forever — no future event could ever settle it,
  // since the job it waits on no longer exists to change state.
  it('fails a running step whose job row is gone instead of hanging', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });

    const run = await services.workflows.start({ spec: { name: 'pruned', steps: [step('a')] } });
    let started = await services.workflows.getRun(run.runId);
    for (let i = 0; i < 50 && started.steps[0]?.jobId === undefined; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      started = await services.workflows.getRun(run.runId);
    }
    const jobId = started.steps[0]?.jobId;
    expect(jobId).toBeDefined();

    // Whatever removed it — retention pruning a finished job, or a crash
    // between the settle and its observation — the step cannot wait on it.
    await services.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    gate.resolve();

    const resumed = await services.workflows.control(run.runId, 'resume');
    expect(resumed.steps[0]?.state).toBe('failed');
    expect(resumed.steps[0]?.error?.code).toBe('INTERRUPTED');
    expect(resumed.state).toBe('failed');
    await closeServices(services);
  });

  // Same missing job, but the step still has an attempt left: it re-runs
  // fresh instead of failing, which is exactly the self-heal a retry is for.
  it('re-runs a missing-job step that still has retries', async () => {
    const gate = deferred();
    let calls = 0;
    const services = await testServices({
      mockScript: () => {
        calls += 1;
        return calls === 1 ? { gate: gate.promise } : { text: 'recovered' };
      }
    });

    const run = await services.workflows.start({
      spec: { name: 'pruned-retry', steps: [step('a', { retries: 1 })] }
    });
    let started = await services.workflows.getRun(run.runId);
    for (let i = 0; i < 50 && started.steps[0]?.jobId === undefined; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      started = await services.workflows.getRun(run.runId);
    }
    const firstJob = started.steps[0]?.jobId;
    expect(firstJob).toBeDefined();

    await services.db.prepare('DELETE FROM jobs WHERE id = ?').run(firstJob);
    gate.resolve();
    await services.scheduler.drain();

    const finished = await services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps[0]?.state).toBe('succeeded');
    expect(finished.steps[0]?.jobId).not.toBe(firstJob);
    await closeServices(services);
  });

  // Regression: a run whose last job settled without advance observing it (a
  // crash between the row write and the notification fan-out) healed on the
  // next unrelated job event at the earliest — on an idle deployment, never.
  // resumeAll() is the boot pass that settles those deterministically.
  it('resumeAll settles a step that finished without being observed', async () => {
    const services = await testServices();

    const run = await services.workflows.start({ spec: { name: 'wedged', steps: [step('a')] } });
    await services.scheduler.drain();
    expect((await services.workflows.getRun(run.runId)).state).toBe('succeeded');

    // What the crash leaves behind: the job row says succeeded, but nothing
    // ever moved the step — or the run — past running.
    await services.db.prepare("UPDATE step_runs SET state = 'running' WHERE run_id = ?").run(run.runId);
    await services.db
      .prepare("UPDATE workflow_runs SET state = 'running', finished_at = NULL WHERE id = ?")
      .run(run.runId);

    await services.workflows.resumeAll();

    const healed = await services.workflows.getRun(run.runId);
    expect(healed.state).toBe('succeeded');
    expect(healed.steps[0]?.state).toBe('succeeded');
    await closeServices(services);
  });
});
