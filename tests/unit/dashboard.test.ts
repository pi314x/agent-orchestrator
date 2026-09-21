import { describe, expect, it } from 'vitest';
import { SINGLE_USER_PRINCIPAL } from '../../src/core/principal.js';
import { collectDashboardData, DASHBOARD_HTTP_PRINCIPAL, shortId } from '../../src/dashboard/data.js';
import { escapeHtml, renderDashboard } from '../../src/dashboard/html.js';
import type { DashboardData } from '../../src/dashboard/data.js';
import { closeServices, testServices } from '../helpers.js';

const alice = { ownerId: 'user_alice', isAdmin: false };

function emptyData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: new Date().toISOString(),
    status: {
      status: 'ok',
      version: '0.0.1',
      uptimeSec: 3,
      toolProfile: 'standard',
      transport: 'http',
      protocolEra: 'http',
      database: { schemaVersion: 1, latestSchemaVersion: 1, migrationsPending: false },
      jobs: { queued: 0, running: 0, blocked: 0 },
      limits: { maxConcurrency: 4, maxDepth: 2 },
      a2a: { enabled: false },
      caller: { ownerId: '', isAdmin: false },
      pqc: { algorithms: ['ML-DSA-65', 'ML-KEM-768', 'X25519+ML-KEM-768'], atRest: false, cardSigned: false }
    },
    agents: [],
    templateNames: ['coder'],
    jobs: [],
    runs: [],
    definitions: [],
    approvals: [],
    schedules: [],
    namespaces: [],
    artifacts: [],
    budgets: [],
    recentTotals: { jobs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events: [],
    toolservers: [],
    a2aEnabled: false,
    auth: { required: false },
    ...overrides
  };
}

describe('shortId', () => {
  it('shortens long ids the way the mockup does', async () => {
    expect(shortId('job_01JABCDEF')).toBe('job_01J…');
    expect(shortId('short')).toBe('short');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup smuggled through untrusted model output', async () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('"quoted" & \'apos\'')).toBe('&quot;quoted&quot; &amp; &#39;apos&#39;');
  });
});

