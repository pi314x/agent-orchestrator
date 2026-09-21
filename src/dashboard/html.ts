import { shortId, type DashboardData } from './data.js';

/**
 * Server-rendered dashboard matching the approved mockup's seven tabs, with
 * buttons wired to the interactive API in `src/dashboard/api.ts` — same
 * owner-scoped store calls as the MCP tools, same bearer-token identity when
 * OAuth is on. The first paint is server-rendered rows; every mutation goes
 * through `fetch` and reloads the page.
 *
 * Everything dynamic goes through escapeHtml: agent names, instructions,
 * result text and event payloads are untrusted model or remote output, and a
 * `<script>` smuggled through a job summary must stay inert text — including
 * inside the data attributes the buttons carry.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pillClass(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === 'queued') return 'st-queued';
  if (normalized === 'running' || normalized === 'working') return 'st-running';
  if (normalized === 'succeeded' || normalized === 'completed') return 'st-succeeded';
  if (normalized === 'failed' || normalized === 'rejected' || normalized === 'timed_out') return 'st-failed';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'blocked') return 'st-blocked';
  if (normalized === 'awaiting_input' || normalized === 'awaiting_approval') return 'st-awaiting';
  if (normalized === 'pending' || normalized === 'paused' || normalized === 'awaiting') return 'st-pending';
  return 'st-queued';
}

function apiButton(
  label: string,
  method: string,
  path: string,
  opts: { body?: Record<string, unknown>; confirm?: string; prompt?: string; danger?: boolean; go?: boolean } = {}
): string {
  const attrs = [`data-api="${method} ${escapeHtml(path)}"`];
  if (opts.body !== undefined) attrs.push(`data-body='${escapeHtml(JSON.stringify(opts.body))}'`);
  if (opts.confirm !== undefined) attrs.push(`data-confirm="${escapeHtml(opts.confirm)}"`);
  if (opts.prompt !== undefined) attrs.push(`data-prompt="${escapeHtml(opts.prompt)}"`);
  const cls = `act${opts.danger === true ? ' danger' : ''}${opts.go === true ? ' go' : ''}`;
  return `<button class="${cls}" ${attrs.join(' ')} onclick="act(this)">${escapeHtml(label)}</button>`;
}

/** A button handled by a named JS flow (dialogs, polling) instead of one call. */
function flowButton(label: string, flow: string, data: Record<string, string> = {}, danger = false): string {
  const attrs = [`data-flow="${flow}"`];
  for (const [key, value] of Object.entries(data)) attrs.push(`data-${key}="${escapeHtml(value)}"`);
  return `<button class="act${danger ? ' danger' : ''}" ${attrs.join(' ')} onclick="flow(this)">${escapeHtml(label)}</button>`;
}

