import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OVERLAP_POLICIES } from './core/schedules.js';
import { MAX_TIMEOUT_SEC } from './core/policy.js';
import { RUNNER_NAMES } from './core/templates.js';
import { BUDGET_SCOPES } from './core/budget.js';
import { OrchestratorError } from './errors.js';
import type { Services } from './services.js';

const TemplateSchema = z
  .object({
    name: z.string().min(1),
    role: z.string().min(1),
    description: z.string().min(1),
    instructions: z.string().min(1),
    runner: z.enum(RUNNER_NAMES).optional(),
    model: z.string().optional()
  })
  .strict();

const ToolserverSchema = z
  .object({
    name: z.string().min(1),
    transport: z.union([
      z
        .object({
          type: z.literal('stdio'),
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          cwd: z.string().optional()
        })
        .strict(),
      z.object({ type: z.literal('http'), url: z.string().min(1) }).strict()
    ]),
    authRef: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    requireApprovalFor: z.array(z.string()).optional()
  })
  .strict();

const PresetSchema = z
  .object({ name: z.string().min(1), grants: z.array(z.string().min(1)).min(1) })
  .strict();

const ScheduleSchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    instruction: z.string().min(1),
    agentId: z.string().optional(),
    template: z.string().optional(),
    model: z.string().optional(),
    runner: z.enum(RUNNER_NAMES).optional(),
    priority: z.number().int().optional(),
    timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
    enabled: z.boolean().optional(),
    overlap: z.enum(OVERLAP_POLICIES).optional(),
    timezone: z.string().optional()
  })
  .strict();

const BudgetSchema = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    scopeId: z.string().optional(),
    maxCostUsd: z.number().min(0).optional(),
    maxTokens: z.number().int().min(1).optional(),
    maxCalls: z.number().int().min(1).optional(),
    maxConcurrent: z.number().int().min(1).optional()
  })
  .strict();

export const DeclarativeConfigSchema = z
  .object({
    templates: z.array(TemplateSchema).optional(),
    toolservers: z.array(ToolserverSchema).optional(),
    presets: z.array(PresetSchema).optional(),
    schedules: z.array(ScheduleSchema).optional(),
    budgets: z.array(BudgetSchema).optional()
  })
  .strict();

export type DeclarativeConfig = z.infer<typeof DeclarativeConfigSchema>;

export const DEFAULT_CONFIG_FILE = 'orchestrator.config.json';

/**
 * Read and validate the declarative config file. A missing file is only an
 * error when explicitly pointed at — the default path is best-effort, so a
 * deployment without one boots exactly as before.
 */
export async function loadDeclarativeConfigFile(
  configuredPath: string | undefined,
  cwd: string = process.cwd()
): Promise<{ path: string | undefined; config: DeclarativeConfig }> {
  const resolved = configuredPath ?? join(cwd, DEFAULT_CONFIG_FILE);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error) {
    if (configuredPath !== undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Config file ${resolved} cannot be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { path: undefined, config: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new OrchestratorError('INVALID_INPUT', `Config file ${resolved} is not valid JSON.`);
  }

  const result = DeclarativeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Config file ${resolved} is invalid: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    );
  }

  return { path: resolved, config: result.data };
}

export interface AppliedDeclarativeConfig {
  templates: number;
  toolservers: number;
  presets: number;
  schedules: number;
  budgets: number;
}

/**
 * Apply a validated file to the stores. Every section upserts, so applying
 * twice — or restarting with an unchanged file — changes nothing the second
 * time. File content never wins over later API calls: it lands once at boot,
 * and anything changed afterwards through the tools stays changed until the
 * next restart. Deliberately no A2A registrations (their credentials do not
 * belong in a file), no published skills and no runner defaults — those stay
 * in tools and env vars respectively.
 */
export async function applyDeclarativeConfig(
  services: Services,
  config: DeclarativeConfig
): Promise<AppliedDeclarativeConfig> {
  const applied: AppliedDeclarativeConfig = { templates: 0, toolservers: 0, presets: 0, schedules: 0, budgets: 0 };

  for (const template of config.templates ?? []) {
    await services.templates.save(template.name, {
      role: template.role,
      description: template.description,
      instructions: template.instructions,
      ...(template.runner !== undefined && { runner: template.runner }),
      ...(template.model !== undefined && { model: template.model })
    });
    applied.templates += 1;
  }

  for (const server of config.toolservers ?? []) {
    await services.proxy.register({
      name: server.name,
      transport: server.transport,
      ...(server.authRef !== undefined && { authRef: server.authRef }),
      ...(server.allowTools !== undefined && { allowTools: server.allowTools }),
      ...(server.denyTools !== undefined && { denyTools: server.denyTools }),
      ...(server.requireApprovalFor !== undefined && { requireApprovalFor: server.requireApprovalFor })
    });
    applied.toolservers += 1;
  }

  for (const preset of config.presets ?? []) {
    await services.presets.save(preset.name, preset.grants);
    applied.presets += 1;
  }

  for (const schedule of config.schedules ?? []) {
    // Fail fast, like schedule_create does: a target that cannot run would
    // otherwise surface only when the ticker fires, unattended.
    if (schedule.template !== undefined) {
      if (services.agents.isTemplateDisabled(schedule.template)) {
        throw new OrchestratorError(
          'POLICY_DENIED',
          `Schedule "${schedule.name}" uses disabled template "${schedule.template}".`
        );
      }
      if ((await services.templates.resolve(schedule.template)) === undefined) {
        throw new OrchestratorError(
          'NOT_FOUND',
          `Schedule "${schedule.name}" uses unknown template "${schedule.template}".`,
          'Call agent_template_list to see the available templates.'
        );
      }
    }
    if (schedule.agentId !== undefined) {
      // Admin-eyed existence check: the file is operator config, read at
      // boot with full visibility — like everything else in this file.
      await services.agents.getVisible(schedule.agentId, { ownerId: '', isAdmin: true });
    }
    await services.schedules.create({
      ownerId: '',
      name: schedule.name,
      cron: schedule.cron,
      instruction: schedule.instruction,
      ...(schedule.agentId !== undefined && { agentId: schedule.agentId }),
      ...(schedule.template !== undefined && { template: schedule.template }),
      ...(schedule.model !== undefined && { model: schedule.model }),
      ...(schedule.runner !== undefined && { runner: schedule.runner }),
      ...(schedule.priority !== undefined && { priority: schedule.priority }),
      ...(schedule.timeoutSec !== undefined && { timeoutSec: schedule.timeoutSec }),
      ...(schedule.enabled !== undefined && { enabled: schedule.enabled }),
      ...(schedule.overlap !== undefined && { overlap: schedule.overlap }),
      ...(schedule.timezone !== undefined && { timezone: schedule.timezone })
    });
    applied.schedules += 1;
  }

  for (const budget of config.budgets ?? []) {
    await services.budgets.set({
      scope: budget.scope,
      ...(budget.scopeId !== undefined && { scopeId: budget.scopeId }),
      ...(budget.maxCostUsd !== undefined && { maxCostUsd: budget.maxCostUsd }),
      ...(budget.maxTokens !== undefined && { maxTokens: budget.maxTokens }),
      ...(budget.maxCalls !== undefined && { maxCalls: budget.maxCalls }),
      ...(budget.maxConcurrent !== undefined && { maxConcurrent: budget.maxConcurrent })
    });
    applied.budgets += 1;
  }

  return applied;
}
