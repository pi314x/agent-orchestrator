import { z } from 'zod';
import { JOB_STATES, type JobRecord } from '../core/jobs.js';
import type { AgentRecord } from '../core/registry.js';
import { RUNNER_NAMES } from '../core/templates.js';
import { ERROR_CODES } from '../errors.js';

export const CursorSchema = z.string().optional().describe('Opaque cursor from a previous response.');
export const LimitSchema = z.number().int().min(1).max(100).default(20);

export const ErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional()
});

export const UsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional()
});

/**
 * One shape, two backends (AGENTS.md interop rule 1). Backend-specific detail
 * never leaks into these common fields.
 */
export const JobViewSchema = z.object({
  jobId: z.string(),
  state: z.enum(JOB_STATES),
  backend: z.enum(['local', 'a2a_remote']),
  agentId: z.string(),
  agentName: z.string(),
  instruction: z.string(),
  attempt: z.number(),
  depth: z.number(),
  priority: z.number(),
  dependsOn: z.array(z.string()),
  resultText: z.string().optional(),
  resultStructured: z.unknown().optional(),
  error: ErrorSchema.optional(),
  usage: UsageSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional()
});

export type JobView = z.infer<typeof JobViewSchema>;

export function toJobView(job: JobRecord): JobView {
  return {
    jobId: job.id,
    state: job.state,
    backend: job.backend,
    agentId: job.agentId,
    agentName: job.agentSnapshot.name,
    instruction: job.instruction,
    attempt: job.attempt,
    depth: job.depth,
    priority: job.priority,
    dependsOn: job.dependsOn,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.resultText !== undefined && { resultText: job.resultText }),
    ...(job.resultStructured !== undefined && { resultStructured: job.resultStructured }),
    ...(job.error !== undefined && { error: job.error }),
    ...(job.usage !== undefined && { usage: job.usage }),
    ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
    ...(job.finishedAt !== undefined && { finishedAt: job.finishedAt })
  };
}

export const AgentViewSchema = z.object({
  agentId: z.string(),
  kind: z.enum(['local', 'remote']),
  name: z.string(),
  role: z.string().optional(),
  instructions: z.string(),
  runner: z.enum(RUNNER_NAMES).optional(),
  model: z.string().optional(),
  toolGrants: z.array(z.string()),
  ephemeral: z.boolean(),
  createdAt: z.string()
});

export type AgentView = z.infer<typeof AgentViewSchema>;

export function toAgentView(agent: AgentRecord): AgentView {
  return {
    agentId: agent.id,
    kind: agent.kind,
    name: agent.name,
    instructions: agent.instructions,
    toolGrants: agent.toolGrants,
    ephemeral: agent.ephemeral,
    createdAt: agent.createdAt,
    ...(agent.role !== undefined && { role: agent.role }),
    ...(agent.runner !== undefined && { runner: agent.runner }),
    ...(agent.model !== undefined && { model: agent.model })
  };
}

/** A JSON Schema supplied by the caller to constrain an agent's output. */
export const OutputSchemaSchema = z.record(z.string(), z.unknown()).optional();