export function renderDashboard(data: DashboardData): string {
  const agents = data.agents
    .map(
      agent => `<tr class="${agent.enabled ? '' : 'agent-off'}"><td><code title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</code></td><td>${escapeHtml(agent.kind)}</td>` +
        `<td title="${escapeHtml(agent.role ?? '')}">${escapeHtml(agent.role ?? '—')}</td><td>${escapeHtml(agent.runner ?? '—')}</td>` +
        `<td>${accessTags(agent)}</td><td>${enabledPill(agent.enabled)}</td><td>${agentActions(agent)}</td></tr>`
    )
    .join('');

  const jobs = data.jobs
    .map(
      job => `<tr data-state="${escapeHtml(job.state)}"><td><code title="${escapeHtml(job.id)}">${escapeHtml(shortId(job.id))}</code></td>` +
        `<td><span class="pill ${pillClass(job.state)}">${escapeHtml(job.state)}</span></td>` +
        `<td title="${escapeHtml(job.agentName)} · ${escapeHtml(job.backend)}">${escapeHtml(job.agentName)} · ${escapeHtml(job.backend)}</td>` +
        `<td><span class="trunc-wrap" title="${escapeHtml(job.summary)}">${escapeHtml(job.summary)}</span>${usageSuffix(job.usage)}${jobErrorLine(job.error)}</td>` +
        `<td>${jobActions(job.id, job.state)}</td></tr>`
    )
    .join('');

  const runs = data.runs
    .map(
      run => `<div class="card"><b title="${escapeHtml(run.name)}">${escapeHtml(run.name)}</b> ` +
        `<span class="meta">${escapeHtml(run.state)} · owned by ${escapeHtml(run.ownerId === '' ? 'you' : run.ownerId)}</span>` +
        `<div class="dag">${run.steps.map(runStepNode).join('<div class="arrow">→</div>')}</div>` +
        `<div style="margin-top:8px">${flowButton('Control…', 'run-control', { run: run.runId })} ` +
        `${flowButton('Export', 'run-export', { run: run.runId })}</div></div>`
    )
    .join('');

  const definitions = data.definitions
    .map(
      definition => `<div class="card"><b title="${escapeHtml(definition.name)}">${escapeHtml(definition.name)}</b> ` +
        `<span class="meta">${definition.steps.length} step(s)</span>` +
        `<div class="dag">${definition.steps.map(step => `<div class="step" title="${escapeHtml(step)}"><div class="nm">${escapeHtml(step)}</div></div>`).join('<div class="arrow">→</div>')}</div>` +
        `<div style="margin-top:8px">${flowButton('Start run', 'run-start', { id: definition.id })} ` +
        `${flowButton('Edit steps', 'workflow-edit', { id: definition.id })} ` +
        `${apiButton('Delete', 'DELETE', `/api/workflows/${encodeURIComponent(definition.id)}`, { body: { confirm: true }, confirm: `Delete workflow "${definition.name}"? Past runs stay in history.`, danger: true })} ` +
        `${flowButton('Share…', 'share', { kind: 'workflow', id: definition.id, label: definition.name })}</div></div>`
    )
    .join('');

  const approvals = data.approvals
    .map(
      approval => `<tr><td><code title="${escapeHtml(approval.approvalId)}">${escapeHtml(shortId(approval.approvalId))}</code></td>` +
        `<td><span class="tag">${escapeHtml(approval.scope)}</span></td>` +
        `<td><span class="trunc-wrap" title="${escapeHtml(approval.summary)}">${escapeHtml(approval.summary)}</span></td>` +
        `<td>${apiButton('Approve', 'POST', `/api/approvals/${encodeURIComponent(approval.approvalId)}/resolve`, { body: { decision: 'approve' }, go: true })} ` +
        `${apiButton('Reject', 'POST', `/api/approvals/${encodeURIComponent(approval.approvalId)}/resolve`, { body: { decision: 'reject' }, danger: true })}</td></tr>`
    )
    .join('');

  const schedules = data.schedules
    .map(
      schedule => `<tr><td><code title="${escapeHtml(schedule.name)}">${escapeHtml(schedule.name)}</code></td>` +
        `<td><code>${escapeHtml(schedule.cron)}</code> · ${escapeHtml(schedule.timezone ?? 'UTC')}</td>` +
        `<td title="${escapeHtml(schedule.target)}">${escapeHtml(schedule.target)}</td><td>${escapeHtml(schedule.nextRunAt)}</td>` +
        `<td>${escapeHtml(schedule.overlap)}</td>` +
        `<td>${apiButton(schedule.enabled ? 'Pause' : 'Resume', 'PATCH', `/api/schedules/${encodeURIComponent(schedule.scheduleId)}`, { body: { enabled: !schedule.enabled } })} ` +
        `${flowButton('Preview', 'schedule-preview', { id: schedule.scheduleId, cron: schedule.cron })} ` +
        `${apiButton('Delete', 'DELETE', `/api/schedules/${encodeURIComponent(schedule.scheduleId)}`, { body: { confirm: true }, confirm: `Delete schedule "${schedule.name}"? Fired jobs run on.`, danger: true })}</td></tr>`
    )
    .join('');

  const namespaces = data.namespaces
    .map(
      namespace => `<tr><td><code title="${escapeHtml(namespace)}">${escapeHtml(namespace)}</code></td>` +
        `<td>${flowButton('Read', 'memory-read', { namespace })} ` +
        `${flowButton('Share…', 'share', { kind: 'memory', id: namespace, label: `namespace ${namespace}` })}</td></tr>`
    )
    .join('');

  const artifacts = data.artifacts
    .map(
      artifact => `<tr><td title="${escapeHtml(artifact.name)}">${escapeHtml(artifact.name)}</td><td>${escapeHtml(formatBytes(artifact.sizeBytes))}</td>` +
        `<td>${flowButton('Read', 'artifact-read', { id: artifact.artifactId, name: artifact.name })} ` +
        `${apiButton('Delete', 'DELETE', `/api/artifacts/${encodeURIComponent(artifact.artifactId)}`, { body: { confirm: true }, confirm: `Delete artifact "${artifact.name}"? Irreversible.`, danger: true })}</td></tr>`
    )
    .join('');

  const budgets = data.budgets
    .map(
      budget => `<div style="margin:6px 0" title="${escapeHtml(budget.scope)}${budget.scopeId === undefined ? '' : ` ${escapeHtml(budget.scopeId)}`}">${escapeHtml(budget.scope)}${budget.scopeId === undefined ? '' : ` <code>${escapeHtml(budget.scopeId)}</code>`} — ` +
        `${escapeHtml(describeCaps(budget))}</div>`
    )
    .join('');

  const servers = data.toolservers
    .map(
      (server, i) =>
        `<tr class="srv-row" data-server="${escapeHtml(server.name)}" data-idx="${i}" data-approval="${escapeHtml(JSON.stringify(server.requireApprovalFor))}">` +
        `<td><button class="srv-toggle" onclick="toggleServer(this)" title="Show tools on ${escapeHtml(server.name)}"><span class="srv-caret">▸</span> <code>${escapeHtml(server.name)}</code></button></td>` +
        `<td>${escapeHtml(server.transport)}</td>` +
        `<td class="meta srv-count" id="srv-count-${i}">—</td>` +
        `<td>${apiButton('Remove', 'DELETE', `/api/toolservers/${encodeURIComponent(server.name)}`, { body: { confirm: true }, confirm: `Remove tool server "${server.name}"? Agents lose its tools.`, danger: true })}</td></tr>` +
        `<tr class="srv-detail" id="srv-detail-${i}" hidden><td colspan="4"><div class="srv-tools" id="srv-tools-${i}"></div></td></tr>`
    )
    .join('');

  const feed = data.events
    .map(
      event => `<div title="${escapeHtml(event.label)}"><span class="ts">${escapeHtml(event.ts.slice(11, 19))}</span> ${escapeHtml(event.label)}</div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Orchestrator — Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Agent Orchestrator</h1>
  <span class="pill ${data.status.status === 'ok' ? 'ok' : 'st-failed'}">● ${escapeHtml(data.status.status)} · v${escapeHtml(data.status.version)}</span>
  <span class="pill">profile: ${escapeHtml(data.status.toolProfile)}</span>
  <span class="meta">queue ${data.status.jobs.queued} · running ${data.status.jobs.running} · blocked ${data.status.jobs.blocked} &nbsp;·&nbsp; signed in as <code>${escapeHtml(data.status.caller.ownerId === '' ? 'single-owner' : data.status.caller.ownerId)}</code>${data.status.caller.isAdmin ? ' <span class="pill admin">admin</span>' : ''}</span>
  <span class="meta"><button class="act" onclick="location.reload()">Refresh</button></span>
  <span class="meta" id="authZone"></span>
</header>
<nav id="tabs">
  <button class="active" data-tab="agents">Agents</button>
  <button data-tab="jobs">Jobs</button>
  <button data-tab="delegations">Delegations</button>
  <button data-tab="workflows">Workflows</button>
  <button data-tab="approvals">Approvals${data.approvals.length > 0 ? ` <span class="pill st-pending">${data.approvals.length}</span>` : ''}</button>
  <button data-tab="schedules">Schedules</button>
  <button data-tab="memory">Memory &amp; Artifacts</button>
  <button data-tab="tools">Tools</button>
  <button data-tab="obs">Observability</button>
</nav>
<main>
<section class="tab active" id="tab-agents">
  <div class="toolbar">
    <input id="agentFilter" placeholder="Filter agents…" oninput="filterTable('agentRows', this.value)">
    ${flowButton('+ New agent', 'agent-new', {})}
    ${flowButton('New grant preset', 'preset-new', {})}
  </div>
  <div class="card"><table>
    <tr><th>Name</th><th>Kind</th><th>Role</th><th>Runner</th><th>Access</th><th>Status</th><th>Actions</th></tr>
    <tbody id="agentRows">${agents === '' ? '<tr><td colspan="7" class="meta">No agents visible.</td></tr>' : agents}</tbody>
  </table></div>
  <div class="card"><b>Shares offered to you</b> <span class="meta">(accept to use — pending confers nothing)</span><div class="meta" id="incomingBox">(loading…)</div></div>
</section>
<section class="tab" id="tab-jobs">
  <div class="toolbar">
    <select id="jobState" onchange="filterState(this.value)">
      <option value="">all states</option><option>queued</option><option>running</option>
      <option>blocked</option><option>succeeded</option><option>failed</option><option>cancelled</option>
    </select>
    ${flowButton('+ Delegate', 'delegate-any', {})}
    ${flowButton('Queue job', 'job-new', {})}
  </div>
  <div class="card"><table>
    <tr><th>Job</th><th>State</th><th>Agent · backend</th><th>Detail</th><th>Actions</th></tr>
    <tbody id="jobRows">${jobs === '' ? '<tr><td colspan="5" class="meta">No jobs yet.</td></tr>' : jobs}</tbody>
  </table></div>
</section>
<section class="tab" id="tab-delegations">
  <div class="toolbar"><span class="meta">Agent → job · parent → child, over the 20 most recent jobs.</span></div>
  <div class="card"><b>Delegation flow</b>
    <div style="overflow:auto;margin-top:10px">${delegationGraph(data.jobs)}</div>
  </div>
</section>
<section class="tab" id="tab-workflows">
  <div class="toolbar">
    ${flowButton('+ Plan & define', 'workflow-define', {})}
  </div>
  ${definitions === '' ? '' : `<div class="meta" style="margin-bottom:8px">Definitions — start one to create a run.</div>${definitions}`}
  ${runs === '' ? '<div class="card meta">No runs yet.</div>' : `<div class="meta" style="margin:12px 0 8px">Runs</div>${runs}`}
</section>
<section class="tab" id="tab-approvals">
  <div class="card"><table>
    <tr><th>Gate</th><th>Scope</th><th>Summary</th><th>Actions</th></tr>
    ${approvals === '' ? '<tr><td colspan="4" class="meta">No pending approvals.</td></tr>' : approvals}
  </table></div>
</section>
<section class="tab" id="tab-schedules">
  <div class="toolbar">${flowButton('+ New schedule', 'schedule-new', {})}</div>
  <div class="card"><table>
    <tr><th>Name</th><th>Cron · zone</th><th>Target</th><th>Next run</th><th>Overlap</th><th>Actions</th></tr>
    ${schedules === '' ? '<tr><td colspan="6" class="meta">No schedules.</td></tr>' : schedules}
  </table></div>
</section>
<section class="tab" id="tab-memory">
  <div class="grid2">
    <div class="card"><b>Memory namespaces</b><table>
      <tr><th>Namespace</th><th></th></tr>
      ${namespaces === '' ? '<tr><td colspan="2" class="meta">No namespaces.</td></tr>' : namespaces}
    </table></div>
    <div class="card"><b>Artifacts</b><table>
      <tr><th>Name</th><th>Size</th><th></th></tr>
      ${artifacts === '' ? '<tr><td colspan="3" class="meta">No artifacts.</td></tr>' : artifacts}
    </table></div>
  </div>
</section>
<section class="tab" id="tab-tools">
  <div class="toolbar">
    <span class="meta">Downstream MCP servers <span class="meta">(admin)</span> — click a server to list its tools.</span>
    ${flowButton('+ Add server', 'server-new', {})}
  </div>
  <div class="card"><table>
    <tr><th>Server</th><th>Transport</th><th>Tools</th><th></th></tr>
    <tbody id="serverRows">${servers === '' ? '<tr><td colspan="4" class="meta">None registered, or not an admin view.</td></tr>' : servers}</tbody>
  </table></div>
</section>
<section class="tab" id="tab-obs">
  <div class="grid2">
    <div class="card"><b>Usage &amp; budgets</b>
      <div style="margin:6px 0">recent ${data.recentTotals.jobs} job(s): ${data.recentTotals.inputTokens} in / ${data.recentTotals.outputTokens} out tokens${data.recentTotals.costUsd > 0 ? ` · $${data.recentTotals.costUsd.toFixed(4)}` : ''}</div>
      ${budgets === '' ? '<div class="meta">No caps set.</div>' : budgets}
      <div style="margin-top:8px">${flowButton('Set cap…', 'budget-set', {})}
      ${flowButton('Full report', 'usage-report', {})}
      ${flowButton('Prune…', 'prune', {}, true)}</div>
    </div>
    <div class="card"><b>Post-quantum</b> <span class="meta">(NIST FIPS 203/204)</span>
      <div style="margin:6px 0">${data.status.pqc.algorithms.map(a => `<span class="tag">${escapeHtml(a)}</span>`).join('')}</div>
      <div class="meta">at-rest encryption: ${data.status.pqc.atRest ? 'on (artifacts + memory values sealed)' : 'off (plaintext at rest)'} · card signing: ${data.status.pqc.cardSigned ? 'on (ML-DSA-65 entry on the published card)' : 'off'}</div>
    </div>
  </div>
  <div class="card"><b>Event feed</b> <span class="meta">(append-only audit)</span><div class="feed" id="feed">${feed === '' ? '<div class="meta">No events yet.</div>' : feed}</div></div>
</section>
</main>

<dialog id="shareDlg">
  <div class="dlg-head"><b id="shareTitle">Share</b><button class="dlg-x" onclick="closeDlg('shareDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta">Read + delegate only. They read their owner id from their own orchestrator_status. They must accept before it takes effect — pending until then.</div>
    <label class="f" for="grantee">Their owner id <span class="req">*</span></label>
    <input id="grantee" placeholder="user_bob" autocomplete="off">
    <div class="hint" id="granteeHint"></div>
    <input id="shareKind" type="hidden">
    <input id="shareId" type="hidden">
    <div style="margin-top:10px"><b>Already shared with</b><div class="meta" id="shareList">(loading…)</div></div>
    <div class="err" id="shareErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('shareDlg')">Cancel</button>
    <button class="act go" id="shareGo" onclick="doShare()">Share</button>
  </div>
</dialog>
<dialog id="agentDlg">
  <div class="dlg-head"><b id="agentDlgTitle">New agent</b><button class="dlg-x" onclick="closeDlg('agentDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta">Persistent local agent. Instructions are the system prompt the model sees.</div>
    <label class="f" for="agentName">Name <span class="req">*</span></label>
    <input id="agentName" placeholder="reviewer" autocomplete="off">
    <label class="f" for="agentRole">Role</label>
    <input id="agentRole" placeholder="reviewer" autocomplete="off">
    <label class="f" for="agentInstructions">Description / system prompt <span class="req">*</span></label>
    <textarea id="agentInstructions" rows="10" placeholder="You are a reviewer. …"></textarea>
    <div class="grid2">
      <div><label class="f" for="agentRunner">Runner</label><select id="agentRunner"><option value="">default</option><option>anthropic</option><option>openai-compatible</option><option>cli</option><option>mock</option><option>sampling</option></select></div>
      <div><label class="f" for="agentModel">Model (optional)</label><input id="agentModel" placeholder="gpt-… / claude-…" autocomplete="off"></div>
    </div>
    <input id="agentId" type="hidden">
    <div class="err" id="agentErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('agentDlg')">Cancel</button>
    <button class="act go" id="agentGo" onclick="doSaveAgent()">Save</button>
  </div>
</dialog>
<dialog id="workflowDlg" class="wide">
  <div class="dlg-head"><b id="workflowDlgTitle">New workflow</b><button class="dlg-x" onclick="closeDlg('workflowDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta">Draw the DAG: drag nodes to arrange, click a node to edit, use Connect then click two nodes to add a dependency. Edges can also be toggled in the inspector.</div>
    <label class="f" for="wfName">Workflow name <span class="req">*</span></label>
    <input id="wfName" placeholder="ship-feature" autocomplete="off">
    <div class="wf-toolbar">
      <button class="act" onclick="wfAddStep()">+ Add step</button>
      <button class="act" id="wfConnectBtn" onclick="wfToggleConnect()">Connect: off</button>
      <button class="act" onclick="wfAutoLayout()">Auto-layout</button>
      <button class="act danger" onclick="wfDeleteSelected()">Delete selected</button>
      <span class="wf-mode" id="wfMode">click a node to edit</span>
    </div>
    <div class="wf-layout">
      <div class="wf-canvas-wrap"><div class="wf-canvas" id="wfCanvas"><svg class="wires" id="wfWires"><defs><marker id="wfArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8fa0b3"></path></marker></defs></svg></div></div>
      <div class="wf-insp"><b>Step inspector</b><div class="meta" id="wfSelName">no selection</div>
        <label class="f" for="wfIdEdit">Step id <span class="req">*</span></label><input id="wfIdEdit" placeholder="plan" autocomplete="off">
        <label class="f" for="wfInstrEdit">Instruction <span class="req">*</span></label><textarea id="wfInstrEdit" rows="5" placeholder="Instruction — supports {{inputs.x}} and {{steps.&lt;id&gt;.output}}"></textarea>
        <label class="f" for="wfKindEdit">Target</label><select id="wfKindEdit"><option value="template">template</option><option value="agentId">agentId</option><option value="skillQuery">skillQuery</option></select>
        <input id="wfTargetEdit" placeholder="coder" autocomplete="off">
        <label class="f">Depends on</label><div id="wfDeps"></div>
        <label class="f"><input id="wfApprEdit" type="checkbox" style="width:auto"> pause for approval before this step</label>
        <div class="err" id="wfStepErr"></div>
      </div>
    </div>
    <input id="wfId" type="hidden">
    <div class="err" id="wfErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('workflowDlg')">Cancel</button>
    <button class="act go" id="wfGo" onclick="doSaveWorkflow()">Save definition</button>
  </div>
</dialog>
<dialog id="runStartDlg">
  <div class="dlg-head"><b>Start run</b><button class="dlg-x" onclick="closeDlg('runStartDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta" id="runStartName"></div>
    <div style="margin:8px 0"><b>Inputs</b> <button class="act" onclick="addRunInput()">+ Add input</button></div>
    <div id="runInputs"></div>
    <input id="runStartId" type="hidden">
    <div class="err" id="runStartErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('runStartDlg')">Cancel</button>
    <button class="act go" id="runStartGo" onclick="doStartRun()">Start</button>
  </div>
</dialog>
<dialog id="delegateDlg">
  <div class="dlg-head"><b id="delegateTitle">Delegate</b><button class="dlg-x" onclick="closeDlg('delegateDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="delegateInstr">Instruction <span class="req">*</span></label>
    <textarea id="delegateInstr" rows="6" placeholder="What should the agent do?"></textarea>
    <label class="f" for="delegateTemplate">Template (blank for default)</label>
    <input id="delegateTemplate" value="coder" autocomplete="off">
    <input id="delegateAgent" type="hidden">
    <div class="err" id="delegateErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('delegateDlg')">Cancel</button>
    <button class="act go" id="delegateGo" onclick="doDelegate()">Delegate</button>
  </div>
</dialog>
<dialog id="jobDlg">
  <div class="dlg-head"><b>Queue job</b><button class="dlg-x" onclick="closeDlg('jobDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="jobInstr">Instruction <span class="req">*</span></label>
    <textarea id="jobInstr" rows="6" placeholder="What should run?"></textarea>
    <label class="f" for="jobTemplate">Template (blank for default)</label>
    <input id="jobTemplate" value="coder" autocomplete="off">
    <div class="err" id="jobErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('jobDlg')">Cancel</button>
    <button class="act go" id="jobGo" onclick="doQueueJob()">Queue</button>
  </div>
</dialog>
<dialog id="steerDlg">
  <div class="dlg-head"><b>Steer running job</b><button class="dlg-x" onclick="closeDlg('steerDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="steerMsg">Guidance <span class="req">*</span></label>
    <textarea id="steerMsg" rows="5" placeholder="Nudge the running job…"></textarea>
    <input id="steerId" type="hidden">
    <div class="err" id="steerErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('steerDlg')">Cancel</button>
    <button class="act go" id="steerGo" onclick="doSteer()">Send</button>
  </div>
</dialog>
<dialog id="presetDlg">
  <div class="dlg-head"><b>New grant preset</b><button class="dlg-x" onclick="closeDlg('presetDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="presetName">Preset name <span class="req">*</span></label>
    <input id="presetName" placeholder="reader" autocomplete="off">
    <label class="f" for="presetGrants">Grants, comma-separated <span class="req">*</span></label>
    <input id="presetGrants" placeholder="files, files/read_file" autocomplete="off">
    <div class="hint">One server ("files") or one tool ("files/read_file") each.</div>
    <div class="err" id="presetErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('presetDlg')">Cancel</button>
    <button class="act go" id="presetGo" onclick="doPreset()">Save</button>
  </div>
</dialog>
<dialog id="scheduleDlg">
  <div class="dlg-head"><b>New schedule</b><button class="dlg-x" onclick="closeDlg('scheduleDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="schedName">Schedule name <span class="req">*</span></label><input id="schedName" placeholder="morning" autocomplete="off">
    <label class="f" for="schedCron">Cron (five fields) <span class="req">*</span></label><input id="schedCron" placeholder="0 9 * * mon-fri" autocomplete="off">
    <label class="f" for="schedInstr">Instruction <span class="req">*</span></label><textarea id="schedInstr" rows="5" placeholder="What should run?"></textarea>
    <label class="f" for="schedTemplate">Template (blank for default reviewer)</label><input id="schedTemplate" placeholder="reviewer" autocomplete="off">
    <div class="err" id="schedErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('scheduleDlg')">Cancel</button>
    <button class="act go" id="schedGo" onclick="doSchedule()">Create</button>
  </div>
</dialog>
<dialog id="memoryDlg">
  <div class="dlg-head"><b id="memoryTitle">Read memory</b><button class="dlg-x" onclick="closeDlg('memoryDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="memoryKey">Key <span class="req">*</span></label><input id="memoryKey" autocomplete="off">
    <input id="memoryNs" type="hidden">
    <div class="err" id="memoryErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('memoryDlg')">Cancel</button>
    <button class="act go" id="memoryGo" onclick="doMemoryRead()">Read</button>
  </div>
</dialog>
<dialog id="budgetDlg">
  <div class="dlg-head"><b>Set cap</b><button class="dlg-x" onclick="closeDlg('budgetDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="budgetScope">Scope</label><select id="budgetScope"><option>global</option><option>agent</option><option>job</option></select>
    <label class="f" for="budgetId">Scope id (agent or job id, blank for global)</label><input id="budgetId" autocomplete="off">
    <label class="f" for="budgetCost">Max cost USD (blank to skip)</label><input id="budgetCost" inputmode="decimal" placeholder="50" autocomplete="off">
    <div class="err" id="budgetErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('budgetDlg')">Cancel</button>
    <button class="act go" id="budgetGo" onclick="doBudget()">Save</button>
  </div>
</dialog>
<dialog id="runControlDlg">
  <div class="dlg-head"><b>Control run</b><button class="dlg-x" onclick="closeDlg('runControlDlg')">✕</button></div>
  <div class="dlg-body">
    <label class="f" for="runAction">Action</label><select id="runAction"><option>pause</option><option>resume</option><option>cancel</option><option>retry_step</option><option>reconcile</option></select>
    <label class="f" for="runStep">Step id (for retry_step)</label><input id="runStep" autocomplete="off">
    <input id="runCtlId" type="hidden">
    <div class="hint">Cancelling discards in-flight work and cannot be undone.</div>
    <div class="err" id="runCtlErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('runControlDlg')">Cancel</button>
    <button class="act go" id="runCtlGo" onclick="doRunControl()">Apply</button>
  </div>
</dialog>
<dialog id="confirmDlg">
  <div class="dlg-head"><b id="confirmTitle">Confirm</b><button class="dlg-x" onclick="closeDlg('confirmDlg')">✕</button></div>
  <div class="dlg-body"><div id="confirmMsg"></div></div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('confirmDlg')">Cancel</button>
    <button class="act danger" id="confirmGo">Confirm</button>
  </div>
</dialog>
<dialog id="serverDlg">
  <div class="dlg-head"><b>Add MCP server</b><button class="dlg-x" onclick="closeDlg('serverDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta">A downstream MCP server local agents may call. Re-saving a name replaces it.</div>
    <label class="f" for="serverName">Server name <span class="req">*</span></label>
    <input id="serverName" placeholder="files" autocomplete="off">
    <label class="f" for="serverTransport">Transport</label>
    <select id="serverTransport" onchange="serverTransportChanged()"><option value="stdio">stdio</option><option value="http">http</option></select>
    <div id="serverStdio">
      <label class="f" for="serverCommand">Command <span class="req">*</span></label>
      <input id="serverCommand" placeholder="npx" autocomplete="off">
      <label class="f" for="serverArgs">Args, comma-separated</label>
      <input id="serverArgs" placeholder="-y, mcp-server-files" autocomplete="off">
      <label class="f" for="serverCwd">Working directory (blank for default)</label>
      <input id="serverCwd" autocomplete="off">
    </div>
    <div id="serverHttp" style="display:none">
      <label class="f" for="serverUrl">URL <span class="req">*</span></label>
      <input id="serverUrl" placeholder="https://tools.example.com/mcp" autocomplete="off">
    </div>
    <label class="f" for="serverAuthRef">Auth ref (env var or secret name, blank for none)</label>
    <input id="serverAuthRef" autocomplete="off">
    <label class="f" for="serverAllow">Allow tools, comma-separated (blank for all)</label>
    <input id="serverAllow" placeholder="read_file, write_file" autocomplete="off">
    <label class="f" for="serverDeny">Deny tools, comma-separated (always wins)</label>
    <input id="serverDeny" autocomplete="off">
    <label class="f" for="serverApproval">Require approval for, comma-separated</label>
    <input id="serverApproval" autocomplete="off">
    <div class="err" id="serverErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('serverDlg')">Cancel</button>
    <button class="act go" id="serverGo" onclick="doServerSave()">Save</button>
  </div>
</dialog>
<dialog id="viewDlg">
  <div class="dlg-head"><b id="viewTitle">Details</b><button class="dlg-x" onclick="closeDlg('viewDlg')">✕</button></div>
  <div class="dlg-body"><pre id="viewBody"></pre></div>
  <div class="dlg-foot"><button class="act" onclick="closeDlg('viewDlg')">Close</button></div>
</dialog>
<dialog id="authDlg">
  <div class="dlg-head"><b>Sign in</b><button class="dlg-x" onclick="closeDlg('authDlg')">✕</button></div>
  <div class="dlg-body">
    <div class="meta">Paste the bearer token from your OAuth login. It stays in sessionStorage (never a cookie).</div>
    <label class="f" for="authToken">Bearer token <span class="req">*</span></label>
    <input id="authToken" type="password" autocomplete="off" placeholder="eyJ…">
    <div class="err" id="authErr"></div>
  </div>
  <div class="dlg-foot">
    <button class="act" onclick="closeDlg('authDlg')">Cancel</button>
    <button class="act go" id="authGo" onclick="doAuth()">Sign in</button>
  </div>
</dialog>
<div id="toast"></div>
<script>
window.ORCH_AUTH_REQUIRED = ${data.auth.required ? 'true' : 'false'};
</script>
<script>${JS}</script>
</body>
</html>`;
}

function accessTags(agent: { access: string; sharedBy?: string; trustLevel?: string }): string {
  const tags: string[] = [];
  if (agent.access === 'you own it') tags.push('<span class="tag">you own it</span>');
  else if (agent.access === 'shared · admin') tags.push('<span class="tag shared">shared · admin</span>');
  else tags.push('<span class="tag you">shared with you</span>');
  if (agent.sharedBy !== undefined) tags.push(`<span class="tag">by ${escapeHtml(agent.sharedBy)}</span>`);
  if (agent.trustLevel === 'verified') tags.push('<span class="tag verified">verified</span>');
  else if (agent.trustLevel === 'unverified') tags.push('<span class="tag unverified">unverified</span>');
  return tags.join(' ');
}

/** Green when the agent runs jobs, grey when it is switched off. */
function enabledPill(enabled: boolean): string {
  return enabled ? '<span class="pill st-succeeded">enabled</span>' : '<span class="pill st-disabled">disabled</span>';
}

function agentActions(agent: { id: string; name: string; kind: string; access: string; enabled: boolean }): string {
  const mine = agent.access === 'you own it';
  const parts = [
    flowButton('Delegate', 'delegate', { agentId: agent.id, name: agent.name }),
    flowButton('Share…', 'share', { kind: 'agent', id: agent.id, label: agent.name })
  ];
  if (mine && agent.kind === 'local') parts.push(flowButton('Edit', 'agent-edit', { id: agent.id, name: agent.name }));
  if (mine) {
    parts.push(
      agent.enabled
        ? flowButton('Disable', 'agent-disable', { id: agent.id, name: agent.name })
        : flowButton('Enable', 'agent-enable', { id: agent.id, name: agent.name })
    );
    parts.push(flowButton('Delete', 'agent-delete', { id: agent.id, name: agent.name }, true));
  } else parts.push(flowButton('Why read-only?', 'agent-inspect', { id: agent.id }));
  return parts.join('');
}

function usageSuffix(usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }): string {
  if (usage === undefined) return '';
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens === 0 && usage.costUsd === undefined) return '';
  return ` · ${tokens} tok${usage.costUsd === undefined ? '' : ` / $${usage.costUsd.toFixed(4)}`}`;
}

