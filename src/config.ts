import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { TRUST_MODES } from './a2a/trust.js';
import { RUNNER_NAMES } from './core/templates.js';

export const TOOL_PROFILES = ['core', 'standard', 'full'] as const;
export const ToolProfileSchema = z.enum(TOOL_PROFILES);
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const TransportSchema = z.enum(['stdio', 'http']);
export type TransportKind = z.infer<typeof TransportSchema>;

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

/** Env vars are strings; accept the usual spellings of a boolean. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform(raw =>
      raw === undefined || raw === '' ? defaultValue : ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
    );

const ConfigSchema = z.object({
  dataDir: z.string().min(1),
  toolProfile: ToolProfileSchema,
  transport: TransportSchema,
  httpHost: z.string().min(1),
  httpPort: z.number().int().min(1).max(65535),
  dbUrl: z.string().min(1),
  maxDepth: z.number().int().min(0),
  maxConcurrency: z.number().int().min(1),
  logLevel: LogLevelSchema,
  defaultRunner: z.enum(RUNNER_NAMES),
  agentsDir: z.string().min(1),
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  a2aEnabled: z.boolean(),
  a2aHttpPort: z.number().int().min(1).max(65535),
  a2aTrustMode: z.enum(TRUST_MODES),
  a2aAgentCardUrl: z.string().optional(),
  a2aRegistryUrl: z.string().optional(),
  a2aWebhookAllowedHosts: z.array(z.string())
});

export type Config = z.infer<typeof ConfigSchema>;

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform(raw => (raw === undefined || raw === '' ? fallback : Number(raw)))
    .pipe(z.number().int());

/**
 * Build the config from an environment mapping. Pure so tests can pass a literal
 * env instead of mutating `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.ORCH_DATA_DIR?.trim() || join(homedir(), '.agent-orchestrator');

  const raw = {
    dataDir,
    toolProfile: ToolProfileSchema.parse(env.ORCH_TOOL_PROFILE?.trim() || 'standard'),
    transport: TransportSchema.parse(env.ORCH_TRANSPORT?.trim() || 'stdio'),
    httpHost: env.ORCH_HTTP_HOST?.trim() || '127.0.0.1',
    httpPort: intFromEnv(3333).parse(env.ORCH_HTTP_PORT),
    dbUrl: env.ORCH_DB_URL?.trim() || join(dataDir, 'orchestrator.sqlite'),
    maxDepth: intFromEnv(2).parse(env.ORCH_MAX_DEPTH),
    maxConcurrency: intFromEnv(4).parse(env.ORCH_MAX_CONCURRENCY),
    logLevel: LogLevelSchema.parse(env.ORCH_LOG_LEVEL?.trim() || 'info'),
    defaultRunner: z.enum(RUNNER_NAMES).parse(env.ORCH_DEFAULT_RUNNER?.trim() || 'anthropic'),
    agentsDir: env.ORCH_AGENTS_DIR?.trim() || 'agents',
    ...(env.ANTHROPIC_API_KEY?.trim() && { anthropicApiKey: env.ANTHROPIC_API_KEY.trim() }),
    ...(env.ANTHROPIC_MODEL?.trim() && { anthropicModel: env.ANTHROPIC_MODEL.trim() }),
    ...(env.OPENAI_API_KEY?.trim() && { openaiApiKey: env.OPENAI_API_KEY.trim() }),
    ...(env.OPENAI_BASE_URL?.trim() && { openaiBaseUrl: env.OPENAI_BASE_URL.trim() }),
    a2aEnabled: boolish(false).parse(env.A2A_ENABLED),
    a2aHttpPort: intFromEnv(3334).parse(env.A2A_HTTP_PORT),
    a2aTrustMode: z.enum(TRUST_MODES).parse(env.A2A_TRUST_MODE?.trim() || 'verified-only'),
    ...(env.A2A_AGENT_CARD_URL?.trim() && { a2aAgentCardUrl: env.A2A_AGENT_CARD_URL.trim() }),
    ...(env.A2A_REGISTRY_URL?.trim() && { a2aRegistryUrl: env.A2A_REGISTRY_URL.trim() }),
    a2aWebhookAllowedHosts: (env.A2A_WEBHOOK_ALLOWED_HOSTS?.trim() ?? '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(host => host !== '')
  };

  return ConfigSchema.parse(raw);
}
