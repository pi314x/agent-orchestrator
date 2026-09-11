import { describe, expect, it } from 'vitest';
import { validateWorkflow, type WorkflowSpec } from '../../src/core/workflow-engine.js';
import { closeServices, testServices } from '../helpers.js';

const step = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  instruction: `do ${id}`,
  template: 'coder',
  ...overrides
});

describe('validateWorkflow', () => {
  it('accepts a linear DAG', () => {
    const spec: WorkflowSpec = { name: 'w', steps: [step('a'), step('b', { dependsOn: ['a'] })] };
    expect(() => validateWorkflow(spec)).not.toThrow();
  });

  it('rejects an empty workflow', () => {
    expect(() => validateWorkflow({ name: 'w', steps: [] })).toThrow(/at least one step/);
  });

  it('rejects duplicate step ids', () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a'), step('a')] })).toThrow(/Duplicate step id/);
  });

  it('rejects a dependency on an unknown step', () => {
    expect(() => validateWorkflow({ name: 'w', steps: [step('a', { dependsOn: ['ghost'] })] })).toThrow(
      /unknown step "ghost"/
    );
  });

  it('rejects a direct cycle', () => {
    const spec: WorkflowSpec = {
      name: 'w',
      steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]
    };
    expect(() => validateWorkflow(spec)).toThrow(/dependency cycle/);
  });

  it('rejects a longer cycle', () => {
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

  it('rejects a step with no target', () => {
    expect(() => validateWorkflow({ name: 'w', steps: [{ id: 'a', instruction: 'x' }] })).toThrow(
      /has no target/
    );
  });

  it('rejects an instruction referencing an unknown root variable', () => {
    expect(() =>
      validateWorkflow({ name: 'w', steps: [step('a', { instruction: 'use {{bogus.value}}' })] })
    ).toThrow(/unknown variable/);
  });
});