/**
 * The failure reason for a settled-bad job, rendered under the summary: the
 * state pill says *what* happened, this says *why*. Everything is escaped —
 * error text is runner output and gets no more trust than a job summary.
 */
function jobErrorLine(error?: { code: string; message: string }): string {
  if (error === undefined) return '';
  const full = `${error.code} — ${error.message}`;
  return `<br><span class="tag err" title="${escapeHtml(full)}">${escapeHtml(error.code)}</span> ` +
    `<span class="err-msg" title="${escapeHtml(full)}">${escapeHtml(error.message)}</span>`;
}

/** One DAG node for a run step; a failed step carries its reason visibly, not just a red pill. */
function runStepNode(step: { stepId: string; state: string; error?: { code: string; message: string } }): string {
  const reason = step.error === undefined ? '' : ` — ${step.error.code}: ${step.error.message}`;
  const chip =
    step.error === undefined
      ? ''
      : `<div class="err-line" title="${escapeHtml(`${step.stepId}: ${step.error.code} — ${step.error.message}`)}">${escapeHtml(step.error.code)}</div>`;
  return `<div class="step" title="${escapeHtml(`${step.stepId}: ${step.state}${reason}`)}">` +
    `<div class="nm">${escapeHtml(step.stepId)}</div>` +
    `<span class="pill ${pillClass(step.state)}">${escapeHtml(step.state)}</span>${chip}</div>`;
}

type DelegationJob = {
  id: string;
  state: string;
  agentName: string;
  summary: string;
  parentJobId?: string;
};

/** Mermaid node ids admit letters, digits and `_` — everything else becomes one. */
function mermaidId(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(clean) ? clean : `n_${clean}`;
}