describe('renderDashboard', () => {
  it('renders all nine mockup tabs even when empty', async () => {
    const html = renderDashboard(emptyData());

    for (const tab of ['Agents', 'Jobs', 'Delegations', 'Workflows', 'Approvals', 'Schedules', 'Memory &amp; Artifacts', 'Tools', 'Observability']) {
      expect(html).toContain(tab);
    }
    expect(html).toContain('No agents visible.');
    expect(html).toContain('No pending approvals.');
    expect(html).toContain('No delegations yet');
    expect(html).toContain('None registered, or not an admin view.');
  });

  it('drops the functionless templates list and ships form editors instead of JSON prompts', async () => {
    const html = renderDashboard(emptyData());

    expect(html).not.toContain('Templates</b>');
    expect(html).toContain('id="agentDlg"');
    expect(html).toContain('id="agentInstructions"');
    expect(html).toContain('id="workflowDlg"');
    expect(html).toContain('id="wfCanvas"');
    expect(html).toContain('id="wfWires"');
    expect(html).toContain('id="wfIdEdit"');
    expect(html).toContain('id="wfConnectBtn"');
    expect(html).toContain('onclick="wfAddStep()"');
    expect(html).toContain('onclick="wfAutoLayout()"');
    expect(html).toContain('onclick="wfDeleteSelected()"');
    expect(html).toContain('id="delegateDlg"');
    expect(html).toContain('id="confirmDlg"');
    expect(html).toContain('id="authDlg"');
    expect(html).toContain('id="scheduleDlg"');
    expect(html).toContain('id="runStartDlg"');
    expect(html).not.toContain('prompt(');
    expect(html).toContain('Already shared with');
    expect(html).toContain('Shares offered to you');
  });

  it('colors enabled and disabled agents and offers the matching toggle', async () => {
    const html = renderDashboard(
      emptyData({
        agents: [
          { id: 'agt_on', name: 'on', kind: 'local', access: 'you own it', enabled: true },
          { id: 'agt_off', name: 'off', kind: 'local', access: 'you own it', enabled: false }
        ]
      })
    );

    expect(html).toContain('<span class="pill st-succeeded">enabled</span>');
    expect(html).toContain('<span class="pill st-disabled">disabled</span>');
    expect(html).toContain('data-flow="agent-disable"');
    expect(html).toContain('data-flow="agent-enable"');
    // The switched-off row is dimmed but keeps an actionable last cell.
    expect(html).toContain('<tr class="agent-off">');
  });

  it('lists tool servers with an expander for each tool list', async () => {
    const html = renderDashboard(
      emptyData({
        toolservers: [{ name: 'echo', transport: 'stdio', requireApprovalFor: ['danger'] }]
      })
    );

    expect(html).toContain('id="tab-tools"');
    expect(html).toContain('onclick="toggleServer(this)"');
    // Approval gates ride the row so the client can tag tools with no second fetch.
    expect(html).toContain('data-approval="[&quot;danger&quot;]"');
    expect(html).toContain('id="srv-tools-0"');
    expect(html).toContain('id="srv-count-0"');
    expect(html).toContain('data-flow="server-new"');
    expect(html).toContain('id="serverDlg"');
    expect(html).toContain('onclick="doServerSave()"');
  });

  it('uses a modern font stack everywhere, Arial nowhere', async () => {
    const html = renderDashboard(emptyData());

    expect(html).toContain('system-ui, -apple-system, BlinkMacSystemFont');
    expect(html).not.toContain('Arial');
    // Buttons and inputs render in the page font instead of a UA default.
    expect(html).toContain('button, input, select, textarea { font-family: inherit; }');
  });

  it('draws the delegation flow as a graph plus Mermaid source', async () => {
    const html = renderDashboard(
      emptyData({
        jobs: [
          { id: 'job_parent1', state: 'succeeded', agentName: 'coder', backend: 'local', summary: 'do it' },
          {
            id: 'job_child1',
            state: 'running',
            agentName: 'coder',
            backend: 'local',
            summary: 'do a part',
            parentJobId: 'job_parent1'
          }
        ]
      })
    );

    expect(html).toContain('id="tab-delegations"');
    expect(html).toContain('flowchart TD');
    // Inside the <pre> the arrow reads escaped; copying the block decodes it back.
    expect(html).toContain('job_parent1 --&gt; job_child1');
    // The parent edge is a solid wire (no dash pattern); agent edges dash.
    expect(html).toContain('stroke-dasharray');
    expect(html).toContain('id="mermaidSrc"');
    expect(html).toContain('data-flow="copy-mermaid"');
  });

  it('adds hover titles wherever text is cut off', async () => {
    const html = renderDashboard(
      emptyData({
        jobs: [
          {
            id: 'job_123456789',
            state: 'succeeded',
            agentName: 'coder',
            backend: 'local',
            summary: 'a very long summary that gets truncated in the table'
          }
        ]
      })
    );

    expect(html).toContain('title="a very long summary that gets truncated in the table"');
    expect(html).toContain('title="job_123456789"');
  });

  it('wires buttons to the API instead of tool hints, with no auto-refresh', async () => {
    const html = renderDashboard(emptyData());

    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('run this in your MCP client');
    expect(html).toContain("fetch('/api/'");
    expect(html).toContain('window.ORCH_AUTH_REQUIRED = false');
    expect(renderDashboard(emptyData({ auth: { required: true } }))).toContain(
      'window.ORCH_AUTH_REQUIRED = true'
    );
  });

  it('keeps a hostile job summary inert text, never markup', async () => {
    const html = renderDashboard(
      emptyData({
        jobs: [
          {
            id: 'job_evil',
            state: 'succeeded',
            agentName: 'coder',
            backend: 'local',
            summary: '</table><script>alert(1)</script>'
          }
        ]
      })
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/table&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows a failed job reason, not just the red pill', async () => {
    const html = renderDashboard(
      emptyData({
        jobs: [
          {
            id: 'job_failed1',
            state: 'failed',
            agentName: 'coder',
            backend: 'local',
            summary: 'do the thing',
            error: { code: 'RUNNER_FAILED', message: 'The model refused.' }
          },
          {
            id: 'job_ok1',
            state: 'succeeded',
            agentName: 'coder',
            backend: 'local',
            summary: 'done'
          }
        ]
      })
    );

    expect(html).toContain('RUNNER_FAILED');
    expect(html).toContain('The model refused.');
    expect(html).toContain('title="RUNNER_FAILED — The model refused."');
    // The clean job carries no reason block.
    expect(html.match(/class="tag err"/g) ?? []).toHaveLength(1);
  });

  it('keeps a hostile failure reason inert text, never markup', async () => {
    const html = renderDashboard(
      emptyData({
        jobs: [
          {
            id: 'job_evil2',
            state: 'failed',
            agentName: 'coder',
            backend: 'local',
            summary: 'do the thing',
            error: { code: '<b>BAD</b>', message: '</table><script>alert(1)</script>' }
          }
        ]
      })
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>BAD</b>');
    expect(html).toContain('&lt;/table&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows a failed workflow step reason on its DAG node', async () => {
    const html = renderDashboard(
      emptyData({
        runs: [
          {
            runId: 'wfr_1',
            name: 'flow',
            state: 'failed',
            ownerId: '',
            steps: [
              { stepId: 'a', state: 'succeeded' },
              { stepId: 'b', state: 'failed', error: { code: 'DEPENDENCY_FAILED', message: 'Upstream died.' } }
            ],
            updatedAt: new Date().toISOString()
          }
        ]
      })
    );

    expect(html).toContain('DEPENDENCY_FAILED');
    expect(html).toContain('title="b: failed — DEPENDENCY_FAILED: Upstream died."');
  });

  it('shows the pending-approval count as a badge', async () => {
    const html = renderDashboard(
      emptyData({
        approvals: [
          { approvalId: 'apr_1', scope: 'workflow_step', summary: 'Approve step review?' },
          { approvalId: 'apr_2', scope: 'job', summary: 'Delete the index?' }
        ]
      })
    );

    expect(html).toContain('Approvals <span class="pill st-pending">2</span>');
  });
});

describe('collectDashboardData', () => {
  it('collects live rows through the caller principal', async () => {
    const services = await testServices();
    try {
      await services.agents.create({
        name: 'dash-agent',
        instructions: 'Be brief.',
        runner: 'mock',
        ownerId: 'user_alice'
      });
      await services.memory.write({
        ownerId: 'user_alice',
        namespace: 'notes',
        key: 'idea',
        value: 'ship it'
      });

      const data = await collectDashboardData(services, alice, {
        version: '0.0.1',
        startedAt: Date.now(),
        era: 'resource',
        authRequired: false
      });

      expect(data.agents.map(a => a.name)).toContain('dash-agent');
      expect(data.namespaces).toContain('notes');
      expect(data.status.status).toBe('ok');
      // No credential reference ever leaves the store through this view.
      expect(JSON.stringify(data)).not.toContain('credentialsRef');
    } finally {
      await closeServices(services);
    }
  });

  it('hides another owner’s private agent from a non-admin', async () => {
    const services = await testServices();
    try {
      await services.agents.create({
        name: 'bob-private',
        instructions: 'secret',
        runner: 'mock',
        ownerId: 'user_bob'
      });

      const data = await collectDashboardData(services, alice, {
        version: '0.0.1',
        startedAt: Date.now(),
        era: 'resource',
        authRequired: false
      });

      expect(data.agents.map(a => a.name)).not.toContain('bob-private');
    } finally {
      await closeServices(services);
    }
  });

  it('carries agent flags and delegation edges through to the view', async () => {
    const services = await testServices();
    try {
      const agent = await services.agents.create({
        name: 'dash-parent',
        instructions: 'Be brief.',
        runner: 'mock',
        ownerId: 'user_alice',
        enabled: false
      });
      const parent = await services.jobs.create({
        ownerId: 'user_alice',
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: { id: agent.id, name: agent.name, kind: 'local', instructions: 'Be brief.' },
        instruction: 'parent work'
      });
      const child = await services.jobs.create({
        ownerId: 'user_alice',
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: { id: agent.id, name: agent.name, kind: 'local', instructions: 'Be brief.' },
        instruction: 'child work',
        parentJobId: parent.id
      });

      const data = await collectDashboardData(services, alice, {
        version: '0.0.1',
        startedAt: Date.now(),
        era: 'resource',
        authRequired: false
      });

      expect(data.agents.find(a => a.id === agent.id)).toMatchObject({ enabled: false });
      expect(data.jobs.find(j => j.id === child.id)).toMatchObject({
        agentId: agent.id,
        parentJobId: parent.id
      });
      const html = renderDashboard(data);
      expect(html).toContain(`${parent.id} --&gt; ${child.id}`);
    } finally {
      await closeServices(services);
    }
  });

  it('the unauthenticated HTTP principal is non-admin', async () => {
    expect(DASHBOARD_HTTP_PRINCIPAL).toEqual({ ownerId: '', isAdmin: false });
    expect(SINGLE_USER_PRINCIPAL.isAdmin).toBe(true);
  });

  it('carries a failed job reason through to the view', async () => {
    const services = await testServices();
    try {
      const agent = await services.agents.create({
        name: 'dash-fail',
        instructions: 'Be brief.',
        runner: 'mock',
        ownerId: 'user_alice'
      });
      const job = await services.jobs.create({
        ownerId: 'user_alice',
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: { id: agent.id, name: agent.name, kind: 'local', instructions: 'Be brief.' },
        instruction: 'do the thing'
      });
      await services.jobs.transition(job.id, 'running');
      await services.jobs.transition(job.id, 'failed', {
        error: { code: 'RUNNER_FAILED', message: 'The model refused.' }
      });

      const data = await collectDashboardData(services, alice, {
        version: '0.0.1',
        startedAt: Date.now(),
        era: 'resource',
        authRequired: false
      });

      expect(data.jobs).toEqual([
        expect.objectContaining({
          id: job.id,
          state: 'failed',
          error: { code: 'RUNNER_FAILED', message: 'The model refused.' }
        })
      ]);
      // And the rendered page shows the reason, not just the pill.
      expect(renderDashboard(data)).toContain('title="RUNNER_FAILED — The model refused."');
    } finally {
      await closeServices(services);
    }
  });
});