describe('WorkflowEngine', () => {
  it('runs a linear workflow to completion in dependency order', async () => {
    const services = testServices();

    const run = services.workflows.start({
      spec: {
        name: 'linear',
        steps: [step('first'), step('second', { dependsOn: ['first'] })]
      }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.map(s => s.state)).toEqual(['succeeded', 'succeeded']);

    await closeServices(services);
  });

  it('passes an earlier step output into a later instruction', async () => {
    const services = testServices({ mockScript: job => ({ text: `handled:${job.instruction}` }) });

    const run = services.workflows.start({
      spec: {
        name: 'chained',
        steps: [
          step('plan', { instruction: 'make a plan' }),
          step('build', { instruction: 'build from {{steps.plan.output}}', dependsOn: ['plan'] })
        ]
      }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    const build = finished.steps.find(s => s.stepId === 'build');
    expect(build?.output).toContain('handled:make a plan');

    await closeServices(services);
  });

  it('substitutes run inputs into instructions', async () => {
    const services = testServices();

    const run = services.workflows.start({
      spec: { name: 'parameterized', steps: [step('a', { instruction: 'review {{inputs.target}}' })] },
      inputs: { target: 'payments.ts' }
    });

    await services.scheduler.drain();

    expect(services.workflows.getRun(run.runId).steps[0]?.output).toContain('payments.ts');
    await closeServices(services);
  });

  it('skips a step whose when condition is falsy', async () => {
    const services = testServices();

    const run = services.workflows.start({
      spec: {
        name: 'conditional',
        steps: [step('always'), step('maybe', { dependsOn: ['always'], when: '{{inputs.enabled}}' })]
      },
      inputs: { enabled: false }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.steps.find(s => s.stepId === 'maybe')?.state).toBe('skipped');
    expect(finished.state).toBe('succeeded');

    await closeServices(services);
  });

  it('skips dependents when a step fails, and fails the run', async () => {
    const services = testServices({
      mockScript: job =>
        job.instruction.includes('broken')
          ? { fail: { code: 'RUNNER_FAILED', message: 'nope' } }
          : { text: 'fine' }
    });

    const run = services.workflows.start({
      spec: {
        name: 'failing',
        steps: [step('broken', { instruction: 'do broken' }), step('after', { dependsOn: ['broken'] })]
      }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.steps.find(s => s.stepId === 'broken')?.state).toBe('failed');
    expect(finished.steps.find(s => s.stepId === 'after')?.state).toBe('skipped');
    expect(finished.state).toBe('failed');

    await closeServices(services);
  });

  it('retries a failing step up to its retry budget', async () => {
    let attempts = 0;
    const services = testServices({
      mockScript: () => {
        attempts += 1;
        return attempts === 1 ? { fail: { code: 'RUNNER_FAILED', message: 'flaky' } } : { text: 'recovered' };
      }
    });

    const run = services.workflows.start({
      spec: { name: 'retrying', steps: [step('flaky', { retries: 1 })] }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps[0]?.attempt).toBe(2);

    await closeServices(services);
  });

  it('runs independent steps in parallel and joins them', async () => {
    const services = testServices({ config: { maxConcurrency: 4 } });

    const run = services.workflows.start({
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

    const finished = services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.every(s => s.state === 'succeeded')).toBe(true);

    await closeServices(services);
  });

  // The M3 exit criterion from PLAN.md §14.
  it('pauses at an approval gate, then resumes and completes', async () => {
    const services = testServices();

    const run = services.workflows.start({
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

    const paused = services.workflows.getRun(run.runId);
    expect(paused.state).toBe('paused');
    expect(paused.steps.find(s => s.stepId === 'deploy')?.state).toBe('awaiting_approval');
    expect(paused.steps.find(s => s.stepId === 'announce')?.state).toBe('pending');

    const pending = services.approvals.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.stepId).toBe('deploy');

    services.approvals.resolve(pending[0]!.approvalId, 'approve');
    services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.state).toBe('succeeded');
    expect(finished.steps.every(s => s.state === 'succeeded')).toBe(true);

    await closeServices(services);
  });

  it('fails the gated step when the approval is rejected', async () => {
    const services = testServices();

    const run = services.workflows.start({
      spec: { name: 'rejected', steps: [step('risky', { approval: true })] }
    });

    await services.scheduler.drain();

    const pending = services.approvals.list({ status: 'pending' });
    services.approvals.resolve(pending[0]!.approvalId, 'reject', { comment: 'too risky' });
    services.workflows.control(run.runId, 'resume');
    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    expect(finished.steps[0]?.state).toBe('failed');
    expect(finished.steps[0]?.error?.code).toBe('POLICY_DENIED');
    expect(finished.state).toBe('failed');

    await closeServices(services);
  });

  it('returns the same run for a repeated idempotency key', async () => {
    const services = testServices();
    const spec: WorkflowSpec = { name: 'once', steps: [step('a')] };

    const first = services.workflows.start({ spec, idempotencyKey: 'k' });
    const second = services.workflows.start({ spec, idempotencyKey: 'k' });

    expect(second.runId).toBe(first.runId);
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('cancels a run and its in-flight steps', async () => {
    const services = testServices({ mockScript: () => ({ gate: new Promise<void>(() => {}) }) });

    const run = services.workflows.start({ spec: { name: 'cancelme', steps: [step('a')] } });
    const cancelled = services.workflows.control(run.runId, 'cancel');

    expect(cancelled.state).toBe('cancelled');
    await closeServices(services);
  });

  it('keeps run history after the definition is deleted', async () => {
    const services = testServices();

    const workflow = services.workflows.define({ name: 'temp', steps: [step('a')] });
    const run = services.workflows.start({ workflowId: workflow.workflowId });
    await services.scheduler.drain();

    expect(services.workflows.deleteWorkflow(workflow.workflowId)).toBe(true);
    expect(services.workflows.getRun(run.runId).state).toBe('succeeded');

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
    const services = failing('do a');

    const run = services.workflows.start({
      spec: {
        name: 'chain',
        steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })]
      }
    });

    await services.scheduler.drain();

    const finished = services.workflows.getRun(run.runId);
    const states = Object.fromEntries(finished.steps.map(s => [s.stepId, s.state]));

    expect(states).toEqual({ a: 'failed', b: 'skipped', c: 'skipped' });
    expect(finished.state).toBe('failed');
    await closeServices(services);
  });

  it('names the dependency that caused each skip', async () => {
    const services = failing('do a');

    const run = services.workflows.start({
      spec: {
        name: 'chain',
        steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })]
      }
    });

    await services.scheduler.drain();

    const steps = services.workflows.getRun(run.runId).steps;
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
    const services = failing('make a plan');

    const run = services.workflows.start({
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

    const steps = services.workflows.getRun(run.runId).steps;
    expect(steps.find(s => s.stepId === 'ship')?.state).toBe('skipped');
    expect(steps.find(s => s.stepId === 'ship')?.output).toBeUndefined();
    await closeServices(services);
  });

  // The other half of the distinction: a `when: false` skip is a branch the
  // author chose, so what comes after it is still meant to run.
  it('still runs the steps after a condition-skipped one', async () => {
    const services = testServices();

    const run = services.workflows.start({
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

    const finished = services.workflows.getRun(run.runId);
    const states = Object.fromEntries(finished.steps.map(s => [s.stepId, s.state]));

    expect(states).toEqual({ always: 'succeeded', maybe: 'skipped', after: 'succeeded' });
    expect(finished.state).toBe('succeeded');
    await closeServices(services);
  });
});