/** Mermaid labels are double-quoted: no quotes, no newlines, capped. */
function mermaidLabel(raw: string): string {
  return raw.replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * The same edges as the graph below, as `flowchart TD` source for pasting
 * into any Mermaid renderer. Agent → job for roots, parent → child after
 * that; a parent outside the recent-jobs window renders as a stub node so
 * the edge still reads.
 */
function delegationMermaid(jobs: DelegationJob[]): string {
  const lines = ['flowchart TD'];
  const agents = Array.from(new Set(jobs.map(job => job.agentName)));
  agents.forEach((name, i) => {
    lines.push('  ag' + i + '["agent ' + mermaidLabel(name) + '"]');
  });
  const byId = new Map(jobs.map(job => [job.id, job]));
  jobs.forEach(job => {
    const jid = mermaidId(job.id);
    const label = mermaidLabel(shortId(job.id) + ' ' + job.state + ' — ' + job.summary);
    lines.push('  ' + jid + '["' + label + '"]');
    if (job.parentJobId !== undefined && byId.has(job.parentJobId)) {
      lines.push('  ' + mermaidId(job.parentJobId) + ' --> ' + jid);
    } else {
      lines.push('  ag' + agents.indexOf(job.agentName) + ' --> ' + jid);
    }
    if (job.parentJobId !== undefined && !byId.has(job.parentJobId)) {
      const pid = mermaidId(job.parentJobId);
      lines.push('  ' + pid + '["' + mermaidLabel(shortId(job.parentJobId) + ' (outside view)') + '"]');
      lines.push('  ' + pid + ' --> ' + jid);
    }
  });
  return lines.join('\n');
}

/**
 * Who delegated to whom, drawn with positioned divs over an SVG underlay —
 * no client library, coordinates computed here so the markup is static.
 * Columns are delegation depth (agents first), rows stack within a column.
 */
function delegationGraph(jobs: DelegationJob[]): string {
  if (jobs.length === 0) {
    return '<div class="card meta">No delegations yet — delegate to an agent first.</div>';
  }
  const byId = new Map(jobs.map(job => [job.id, job]));
  const depth = new Map<string, number>();
  const calc = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const job = byId.get(id);
    const d =
      job?.parentJobId !== undefined && byId.has(job.parentJobId) ? calc(job.parentJobId, seen) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  jobs.forEach(job => calc(job.id, new Set()));
  const stubs = Array.from(
    new Set(
      jobs.map(job => job.parentJobId).filter((id): id is string => id !== undefined && !byId.has(id))
    )
  );

  const W = 230;
  const H = 62;
  const COL = 260;
  const ROW = 78;
  const AGENT_X = 10;
  const JOB_X = 280;
  const agents = Array.from(new Set(jobs.map(job => job.agentName)));
  const agentPos = new Map(agents.map((name, i) => [name, { x: AGENT_X, y: 10 + i * ROW }]));
  const levels = new Map<number, DelegationJob[]>();
  jobs.forEach(job => {
    const d = depth.get(job.id) ?? 0;
    const level = levels.get(d) ?? [];
    level.push(job);
    levels.set(d, level);
  });
  const stubLevel = levels.get(0) ?? [];
  stubs.forEach(id => {
    stubLevel.push({ id, state: '', agentName: '', summary: '' });
  });
  levels.set(0, stubLevel);
  const pos = new Map<string, { x: number; y: number }>();
  levels.forEach((level, d) => {
    level.forEach((job, i) => {
      pos.set(job.id, { x: JOB_X + d * COL, y: 10 + i * ROW });
    });
  });
  const maxDepth = Math.max(...levels.keys());
  const maxRows = Math.max(agents.length, ...[...levels.values()].map(level => level.length));
  const width = JOB_X + (maxDepth + 1) * COL + 10;
  const height = 10 + maxRows * ROW + 10;

  const edge = (x1: number, y1: number, x2: number, y2: number, dashed: boolean): string => {
    const mx = (x1 + x2) / 2;
    return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" ` +
      `stroke="#8fa0b3" stroke-width="2"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#delArrow)"/>`;
  };
  let wires = '';
  jobs.forEach(job => {
    const p = pos.get(job.id);
    if (p === undefined) return;
    if (job.parentJobId !== undefined) {
      const from = pos.get(job.parentJobId);
      if (from !== undefined) wires += edge(from.x + W, from.y + H / 2, p.x, p.y + H / 2, false);
    } else {
      const agent = agentPos.get(job.agentName);
      if (agent !== undefined) wires += edge(agent.x + W, agent.y + H / 2, p.x, p.y + H / 2, true);
    }
  });

  let nodes = '';
  agentPos.forEach((p, name) => {
    nodes += `<div class="del-node del-agent" style="left:${p.x}px;top:${p.y}px" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`;
  });
  levels.forEach(level => {
    level.forEach(job => {
      const p = pos.get(job.id);
      if (p === undefined) return;
      if (stubs.includes(job.id)) {
        nodes += `<div class="del-node del-stub" style="left:${p.x}px;top:${p.y}px" title="${escapeHtml(job.id)} (outside view)">${escapeHtml(shortId(job.id))}…</div>`;
        return;
      }
      nodes += `<div class="del-node" style="left:${p.x}px;top:${p.y}px" title="${escapeHtml(`${job.id} on ${job.agentName}: ${job.summary}`)}">` +
        `<div class="del-title">${escapeHtml(shortId(job.id))}</div>` +
        `<span class="pill ${pillClass(job.state)}">${escapeHtml(job.state)}</span> ` +
        `<span class="meta">${escapeHtml(job.agentName)}</span></div>`;
    });
  });

  return `<div class="del-canvas" style="width:${width}px;max-width:100%;height:${height}px">` +
    `<svg width="${width}" height="${height}"><defs><marker id="delArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8fa0b3"></path></marker></defs>${wires}</svg>${nodes}</div>` +
    `<details style="margin-top:10px"><summary class="meta">Mermaid source</summary>` +
    `<pre id="mermaidSrc">${escapeHtml(delegationMermaid(jobs))}</pre>` +
    `${flowButton('Copy Mermaid', 'copy-mermaid', {})}</details>`;
}

function jobActions(jobId: string, state: string): string {
  const id = encodeURIComponent(jobId);
  if (state === 'running' || state === 'blocked' || state === 'queued' || state === 'awaiting_input') {
    return (
      `${flowButton('Wait', 'job-wait', { id: jobId })} ` +
      `${flowButton('Steer', 'job-steer', { id: jobId })} ` +
      `${apiButton('Cancel', 'POST', `/api/jobs/${id}/cancel`, { body: {}, danger: true })}`
    );
  }
  if (state === 'failed' || state === 'cancelled' || state === 'timed_out') {
    return apiButton('Retry', 'POST', `/api/jobs/${id}/retry`, {});
  }
  return (
    `${flowButton('Events', 'job-events', { id: jobId })} ` +
    `${flowButton('Result', 'job-result', { id: jobId })}`
  );
}

function describeCaps(budget: { maxCostUsd?: number; maxTokens?: number; maxCalls?: number; maxConcurrent?: number }): string {
  const parts: string[] = [];
  if (budget.maxCostUsd !== undefined) parts.push(`$${budget.maxCostUsd}`);
  if (budget.maxTokens !== undefined) parts.push(`${budget.maxTokens} tokens`);
  if (budget.maxCalls !== undefined) parts.push(`${budget.maxCalls} calls`);
  if (budget.maxConcurrent !== undefined) parts.push(`${budget.maxConcurrent} concurrent`);
  return parts.length > 0 ? parts.join(' · ') : 'no caps';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CSS = `
  :root {
    --bg: #0f141b; --panel: #182028; --panel2: #1e2833; --border: #2c3a48;
    --text: #d7e0ea; --dim: #8fa0b3; --accent: #4da3ff;
    --ok: #3ecf6f; --err: #ff5d5d; --warn: #ffb224; --info: #4da3ff; --violet: #b07fff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", sans-serif; }
  button, input, select, textarea { font-family: inherit; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .ok { background: #123a22; color: var(--ok); }
  .admin { background: #2b1a3d; color: var(--violet); }
  .meta { color: var(--dim); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; flex-wrap: wrap; }
  nav button { background: none; border: 1px solid transparent; border-bottom: none; color: var(--dim);
    padding: 8px 14px; cursor: pointer; font-size: 14px; border-radius: 8px 8px 0 0; }
  nav button.active { background: var(--panel); color: var(--text); border-color: var(--border); }
  main { padding: 16px 20px 40px; }
  section.tab { display: none; }
  section.tab.active { display: block; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { background: var(--panel2); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  .st-queued { background: #2a3138; color: #aeb9c5; }
  .st-running { background: #12395c; color: var(--info); }
  .st-succeeded { background: #123a22; color: var(--ok); }
  .st-failed { background: #472020; color: var(--err); }
  .st-cancelled, .st-blocked { background: #3a2f14; color: var(--warn); }
  .st-awaiting, .st-pending { background: #3d2c12; color: var(--warn); }
  .st-paused { background: #2b1a3d; color: var(--violet); }
  .tag { display: inline-block; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; color: var(--dim); margin: 1px 2px 1px 0; }
  .tag.shared { border-color: var(--violet); color: var(--violet); }
  .tag.you { border-color: var(--info); color: var(--info); }
  .tag.verified { border-color: var(--ok); color: var(--ok); }
  .tag.unverified { border-color: var(--warn); color: var(--warn); }
  .tag.err { border-color: var(--err); color: var(--err); }
  .tag.approval { border-color: var(--warn); color: var(--warn); }
  .srv-toggle { background: none; border: none; color: var(--text); cursor: pointer; font-size: 13px; padding: 0; text-align: left; }
  .srv-toggle:hover { color: var(--accent); }
  .srv-toggle code { cursor: pointer; }
  .srv-caret { display: inline-block; width: 1em; color: var(--dim); }
  .srv-tools { display: grid; gap: 6px; padding: 6px 0 6px 22px; }
  .srv-tool { display: flex; gap: 8px; align-items: baseline; }
  .st-disabled { background: #2a3138; color: #8fa0b3; }
  .agent-off td { opacity: .5; }
  .agent-off td:last-child { opacity: 1; }
  .del-canvas { position: relative; border: 1px solid var(--border); border-radius: 8px; background: #101720; overflow: auto; }
  .del-canvas svg { position: absolute; inset: 0; }
  .del-node { position: absolute; width: 230px; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; overflow: hidden; }
  .del-node .del-title { font-weight: 700; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .del-node .meta { font-size: 11.5px; }
  .del-agent { border-style: dashed; border-color: var(--accent); }
  .del-stub { opacity: .6; border-style: dotted; }
  details summary { cursor: pointer; }
  #mermaidSrc { max-height: 240px; }
  .err-msg { display: inline-block; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; color: #ff9d9d; font-size: 12px; }
  .err-line { color: var(--err); font-size: 11px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.act { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12.5px; margin: 1px 2px; }
  button.act:hover { border-color: var(--accent); }
  button.act.danger:hover { border-color: var(--err); color: var(--err); }
  button.act.go { border-color: #1f6b3a; }
  button.act.go:hover { border-color: var(--ok); color: var(--ok); }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  input, select { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .dag { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 6px 0; }
  .step { min-width: 150px; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  .step .nm { font-weight: 700; }
  .arrow { align-self: center; color: var(--dim); padding: 0 8px; font-size: 18px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .feed { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .feed div { padding: 3px 0; border-bottom: 1px dotted #243040; }
  .feed .ts { color: var(--dim); }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--panel2);
    border: 1px solid var(--accent); border-radius: 8px; padding: 10px 18px; display: none; max-width: 90vw; z-index: 80; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 0; max-width: 94vw; width: 560px; box-shadow: 0 18px 60px rgba(0,0,0,.5); }
  dialog::backdrop { background: rgba(0,0,0,.6); backdrop-filter: blur(2px); }
  dialog .dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; border-bottom: 1px solid var(--border); }
  dialog .dlg-head b { font-size: 15px; }
  dialog .dlg-x { background: none; border: 1px solid var(--border); color: var(--dim); border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 13px; }
  dialog .dlg-x:hover { color: var(--text); border-color: var(--accent); }
  dialog .dlg-body { padding: 12px 18px; max-height: 66vh; overflow: auto; }
  dialog .dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; border-top: 1px solid var(--border); }
  dialog label.f { display: block; margin: 10px 0 4px; color: var(--dim); font-size: 12.5px; font-weight: 600; }
  dialog label.f .req { color: var(--err); }
  dialog input, dialog select, dialog textarea { width: 100%; max-width: 100%; }
  dialog textarea { min-height: 90px; resize: vertical; background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
  dialog .hint { color: var(--dim); font-size: 12px; margin-top: 4px; }
  dialog .err { display: none; background: #472020; border: 1px solid var(--err); color: #ffd7d7; border-radius: 6px; padding: 8px 10px; font-size: 12.5px; margin: 10px 0 0; white-space: pre-wrap; }
  dialog .err.show { display: block; }
  dialog pre { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;
    max-width: 100%; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  dialog.wide { width: 980px; }
  #authZone button { margin-left: 6px; }
  .trunc, .trunc-wrap { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  td .trunc-wrap { max-width: 360px; }
  #agentDlg, #runStartDlg, #shareDlg { width: 680px; }
  #workflowDlg { width: 1020px; }
  #agentInstructions { min-height: 220px; }
  .wf-step { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--panel2); }
  .wf-step input, .wf-step textarea, .wf-step select { width: 100%; margin: 4px 0; }
  .wf-step textarea { min-height: 80px; }
  .kv-row { display: flex; gap: 8px; margin: 4px 0; }
  .kv-row input { flex: 1; }
  #shareList div { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px dotted #243040; }
  .wf-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  .wf-mode { font-size: 12px; color: var(--dim); }
  .wf-mode.on { color: var(--warn); font-weight: 700; }
  .wf-layout { display: grid; grid-template-columns: 1fr 300px; gap: 12px; }
  .wf-canvas-wrap { position: relative; border: 1px solid var(--border); border-radius: 8px; background: #101720; overflow: auto; min-height: 380px; max-height: 52vh; }
  .wf-canvas { position: relative; width: 1600px; height: 900px; background-image: radial-gradient(circle, #243040 1px, transparent 1px); background-size: 24px 24px; }
  .wf-canvas svg.wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .wf-canvas svg.wires line, .wf-canvas svg.wires path { pointer-events: stroke; cursor: pointer; }
  .wf-node { position: absolute; width: 210px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 0; cursor: grab; user-select: none; touch-action: none; }
  .wf-node:active { cursor: grabbing; }
  .wf-node.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(77,163,255,.35); }
  .wf-node.connect-src { border-color: var(--warn); }
  .wf-node .hd { padding: 8px 10px; font-weight: 700; font-size: 13px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-node .bd { padding: 8px 10px; font-size: 12px; color: var(--dim); max-height: 64px; overflow: hidden; }
  .wf-node .ft { display: flex; gap: 6px; padding: 8px 10px; }
  .wf-node .port { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%; background: var(--panel); border: 2px solid var(--dim); transform: translateY(-50%); }
  .wf-node .port.in { left: -7px; }
  .wf-node .port.out { right: -7px; cursor: crosshair; }
  .wf-node .port.out:hover { border-color: var(--warn); }
  .wf-insp { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel2); max-height: 52vh; overflow: auto; }
  .wf-insp input, .wf-insp textarea, .wf-insp select { width: 100%; margin: 4px 0; }
  .dep-row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 2px 0; }
  @media (max-width: 900px) { .wf-layout { grid-template-columns: 1fr; } }
`;

const JS = `
  const TOKEN_KEY = 'orchestrator.dashboard.token';
  const TAB_KEY = 'orchestrator.dashboard.tab';
  const AUTH_REQUIRED = window.ORCH_AUTH_REQUIRED === true;
  function token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } }
  function setToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode: the page still works, just without persistence */ }
  }
  function renderAuth() {
    const zone = document.getElementById('authZone');
    if (!AUTH_REQUIRED) { zone.textContent = ''; return; }
    zone.innerHTML = '';
    if (token()) {
      const out = document.createElement('button');
      out.className = 'act';
      out.textContent = 'Sign out';
      out.onclick = () => { setToken(null); location.reload(); };
      zone.appendChild(out);
    } else {
      const btn = document.createElement('button');
      btn.className = 'act go';
      btn.textContent = 'Sign in';
      btn.onclick = () => signIn(false);
      zone.appendChild(btn);
    }
  }
  function signIn(forced) {
    const current = token();
    if (current && !forced) return current;
    // Don't nag: one declined dialog covers the next minute of 401s.
    try {
      if (!forced && Number(sessionStorage.getItem('orchestrator.dashboard.declined') || 0) > Date.now() - 60000) return null;
    } catch { /* ignore */ }
    document.getElementById('authToken').value = '';
    openDlg('authDlg', 'authToken');
    return null;
  }
  function doAuth() {
    const map = { authDlg: 'authErr' };
    const errEl = document.getElementById('authErr');
    const value = document.getElementById('authToken').value.trim();
    if (!value) {
      if (errEl) { errEl.textContent = 'Token is required.'; errEl.classList.add('show'); }
      return;
    }
    setToken(value);
    try { sessionStorage.removeItem('orchestrator.dashboard.declined'); } catch { /* ignore */ }
    closeDlg('authDlg');
    location.reload();
  }
  function apiHeaders() {
    const headers = { 'content-type': 'application/json' };
    const t = token();
    if (t) headers['authorization'] = 'Bearer ' + t;
    return headers;
  }
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api/' + path, {
        method,
        headers: apiHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('The server could not be reached: ' + (e && e.message ? e.message : e));
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON: fall through to status handling */ }
    if (res.status === 401 && AUTH_REQUIRED && !token()) {
      signIn(false);
      throw new Error('Signed out — sign in first, then retry.');
    }
    if (!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status));
    return data;
  }
  function gotoTab(name) {
    const btn = document.querySelector('button[data-tab="' + name + '"]');
    if (btn) btn.click();
  }
  function refreshSoon(msg) {
    toast(msg + ' Refreshing…');
    setTimeout(() => location.reload(), 900);
  }
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    try { sessionStorage.setItem(TAB_KEY, btn.dataset.tab); } catch { /* ignore */ }
  });
  function filterTable(id, q) {
    q = q.toLowerCase();
    document.querySelectorAll('#' + id + ' tr').forEach(tr => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
  function filterState(state) {
    document.querySelectorAll('#jobRows tr').forEach(tr => {
      tr.style.display = (!state || tr.dataset.state === state) ? '' : 'none';
    });
  }
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = 'none'), 4000);
  }
  function showView(title, text) {
    document.getElementById('viewTitle').textContent = title;
    document.getElementById('viewBody').textContent = text;
    openDlg('viewDlg', 'viewTitle');
  }
  function openDlg(id, focusId) {
    const dlg = document.getElementById(id);
    if (!dlg) return;
    hideErr(id);
    if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    if (focusId) {
      const f = document.getElementById(focusId);
      if (f && f.focus) setTimeout(function() { try { f.focus(); } catch (e) {} }, 30);
    } else {
      const first = dlg.querySelector('input:not([type=hidden]), textarea, select');
      if (first && first.focus) setTimeout(function() { try { first.focus(); } catch (e) {} }, 30);
    }
  }
  function closeDlg(id) {
    const dlg = document.getElementById(id);
    if (dlg && dlg.open) dlg.close();
  }
  function showErr(id, msg) {
    const map = { shareDlg: 'shareErr', agentDlg: 'agentErr', workflowDlg: 'wfErr', runStartDlg: 'runStartErr', delegateDlg: 'delegateErr', jobDlg: 'jobErr', steerDlg: 'steerErr', presetDlg: 'presetErr', scheduleDlg: 'schedErr', memoryDlg: 'memoryErr', budgetDlg: 'budgetErr', runControlDlg: 'runCtlErr' };
    const errId = map[id] || null;
    if (!errId) { if (msg) toast(msg); return; }
    const el = document.getElementById(errId);
    if (!el) { if (msg) toast(msg); return; }
    if (!msg) { el.classList.remove('show'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.add('show');
  }
  function hideErr(id) { showErr(id, null); }
  function setBusy(id, busy) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!busy;
  }
  let confirmResolve = null;
  function askConfirm(title, msg, goLabel) {
    document.getElementById('confirmTitle').textContent = title || 'Confirm';
    document.getElementById('confirmMsg').textContent = msg || 'Are you sure?';
    document.getElementById('confirmGo').textContent = goLabel || 'Confirm';
    openDlg('confirmDlg');
    return new Promise(function(resolve) {
      confirmResolve = resolve;
      document.getElementById('confirmGo').onclick = function() {
        closeDlg('confirmDlg');
        const r = confirmResolve;
        confirmResolve = null;
        if (r) r(true);
      };
    });
  }
  document.addEventListener('close', function(e) {
    if (e.target && e.target.id === 'confirmDlg' && confirmResolve) {
      const r = confirmResolve;
      confirmResolve = null;
      r(false);
    }
    if (e.target && e.target.id === 'authDlg') {
      try { sessionStorage.setItem('orchestrator.dashboard.declined', String(Date.now())); } catch (err) {}
    }
  }, true);
  document.addEventListener('click', function(e) {
    const dlg = e.target && e.target.tagName === 'DIALOG' ? e.target : null;
    if (dlg && e.clientX !== undefined) {
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside && !dlg.dataset.lock) dlg.close();
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target && (e.target.tagName === 'INPUT') && e.target.type !== 'textarea') {
      const dlg = e.target.closest('dialog');
      if (dlg) {
        const go = dlg.querySelector('.dlg-foot .go');
        if (go && !go.disabled) { e.preventDefault(); go.click(); }
      }
    }
  });
  // One-shot buttons: data-api="METHOD path", optional data-body (JSON) and
  // data-confirm (shown first via the styled confirm dialog). Mutations reload afterwards.
  async function act(el) {
    const [method, ...rest] = el.dataset.api.split(' ');
    const path = rest.join(' ');
    let body;
    try { body = el.dataset.body === undefined ? undefined : JSON.parse(el.dataset.body); }
    catch { toast('Bad button payload.'); return; }
    if (el.dataset.confirm !== undefined) {
      const ok = await askConfirm('Confirm', el.dataset.confirm, 'Confirm');
      if (!ok) return;
    }
    el.disabled = true;
    try {
      await api(method, path, body);
      refreshSoon('Done.');
    } catch (e) {
      toast('Failed: ' + e.message);
    } finally {
      el.disabled = false;
    }
  }
  // Multi-step flows: dialogs and prompts, then API calls.
  async function flow(el) {
    const d = el.dataset;
    try {
      switch (d.flow) {
        case 'delegate': {
          document.getElementById('delegateTitle').textContent = 'Delegate to ' + (d.name || d.agentId || 'agent');
          document.getElementById('delegateAgent').value = d.agentId || '';
          document.getElementById('delegateInstr').value = '';
          document.getElementById('delegateTemplate').value = 'coder';
          openDlg('delegateDlg', 'delegateInstr');
          break;
        }
        case 'delegate-any': {
          document.getElementById('delegateTitle').textContent = 'Delegate';
          document.getElementById('delegateAgent').value = '';
          document.getElementById('delegateInstr').value = '';
          document.getElementById('delegateTemplate').value = 'coder';
          openDlg('delegateDlg', 'delegateInstr');
          break;
        }
        case 'job-new': {
          document.getElementById('jobInstr').value = '';
          document.getElementById('jobTemplate').value = 'coder';
          openDlg('jobDlg', 'jobInstr');
          break;
        }
        case 'job-wait': {
          toast('Waiting up to 60s…');
          const deadline = Date.now() + 60000;
          for (;;) {
            const { job } = await api('GET', 'jobs/' + encodeURIComponent(d.id));
            if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.state) || Date.now() > deadline) {
              refreshSoon('Job is ' + job.state + '.');
              return;
            }
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        case 'job-steer': {
          document.getElementById('steerId').value = d.id;
          document.getElementById('steerMsg').value = '';
          openDlg('steerDlg', 'steerMsg');
          break;
        }
        case 'job-events': {
          const { events } = await api('GET', 'events?jobId=' + encodeURIComponent(d.id) + '&limit=100');
          showView('Events for ' + d.id, events.map(e => e.ts + ' ' + e.type).join('\\n') || '(no events)');
          break;
        }
        case 'job-result': {
          const { job } = await api('GET', 'jobs/' + encodeURIComponent(d.id));
          showView('Result of ' + d.id, job.resultText || JSON.stringify(job.resultStructured ?? null, null, 2));
          break;
        }
        case 'agent-new': {
          document.getElementById('agentDlgTitle').textContent = 'New agent';
          document.getElementById('agentId').value = '';
          document.getElementById('agentName').value = '';
          document.getElementById('agentRole').value = '';
          document.getElementById('agentInstructions').value = '';
          document.getElementById('agentRunner').value = '';
          document.getElementById('agentModel').value = '';
          openDlg('agentDlg', 'agentName');
          break;
        }
        case 'agent-edit': {
          const current = await api('GET', 'agents/' + encodeURIComponent(d.id));
          document.getElementById('agentDlgTitle').textContent = 'Edit agent';
          document.getElementById('agentId').value = d.id;
          document.getElementById('agentName').value = current.agent.name || '';
          document.getElementById('agentRole').value = current.agent.role || '';
          document.getElementById('agentInstructions').value = current.agent.instructions || '';
          document.getElementById('agentRunner').value = current.agent.runner || '';
          document.getElementById('agentModel').value = current.agent.model || '';
          openDlg('agentDlg', 'agentName');
          break;
        }
        case 'agent-delete': {
          {
            const ok = await askConfirm('Delete agent', 'Delete agent "' + d.name + '"? Job history is kept.', 'Delete');
            if (!ok) break;
          }
          try {
            await api('DELETE', 'agents/' + encodeURIComponent(d.id), { confirm: true });
          } catch (e) {
            if (/live job/.test(e.message)) {
              const force = await askConfirm('Agent has live jobs', e.message + ' Cancel them and delete anyway?', 'Delete anyway');
              if (!force) break;
              await api('DELETE', 'agents/' + encodeURIComponent(d.id), { confirm: true, force: true });
              refreshSoon('Agent deleted.');
              break;
            }
            throw e;
          }
          refreshSoon('Agent deleted.');
          break;
        }
        case 'agent-enable': {
          await api('PATCH', 'agents/' + encodeURIComponent(d.id), { patch: { enabled: true } });
          refreshSoon('Agent enabled.');
          break;
        }
        case 'agent-disable': {
          await api('PATCH', 'agents/' + encodeURIComponent(d.id), { patch: { enabled: false } });
          refreshSoon('Agent disabled. Running jobs keep going; new ones are refused.');
          break;
        }
        case 'agent-inspect': {
          const detail = await api('GET', 'agents/' + encodeURIComponent(d.id));
          showView(d.id, JSON.stringify(detail.agent, null, 2));
          break;
        }
        case 'preset-new': {
          document.getElementById('presetName').value = '';
          document.getElementById('presetGrants').value = '';
          openDlg('presetDlg', 'presetName');
          break;
        }
        case 'server-new': {
          document.getElementById('serverName').value = '';
          document.getElementById('serverTransport').value = 'stdio';
          document.getElementById('serverCommand').value = '';
          document.getElementById('serverArgs').value = '';
          document.getElementById('serverCwd').value = '';
          document.getElementById('serverUrl').value = '';
          document.getElementById('serverAuthRef').value = '';
          document.getElementById('serverAllow').value = '';
          document.getElementById('serverDeny').value = '';
          document.getElementById('serverApproval').value = '';
          serverTransportChanged();
          openDlg('serverDlg', 'serverName');
          break;
        }
        case 'share': {
          document.getElementById('shareTitle').textContent = 'Share ' + (d.label || d.id);
          document.getElementById('shareKind').value = d.kind;
          document.getElementById('shareId').value = d.id;
          document.getElementById('grantee').value = '';
          document.getElementById('granteeHint').textContent = '';
          document.getElementById('shareList').textContent = '(loading…)';
          openDlg('shareDlg', 'grantee');
          loadShares();
          break;
        }
        case 'workflow-edit': {
          const found = await api('GET', 'workflows/' + encodeURIComponent(d.id));
          openWorkflowDlg(found.workflow.name, found.workflow.spec.steps, d.id);
          break;
        }
        case 'run-control': {
          document.getElementById('runCtlId').value = d.run;
          document.getElementById('runAction').value = 'pause';
          document.getElementById('runStep').value = '';
          openDlg('runControlDlg', 'runAction');
          break;
        }
        case 'run-export': {
          const exported = await api('POST', 'runs/' + encodeURIComponent(d.run) + '/export', {});
          showView('Run export', exported.content);
          break;
        }
        case 'run-start': {
          document.getElementById('runStartId').value = d.id;
          document.getElementById('runStartName').textContent = 'Starting a run. Add inputs below (both optional).';
          document.getElementById('runInputs').innerHTML = '';
          addRunInput();
          openDlg('runStartDlg');
          break;
        }
        case 'workflow-define': {
          openWorkflowDlg('', [], '');
          break;
        }
        case 'schedule-new': {
          document.getElementById('schedName').value = '';
          document.getElementById('schedCron').value = '';
          document.getElementById('schedInstr').value = '';
          document.getElementById('schedTemplate').value = '';
          openDlg('scheduleDlg', 'schedName');
          break;
        }
        case 'schedule-preview': {
          const preview = await api('GET', 'schedules/preview?cron=' + encodeURIComponent(d.cron) + '&count=5');
          showView('Next runs for ' + d.id, preview.runs.join('\\n'));
          break;
        }
        case 'memory-read': {
          document.getElementById('memoryTitle').textContent = 'Read memory in "' + d.namespace + '"';
          document.getElementById('memoryNs').value = d.namespace;
          document.getElementById('memoryKey').value = '';
          openDlg('memoryDlg', 'memoryKey');
          break;
        }
        case 'artifact-read': {
          const { content, eof } = await api('GET', 'artifacts/' + encodeURIComponent(d.id) + '?length=8000');
          showView(d.name || d.id, content + (eof ? '' : '\\n…[truncated at 8000 chars]'));
          break;
        }
        case 'budget-set': {
          document.getElementById('budgetScope').value = 'global';
          document.getElementById('budgetId').value = '';
          document.getElementById('budgetCost').value = '';
          openDlg('budgetDlg', 'budgetScope');
          break;
        }
        case 'usage-report': {
          const report = await api('GET', 'usage?groupBy=agent');
          const lines = report.groups.map(g => g.key + ': ' + g.jobs + ' jobs, $' + g.costUsd.toFixed(4));
          showView('Usage by agent', lines.join('\\n') || '(no jobs)');
          break;
        }
        case 'prune': {
          const dry = await api('POST', 'prune', { confirm: true, dryRun: true });
          const p = dry.pruned;
          const summary = (p.jobs || 0) + ' jobs, ' + (p.runs || 0) + ' runs, ' + (p.events || 0) + ' events';
          {
            const ok = await askConfirm('Prune history', 'Prune history older than ' + dry.cutoff + '? ' + summary, 'Prune');
            if (!ok) break;
          }
          await api('POST', 'prune', { confirm: true, dryRun: false, olderThanDays: 30 });
          refreshSoon('Pruned.');
          break;
        }
        case 'copy-mermaid': {
          const src = document.getElementById('mermaidSrc').textContent;
          try {
            await navigator.clipboard.writeText(src);
            toast('Mermaid copied.');
          } catch (e) {
            const range = document.createRange();
            range.selectNode(document.getElementById('mermaidSrc'));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try {
              document.execCommand('copy');
              toast('Mermaid copied.');
            } catch (e2) {
              toast('Copy failed: ' + e2.message);
            }
          }
          break;
        }
        default:
          toast('Unknown action.');
      }
    } catch (e) {
      toast('Failed: ' + e.message);
    }
  }
  // Tools tab: each server row expands inline to its tool list, fetched once
  // and cached. Approval gates ride the row's data-approval JSON, so no
  // second fetch is needed to tag them.
  const srvCache = {};
  async function toggleServer(btn) {
    const row = btn.closest('tr');
    const idx = row.dataset.idx;
    const name = row.dataset.server;
    const detail = document.getElementById('srv-detail-' + idx);
    const box = document.getElementById('srv-tools-' + idx);
    const caret = btn.querySelector('.srv-caret');
    if (!detail.hidden) {
      detail.hidden = true;
      if (caret) caret.textContent = '▸';
      return;
    }
    if (caret) caret.textContent = '▾';
    detail.hidden = false;
    if (srvCache[name] !== undefined) {
      paintServerTools(row, box, idx, srvCache[name]);
      return;
    }
    box.textContent = 'Loading…';
    try {
      const data = await api('GET', 'toolservers/' + encodeURIComponent(name) + '/tools');
      srvCache[name] = data.tools || [];
      paintServerTools(row, box, idx, srvCache[name]);
    } catch (e) {
      box.textContent = 'Could not load tools: ' + e.message;
    }
  }
  function paintServerTools(row, box, idx, tools) {
    let gated = [];
    try {
      gated = JSON.parse(row.dataset.approval || '[]');
    } catch (e) { /* a malformed attribute hides tags, never tools */ }
    box.innerHTML = '';
    const count = document.getElementById('srv-count-' + idx);
    if (count) count.textContent = tools.length + ' tool(s)';
    if (tools.length === 0) {
      box.textContent = '(no tools)';
      return;
    }
    tools.forEach(function(tool) {
      const line = document.createElement('div');
      line.className = 'srv-tool';
      const code = document.createElement('code');
      code.textContent = tool.name;
      code.title = tool.name;
      line.appendChild(code);
      if (gated.indexOf(tool.name) !== -1) {
        const tag = document.createElement('span');
        tag.className = 'tag approval';
        tag.textContent = 'needs approval';
        tag.title = 'Calls to this tool pause for a human first';
        line.appendChild(tag);
      }
      const desc = document.createElement('span');
      desc.className = 'meta trunc-wrap';
      desc.textContent = tool.description || '(no description)';
      desc.title = tool.description || '';
      line.appendChild(desc);
      box.appendChild(line);
    });
  }
  function shareBase(kind) {
    return kind === 'agent' ? 'agents/' : kind === 'workflow' ? 'workflows/' : 'memory/';
  }
  async function loadShares() {
    const kind = document.getElementById('shareKind').value;
    const id = document.getElementById('shareId').value;
    const box = document.getElementById('shareList');
    if (!kind || !id) { box.textContent = '(nothing selected)'; return; }
    try {
      const base = shareBase(kind);
      const path = kind === 'memory'
        ? 'memory/' + encodeURIComponent(id) + '/shares'
        : base + encodeURIComponent(id) + '/shares';
      const data = await api('GET', path);
      const grantees = data.shares || data.grantees || data.granteeIds || [];
      box.innerHTML = '';
      if (grantees.length === 0) { box.textContent = 'Not shared with anyone yet.'; return; }
      grantees.forEach(function(g) {
        const name = typeof g === 'string' ? g : (g.granteeId || g.ownerId || JSON.stringify(g));
        const status = typeof g === 'string' ? '' : (g.status ? ' (' + g.status + ')' : '');
        const row = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = name + status;
        label.title = name + status;
        const btn = document.createElement('button');
        btn.className = 'act danger';
        btn.textContent = 'Remove';
        btn.onclick = function() { unshare(name); };
        row.appendChild(label);
        row.appendChild(btn);
        box.appendChild(row);
      });
    } catch (e) {
      box.textContent = 'Could not load shares: ' + e.message;
    }
  }
  async function unshare(granteeId) {
    const kind = document.getElementById('shareKind').value;
    const id = document.getElementById('shareId').value;
    const ok = await askConfirm('Remove share', 'Remove the share with "' + granteeId + '"? They lose access immediately.', 'Remove');
    if (!ok) return;
    try {
      const base = shareBase(kind);
      const path = kind === 'memory'
        ? 'memory/' + encodeURIComponent(id) + '/share/' + encodeURIComponent(granteeId)
        : base + encodeURIComponent(id) + '/share/' + encodeURIComponent(granteeId);
      await api('DELETE', path);
      toast('Share removed.');
      loadShares();
    } catch (e) {
      toast('Failed: ' + e.message);
    }
  }
  async function doShare() {
    hideErr('shareDlg');
    const kind = document.getElementById('shareKind').value;
    const id = document.getElementById('shareId').value;
    const grantee = document.getElementById('grantee').value.trim();
    if (!grantee) { showErr('shareDlg', 'Enter their owner id first.'); return; }
    setBusy('shareGo', true);
    try {
      try {
        const check = await api('GET', 'users/' + encodeURIComponent(grantee) + '/exists');
        if (!check.exists) {
          document.getElementById('granteeHint').textContent = 'Unknown user "' + grantee + '" — they have no rows yet. They must sign in at least once, then accept the share. Share anyway? Press Share again to confirm.';
          if (document.getElementById('shareDlg').dataset.confirmFor !== grantee) {
            document.getElementById('shareDlg').dataset.confirmFor = grantee;
            return;
          }
        }
      } catch (e) { /* existence check is best-effort; the share call still validates */ }
      delete document.getElementById('shareDlg').dataset.confirmFor;
      const base = shareBase(kind);
      await api('POST', base + encodeURIComponent(id) + '/share', { granteeId: grantee });
      document.getElementById('grantee').value = '';
      document.getElementById('granteeHint').textContent = '';
      toast('Shared — pending until they accept.');
      loadShares();
    } catch (e) {
      showErr('shareDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('shareGo', false);
    }
  }
  async function doSaveAgent() {
    hideErr('agentDlg');
    const id = document.getElementById('agentId').value;
    const name = document.getElementById('agentName').value.trim();
    const role = document.getElementById('agentRole').value.trim();
    const instructions = document.getElementById('agentInstructions').value.trim();
    const runner = document.getElementById('agentRunner').value || undefined;
    const model = document.getElementById('agentModel').value.trim() || undefined;
    if (!name) { showErr('agentDlg', 'Name is required.'); return; }
    if (name.length > 80) { showErr('agentDlg', 'Name is too long (max 80 characters).'); return; }
    if (!instructions) { showErr('agentDlg', 'Description / system prompt is required.'); return; }
    setBusy('agentGo', true);
    try {
      if (!id) {
        await api('POST', 'agents', { name, instructions, ...(role && { role }), ...(runner && { runner }), ...(model && { model }) });
        closeDlg('agentDlg');
        refreshSoon('Agent created.');
      } else {
        await api('PATCH', 'agents/' + encodeURIComponent(id), { patch: { instructions, ...(role && { role }), ...(runner && { runner }), ...(model && { model }) } });
        closeDlg('agentDlg');
        refreshSoon('Agent updated.');
      }
    } catch (e) {
      showErr('agentDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('agentGo', false);
    }
  }
  async function doDelegate() {
    hideErr('delegateDlg');
    const agentId = document.getElementById('delegateAgent').value;
    const instruction = document.getElementById('delegateInstr').value.trim();
    const template = document.getElementById('delegateTemplate').value.trim() || undefined;
    if (!instruction) { showErr('delegateDlg', 'Instruction is required.'); return; }
    setBusy('delegateGo', true);
    try {
      const job = await api('POST', 'delegate', { ...(agentId && { agentId }), instruction, ...(template && { template }) });
      closeDlg('delegateDlg');
      try { sessionStorage.setItem(TAB_KEY, 'jobs'); } catch (e) {}
      refreshSoon('Delegated as ' + job.job.jobId + '.');
    } catch (e) {
      showErr('delegateDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('delegateGo', false);
    }
  }
  async function doQueueJob() {
    hideErr('jobDlg');
    const instruction = document.getElementById('jobInstr').value.trim();
    const template = document.getElementById('jobTemplate').value.trim() || undefined;
    if (!instruction) { showErr('jobDlg', 'Instruction is required.'); return; }
    setBusy('jobGo', true);
    try {
      const job = await api('POST', 'jobs', { instruction, ...(template && { template }) });
      closeDlg('jobDlg');
      try { sessionStorage.setItem(TAB_KEY, 'jobs'); } catch (e) {}
      refreshSoon('Queued as ' + job.job.jobId + '.');
    } catch (e) {
      showErr('jobDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('jobGo', false);
    }
  }
  async function doSteer() {
    hideErr('steerDlg');
    const id = document.getElementById('steerId').value;
    const message = document.getElementById('steerMsg').value.trim();
    if (!message) { showErr('steerDlg', 'Guidance text is required.'); return; }
    setBusy('steerGo', true);
    try {
      await api('POST', 'jobs/' + encodeURIComponent(id) + '/steer', { message });
      closeDlg('steerDlg');
      refreshSoon('Steered.');
    } catch (e) {
      showErr('steerDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('steerGo', false);
    }
  }
  async function doPreset() {
    hideErr('presetDlg');
    const name = document.getElementById('presetName').value.trim();
    const raw = document.getElementById('presetGrants').value.trim();
    if (!name) { showErr('presetDlg', 'Preset name is required.'); return; }
    const grants = raw.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (!grants.length) { showErr('presetDlg', 'Add at least one grant (server or server/tool).'); return; }
    setBusy('presetGo', true);
    try {
      await api('POST', 'presets', { name, grants });
      closeDlg('presetDlg');
      refreshSoon('Preset saved.');
    } catch (e) {
      showErr('presetDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('presetGo', false);
    }
  }
  function serverTransportChanged() {
    const http = document.getElementById('serverTransport').value === 'http';
    document.getElementById('serverStdio').style.display = http ? 'none' : '';
    document.getElementById('serverHttp').style.display = http ? '' : 'none';
  }
  async function doServerSave() {
    hideErr('serverDlg');
    const csv = function(id) {
      return document.getElementById(id).value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    };
    const name = document.getElementById('serverName').value.trim();
    if (!name) { showErr('serverDlg', 'Server name is required.'); return; }
    let transport;
    if (document.getElementById('serverTransport').value === 'http') {
      const url = document.getElementById('serverUrl').value.trim();
      if (!url) { showErr('serverDlg', 'URL is required for an http server.'); return; }
      transport = { type: 'http', url };
    } else {
      const command = document.getElementById('serverCommand').value.trim();
      if (!command) { showErr('serverDlg', 'Command is required for a stdio server.'); return; }
      transport = { type: 'stdio', command };
      const args = csv('serverArgs');
      if (args.length) transport.args = args;
      const cwd = document.getElementById('serverCwd').value.trim();
      if (cwd) transport.cwd = cwd;
    }
    const body = { name, transport };
    const authRef = document.getElementById('serverAuthRef').value.trim();
    if (authRef) body.authRef = authRef;
    const allowTools = csv('serverAllow');
    if (allowTools.length) body.allowTools = allowTools;
    const denyTools = csv('serverDeny');
    if (denyTools.length) body.denyTools = denyTools;
    const requireApprovalFor = csv('serverApproval');
    if (requireApprovalFor.length) body.requireApprovalFor = requireApprovalFor;
    setBusy('serverGo', true);
    try {
      await api('POST', 'toolservers', body);
      closeDlg('serverDlg');
      refreshSoon('Server saved.');
    } catch (e) {
      showErr('serverDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('serverGo', false);
    }
  }
  async function doSchedule() {
    hideErr('scheduleDlg');
    const name = document.getElementById('schedName').value.trim();
    const cron = document.getElementById('schedCron').value.trim();
    const instruction = document.getElementById('schedInstr').value.trim();
    const template = document.getElementById('schedTemplate').value.trim() || undefined;
    if (!name) { showErr('scheduleDlg', 'Schedule name is required.'); return; }
    if (!cron || cron.split(/\\s+/).filter(Boolean).length !== 5) { showErr('scheduleDlg', 'Cron needs five fields, e.g. "0 9 * * mon-fri".'); return; }
    if (!instruction) { showErr('scheduleDlg', 'Instruction is required.'); return; }
    setBusy('schedGo', true);
    try {
      await api('POST', 'schedules', { name, cron, instruction, ...(template && { template }) });
      closeDlg('scheduleDlg');
      refreshSoon('Schedule created.');
    } catch (e) {
      showErr('scheduleDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('schedGo', false);
    }
  }
  async function doMemoryRead() {
    hideErr('memoryDlg');
    const ns = document.getElementById('memoryNs').value;
    const key = document.getElementById('memoryKey').value.trim();
    if (!key) { showErr('memoryDlg', 'Key is required.'); return; }
    setBusy('memoryGo', true);
    try {
      const found = await api('GET', 'memory/' + encodeURIComponent(ns) + '/' + encodeURIComponent(key));
      closeDlg('memoryDlg');
      showView(ns + ' / ' + key, found.found ? JSON.stringify(found.entry.value, null, 2) : '(not found)');
    } catch (e) {
      showErr('memoryDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('memoryGo', false);
    }
  }
  async function doBudget() {
    hideErr('budgetDlg');
    const scope = document.getElementById('budgetScope').value;
    const id = document.getElementById('budgetId').value.trim() || undefined;
    const rawCost = document.getElementById('budgetCost').value.trim();
    if (scope !== 'global' && !id) { showErr('budgetDlg', 'Scope id is required for agent/job caps.'); return; }
    let maxCostUsd;
    if (rawCost) {
      maxCostUsd = Number(rawCost);
      if (!isFinite(maxCostUsd) || maxCostUsd <= 0) { showErr('budgetDlg', 'Max cost must be a positive number.'); return; }
    }
    setBusy('budgetGo', true);
    try {
      await api('POST', 'budgets', { scope, ...(id && { id }), ...(maxCostUsd !== undefined && { maxCostUsd }) });
      closeDlg('budgetDlg');
      refreshSoon('Cap set.');
    } catch (e) {
      showErr('budgetDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('budgetGo', false);
    }
  }
  async function doRunControl() {
    hideErr('runControlDlg');
    const run = document.getElementById('runCtlId').value;
    const action = document.getElementById('runAction').value;
    const stepId = document.getElementById('runStep').value.trim() || undefined;
    if (action === 'retry_step' && !stepId) { showErr('runControlDlg', 'Step id is required for retry_step.'); return; }
    if (action === 'cancel') {
      const ok = await askConfirm('Cancel run', 'Cancel this run? In-flight work is discarded.', 'Cancel run');
      if (!ok) return;
    }
    setBusy('runCtlGo', true);
    try {
      await api('POST', 'runs/' + encodeURIComponent(run) + '/control', {
        action, ...(stepId && { stepId }), ...(action === 'cancel' && { confirm: true })
      });
      closeDlg('runControlDlg');
      refreshSoon('Run ' + action + '.');
    } catch (e) {
      showErr('runControlDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('runCtlGo', false);
    }
  }
  var wfModel = [];
  var wfSelected = null;
  var wfConnect = false;
  var wfConnectSrc = null;
  var wfUid = 1;
  var wfBound = false;
  var wfDrag = null;
  function wfNormStep(s) {
    const kind = (s && s.template) ? 'template' : (s && s.agentId) ? 'agentId' : (s && s.skillQuery) ? 'skillQuery' : 'template';
    const val = (s && (s.template || s.agentId || s.skillQuery)) || 'coder';
    return {
      id: (s && s.id) || ('step-' + (wfUid++)),
      instruction: (s && s.instruction) || '',
      targetKind: kind,
      targetValue: val,
      dependsOn: (s && s.dependsOn) ? [].concat(s.dependsOn) : [],
      approval: !!(s && s.approval),
      x: 30, y: 30
    };
  }
  function wfToSpecStep(n) {
    const step = { id: n.id, instruction: n.instruction };
    if (n.targetValue) step[n.targetKind] = n.targetValue;
    if (n.dependsOn && n.dependsOn.length) step.dependsOn = [].concat(n.dependsOn);
    if (n.approval) step.approval = true;
    return step;
  }
  function wfById(id) {
    for (let i = 0; i < wfModel.length; i++) { if (wfModel[i].id === id) return wfModel[i]; }
    return null;
  }
  function wfHasCycle() {
    const visiting = {};
    const done = {};
    const byId = {};
    wfModel.forEach(function(n) { byId[n.id] = n; });
    function visit(id, path) {
      if (done[id]) return null;
      if (visiting[id]) return path.concat([id]);
      visiting[id] = true;
      const n = byId[id];
      const deps = (n && n.dependsOn) || [];
      for (let i = 0; i < deps.length; i++) {
        const c = visit(deps[i], path.concat([id]));
        if (c) return c;
      }
      visiting[id] = false;
      done[id] = true;
      return null;
    }
    for (let i = 0; i < wfModel.length; i++) {
      const c = visit(wfModel[i].id, []);
      if (c) return c;
    }
    return null;
  }
  function wfNodeCenter(id, side) {
    const n = wfById(id);
    if (!n) return null;
    const w = 210;
    const h = 96;
    if (side === 'out') return { x: n.x + w, y: n.y + h / 2 };
    return { x: n.x, y: n.y + h / 2 };
  }
  function wfClearNodes() {
    const canvas = document.getElementById('wfCanvas');
    if (!canvas) return;
    Array.prototype.slice.call(canvas.querySelectorAll('.wf-node')).forEach(function(el) { el.remove(); });
  }
  function wfDrawWires() {
    const svg = document.getElementById('wfWires');
    if (!svg) return;
    Array.prototype.slice.call(svg.querySelectorAll('path')).forEach(function(el) { el.remove(); });
    wfModel.forEach(function(n) {
      (n.dependsOn || []).forEach(function(dep) {
        const a = wfNodeCenter(dep, 'out');
        const b = wfNodeCenter(n.id, 'in');
        if (!a || !b) return;
        const mx = (a.x + b.x) / 2;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + mx + ' ' + a.y + ', ' + mx + ' ' + b.y + ', ' + b.x + ' ' + b.y);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#8fa0b3');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('marker-end', 'url(#wfArrow)');
        line.style.pointerEvents = 'stroke';
        line.style.cursor = 'pointer';
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = dep + ' -> ' + n.id + ' (click to remove)';
        line.appendChild(title);
        line.addEventListener('click', function(ev) {
          ev.stopPropagation();
          wfRemoveDep(n.id, dep);
        });
        svg.appendChild(line);
      });
    });
  }
  function wfRemoveDep(nodeId, depId) {
    const n = wfById(nodeId);
    if (!n) return;
    n.dependsOn = (n.dependsOn || []).filter(function(x) { return x !== depId; });
    wfSyncInspectorDeps();
    wfRender();
  }
  function wfRender() {
    const canvas = document.getElementById('wfCanvas');
    if (!canvas) return;
    wfClearNodes();
    wfModel.forEach(function(n) {
      const el = document.createElement('div');
      el.className = 'wf-node' + (n.id === wfSelected ? ' selected' : '') + (wfConnectSrc === n.id ? ' connect-src' : '');
      el.dataset.node = n.id;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      const hd = document.createElement('div');
      hd.className = 'hd';
      hd.textContent = n.id || '(no id)';
      hd.title = n.id || '';
      const bd = document.createElement('div');
      bd.className = 'bd';
      const short = (n.instruction || '').slice(0, 80) || '(no instruction)';
      bd.textContent = n.targetKind + ':' + n.targetValue + ' — ' + short;
      bd.title = n.instruction || '';
      const pin = document.createElement('div');
      pin.className = 'port in';
      pin.title = 'input';
      const pout = document.createElement('div');
      pout.className = 'port out';
      pout.title = 'drag or click to connect';
      pout.addEventListener('pointerdown', function(ev) {
        ev.stopPropagation();
        wfPortConnect(n.id);
      });
      el.appendChild(hd);
      el.appendChild(bd);
      el.appendChild(pin);
      el.appendChild(pout);
      el.addEventListener('pointerdown', function(ev) { wfNodeDown(ev, n.id); });
      el.addEventListener('click', function(ev) { wfNodeClick(ev, n.id); });
      canvas.appendChild(el);
    });
    wfDrawWires();
    wfPaintConnect();
  }
  function wfPaintConnect() {
    const btn = document.getElementById('wfConnectBtn');
    const mode = document.getElementById('wfMode');
    if (btn) btn.textContent = 'Connect: ' + (wfConnect ? 'on' : 'off');
    if (mode) {
      if (wfConnect && wfConnectSrc) { mode.textContent = 'connect: source ' + wfConnectSrc + ' — click a target'; mode.className = 'wf-mode on'; }
      else if (wfConnect) { mode.textContent = 'connect mode: click source, then target (Esc to exit)'; mode.className = 'wf-mode on'; }
      else { mode.textContent = wfSelected ? ('selected: ' + wfSelected) : 'click a node to edit'; mode.className = 'wf-mode'; }
    }
  }
  function wfNodeDown(ev, id) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const n = wfById(id);
    if (!n) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origX = n.x;
    const origY = n.y;
    let moved = false;
    wfDrag = { id, startX, startY, origX, origY, moved: false };
    const move = function(e2) {
      if (!wfDrag || wfDrag.id !== id) return;
      const dx = e2.clientX - wfDrag.startX;
      const dy = e2.clientY - wfDrag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) wfDrag.moved = true;
      n.x = Math.max(0, Math.min(1600 - 220, wfDrag.origX + dx));
      n.y = Math.max(0, Math.min(900 - 110, wfDrag.origY + dy));
      const el = document.querySelector('.wf-node[data-node="' + CSS.escape(id) + '"]');
      if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
      wfDrawWires();
    };
    const up = function() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      wfDrag = null;
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
  function wfNodeClick(ev, id) {
    if (wfDrag && wfDrag.moved) return;
    if (wfConnect) {
      ev.stopPropagation();
      if (!wfConnectSrc) {
        wfConnectSrc = id;
        wfSelect(id);
      } else if (wfConnectSrc === id) {
        wfConnectSrc = null;
        wfRender();
      } else {
        const target = wfById(id);
        if (target && (target.dependsOn || []).indexOf(wfConnectSrc) === -1) {
          if (id === wfConnectSrc) { toast('A step cannot depend on itself.'); return; }
          target.dependsOn = (target.dependsOn || []).concat([wfConnectSrc]);
          const cyc = wfHasCycle();
          if (cyc) {
            target.dependsOn = target.dependsOn.filter(function(x) { return x !== wfConnectSrc; });
            showErr('workflowDlg', 'That edge would create a cycle: ' + cyc.join(' → '));
          } else {
            hideErr('workflowDlg');
            wfSelect(id);
          }
        } else {
          wfSelect(id);
        }
        wfConnectSrc = null;
        wfRender();
      }
      return;
    }
    wfSelect(id);
  }
  function wfPortConnect(id) {
    if (!wfConnect) {
      wfConnect = true;
      wfConnectSrc = id;
      wfSelect(id);
      return;
    }
    if (!wfConnectSrc) { wfConnectSrc = id; wfSelect(id); }
    else if (wfConnectSrc !== id) {
      const target = wfById(id);
      if (target && (target.dependsOn || []).indexOf(wfConnectSrc) === -1) {
        target.dependsOn = (target.dependsOn || []).concat([wfConnectSrc]);
        const cyc = wfHasCycle();
        if (cyc) {
          target.dependsOn = target.dependsOn.filter(function(x) { return x !== wfConnectSrc; });
          showErr('workflowDlg', 'That edge would create a cycle: ' + cyc.join(' → '));
        } else hideErr('workflowDlg');
      }
      wfConnectSrc = null;
      wfSelect(id);
    }
  }
  function wfSelect(id) {
    wfSelected = id;
    const n = wfById(id);
    document.getElementById('wfSelName').textContent = n ? ('editing: ' + n.id) : 'no selection';
    if (n) {
      document.getElementById('wfIdEdit').value = n.id;
      document.getElementById('wfInstrEdit').value = n.instruction || '';
      document.getElementById('wfKindEdit').value = n.targetKind || 'template';
      document.getElementById('wfTargetEdit').value = n.targetValue || '';
      document.getElementById('wfApprEdit').checked = !!n.approval;
    }
    wfSyncInspectorDeps();
    wfRender();
  }
  function wfSyncInspectorDeps() {
    const box = document.getElementById('wfDeps');
    if (!box) return;
    box.innerHTML = '';
    const n = wfById(wfSelected);
    if (!n) { box.textContent = '(select a step)'; return; }
    wfModel.forEach(function(m) {
      if (m.id === n.id) return;
      const row = document.createElement('label');
      row.className = 'dep-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.width = 'auto';
      cb.checked = (n.dependsOn || []).indexOf(m.id) !== -1;
      cb.onchange = function() {
        if (cb.checked) {
          if ((n.dependsOn || []).indexOf(m.id) === -1) n.dependsOn = (n.dependsOn || []).concat([m.id]);
          const cyc = wfHasCycle();
          if (cyc) {
            n.dependsOn = n.dependsOn.filter(function(x) { return x !== m.id; });
            cb.checked = false;
            showErr('workflowDlg', 'That edge would create a cycle: ' + cyc.join(' → '));
            return;
          }
          hideErr('workflowDlg');
        } else {
          n.dependsOn = (n.dependsOn || []).filter(function(x) { return x !== m.id; });
        }
        wfRender();
      };
      const sp = document.createElement('span');
      sp.textContent = m.id;
      sp.title = m.id;
      row.appendChild(cb);
      row.appendChild(sp);
      box.appendChild(row);
    });
    if (!box.children.length) box.textContent = '(no other steps)';
  }
  function wfBindInspector() {
    if (wfBound) return;
    wfBound = true;
    document.getElementById('wfIdEdit').addEventListener('input', function(e) {
      const n = wfById(wfSelected);
      if (!n) return;
      const old = n.id;
      const next = e.target.value.trim();
      if (!next || next === old) { n._pendingId = next; return; }
      if (wfById(next)) { showErr('workflowDlg', 'Step id "' + next + '" is already used.'); return; }
      hideErr('workflowDlg');
      n.id = next;
      wfModel.forEach(function(m) {
        m.dependsOn = (m.dependsOn || []).map(function(d) { return d === old ? next : d; });
      });
      if (wfConnectSrc === old) wfConnectSrc = next;
      wfSelected = next;
      document.getElementById('wfSelName').textContent = 'editing: ' + next;
      wfSyncInspectorDeps();
      wfRender();
    });
    document.getElementById('wfInstrEdit').addEventListener('input', function(e) {
      const n = wfById(wfSelected);
      if (n) n.instruction = e.target.value;
      wfRender();
    });
    document.getElementById('wfKindEdit').addEventListener('change', function(e) {
      const n = wfById(wfSelected);
      if (n) { n.targetKind = e.target.value; wfRender(); }
    });
    document.getElementById('wfTargetEdit').addEventListener('input', function(e) {
      const n = wfById(wfSelected);
      if (n) { n.targetValue = e.target.value; wfRender(); }
    });
    document.getElementById('wfApprEdit').addEventListener('change', function(e) {
      const n = wfById(wfSelected);
      if (n) n.approval = !!e.target.checked;
    });
    document.getElementById('wfCanvas').addEventListener('pointerdown', function(e) {
      if (e.target && e.target.id === 'wfCanvas') { wfSelected = null; wfConnectSrc = null; wfSyncInspectorDeps(); wfRender(); }
    });
    document.addEventListener('keydown', function(e) {
      const dlg = document.getElementById('workflowDlg');
      if (!dlg || !dlg.open) return;
      if (e.key === 'Escape' && wfConnect) { wfConnect = false; wfConnectSrc = null; wfRender(); }
    });
  }
  function wfAddStep() {
    let base = 'step-' + (wfModel.length + 1);
    let n = 1;
    while (wfById(base)) { n++; base = 'step-' + n; }
    const node = { id: base, instruction: '', targetKind: 'template', targetValue: 'coder', dependsOn: [], approval: false, x: 30 + ((wfModel.length * 60) % 900), y: 30 + ((wfModel.length * 50) % 600) };
    wfModel.push(node);
    wfSelect(node.id);
  }
  function addWfStep(step) { // kept for tests/compat; routes into the canvas model
    const node = wfNormStep(step);
    while (wfById(node.id)) node.id = node.id + '-' + (wfUid++);
    node.x = 30 + ((wfModel.length * 60) % 900);
    node.y = 30 + ((wfModel.length * 50) % 600);
    wfModel.push(node);
    wfSelect(node.id);
  }
  function wfToggleConnect() {
    wfConnect = !wfConnect;
    wfConnectSrc = null;
    wfRender();
  }
  function wfDeleteSelected() {
    if (!wfSelected) { toast('Select a step first.'); return; }
    const id = wfSelected;
    wfModel = wfModel.filter(function(n) { return n.id !== id; });
    wfModel.forEach(function(n) { n.dependsOn = (n.dependsOn || []).filter(function(d) { return d !== id; }); });
    wfSelected = null;
    wfConnectSrc = null;
    wfSyncInspectorDeps();
    wfRender();
  }
  function wfAutoLayout() {
    const depth = {};
    const byId = {};
    wfModel.forEach(function(n) { byId[n.id] = n; });
    function calc(n, seen) {
      if (depth[n.id] !== undefined) return depth[n.id];
      seen = seen || {};
      if (seen[n.id]) return 0;
      seen[n.id] = true;
      let d = 0;
      (n.dependsOn || []).forEach(function(dep) {
        const p = byId[dep];
        if (p) d = Math.max(d, calc(p, seen) + 1);
      });
      depth[n.id] = d;
      return d;
    }
    wfModel.forEach(function(n) { calc(n, {}); });
    const levels = {};
    wfModel.forEach(function(n) {
      const d = depth[n.id] || 0;
      levels[d] = levels[d] || [];
      levels[d].push(n);
    });
    Object.keys(levels).forEach(function(k) {
      levels[k].forEach(function(n, i) {
        n.x = 30 + (Number(k) * 260);
        n.y = 30 + (i * 140);
      });
    });
    wfRender();
  }
  function openWorkflowDlg(name, steps, id) {
    wfBindInspector();
    document.getElementById('workflowDlgTitle').textContent = id ? 'Edit workflow' : 'New workflow';
    document.getElementById('wfName').value = name || '';
    document.getElementById('wfId').value = id || '';
    hideErr('workflowDlg');
    const stepErr = document.getElementById('wfStepErr');
    if (stepErr) { stepErr.classList.remove('show'); stepErr.textContent = ''; }
    wfModel = [];
    wfSelected = null;
    wfConnect = false;
    wfConnectSrc = null;
    (steps && steps.length ? steps : [{ id: 'step-1', instruction: '', template: 'coder' }]).forEach(function(s) {
      const node = wfNormStep(s);
      wfModel.push(node);
    });
    wfAutoLayout();
    if (wfModel.length) wfSelect(wfModel[0].id);
    else { wfSyncInspectorDeps(); wfRender(); }
    openDlg('workflowDlg', 'wfName');
  }
  async function doSaveWorkflow() {
    hideErr('workflowDlg');
    const name = document.getElementById('wfName').value.trim();
    if (!name) { showErr('workflowDlg', 'Workflow name is required.'); return; }
    if (!wfModel.length) { showErr('workflowDlg', 'Add at least one step.'); return; }
    const seen = {};
    for (let i = 0; i < wfModel.length; i++) {
      const n = wfModel[i];
      if (!n.id) { showErr('workflowDlg', 'Every step needs an id.'); wfSelect(n.id); return; }
      if (seen[n.id]) { showErr('workflowDlg', 'Duplicate step id "' + n.id + '".'); wfSelect(n.id); return; }
      seen[n.id] = true;
      if (!n.instruction || !n.instruction.trim()) { showErr('workflowDlg', 'Step "' + n.id + '" needs an instruction.'); wfSelect(n.id); return; }
      if (!n.targetValue || !n.targetValue.trim()) { showErr('workflowDlg', 'Step "' + n.id + '" needs a target value.'); wfSelect(n.id); return; }
      for (let j = 0; j < (n.dependsOn || []).length; j++) {
        const dep = n.dependsOn[j];
        if (dep === n.id) { showErr('workflowDlg', 'Step "' + n.id + '" cannot depend on itself.'); wfSelect(n.id); return; }
        if (!wfById(dep)) { showErr('workflowDlg', 'Step "' + n.id + '" depends on unknown step "' + dep + '".'); wfSelect(n.id); return; }
      }
    }
    const cyc = wfHasCycle();
    if (cyc) { showErr('workflowDlg', 'Dependency cycle: ' + cyc.join(' → ')); return; }
    const steps = wfModel.map(wfToSpecStep);
    setBusy('wfGo', true);
    try {
      const res = await api('POST', 'workflows', { spec: { name, steps } });
      closeDlg('workflowDlg');
      refreshSoon('Defined ' + res.workflow.name + '.');
    } catch (e) {
      showErr('workflowDlg', 'Failed: ' + e.message);
    } finally {
      setBusy('wfGo', false);
    }
  }
  function addRunInput(k, v) {
    const wrap = document.createElement('div');
    wrap.className = 'kv-row';
    const key = document.createElement('input');
    key.placeholder = 'key';
    key.value = k || '';
    const val = document.createElement('input');
    val.placeholder = 'value';
    val.value = v || '';
    const del = document.createElement('button');
    del.className = 'act danger';
    del.textContent = '×';
    del.type = 'button';
    del.onclick = function() { wrap.remove(); };
    wrap.appendChild(key);
    wrap.appendChild(val);
    wrap.appendChild(del);
    document.getElementById('runInputs').appendChild(wrap);
  }
  async function doStartRun() {
    const id = document.getElementById('runStartId').value;
    const inputs = {};
    document.getElementById('runInputs').querySelectorAll('.kv-row').forEach(function(row) {
      const fields = row.querySelectorAll('input');
      const k = fields[0].value.trim();
      if (k) inputs[k] = fields[1].value;
    });
    try {
      const res = await api('POST', 'workflows/' + encodeURIComponent(id) + '/start', { inputs });
      document.getElementById('runStartDlg').close();
      try { sessionStorage.setItem(TAB_KEY, 'workflows'); } catch { /* ignore */ }
      refreshSoon('Started run ' + res.run.runId + '.');
    } catch (e) {
      toast('Failed: ' + e.message);
    }
  }
  function gotoApprovals() {
    document.querySelector('button[data-tab="approvals"]').click();
  }
  function gotoTab(name) {
    const btn = document.querySelector('button[data-tab="' + name + '"]');
    if (btn) btn.click();
  }
  async function loadIncoming() {
    const box = document.getElementById('incomingBox');
    if (!box) return;
    try {
      const data = await api('GET', 'shares/incoming');
      const agents = data.agents || [];
      const workflows = data.workflows || [];
      const namespaces = data.namespaces || [];
      box.innerHTML = '';
      if (agents.length + workflows.length + namespaces.length === 0) {
        box.textContent = 'Nothing pending.';
        return;
      }
      const addRow = function(label, acceptPath, rejectPath, body) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.gap = '8px';
        row.style.padding = '4px 0';
        const span = document.createElement('span');
        span.textContent = label;
        span.title = label;
        const btns = document.createElement('span');
        const ok = document.createElement('button');
        ok.className = 'act go';
        ok.textContent = 'Accept';
        ok.onclick = function() {
          api('POST', acceptPath, body || {}).then(function() { refreshSoon('Accepted.'); }).catch(function(e) { toast('Failed: ' + e.message); });
        };
        const no = document.createElement('button');
        no.className = 'act danger';
        no.textContent = 'Decline';
        no.onclick = function() {
          api('POST', rejectPath, body || {}).then(function() { refreshSoon('Declined.'); }).catch(function(e) { toast('Failed: ' + e.message); });
        };
        btns.appendChild(ok);
        btns.appendChild(no);
        row.appendChild(span);
        row.appendChild(btns);
        box.appendChild(row);
      };
      agents.forEach(function(s) { addRow('agent ' + s.agentId + ' from ' + s.ownerId, 'agents/' + encodeURIComponent(s.agentId) + '/accept', 'agents/' + encodeURIComponent(s.agentId) + '/reject'); });
      workflows.forEach(function(s) { addRow('workflow ' + s.workflowId + ' from ' + s.ownerId, 'workflows/' + encodeURIComponent(s.workflowId) + '/accept', 'workflows/' + encodeURIComponent(s.workflowId) + '/reject'); });
      namespaces.forEach(function(s) { addRow('memory ' + s.namespace + ' from ' + s.ownerId, 'memory/' + encodeURIComponent(s.namespace) + '/accept', 'memory/' + encodeURIComponent(s.namespace) + '/reject', { ownerId: s.ownerId }); });
    } catch (e) {
      box.textContent = 'Could not load incoming shares.';
    }
  }
  renderAuth();
  loadIncoming();
  try {
    const saved = sessionStorage.getItem(TAB_KEY);
    if (saved) gotoTab(saved);
  } catch { /* ignore */ }
`;
