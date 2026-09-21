import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { TRUST_MODES } from './a2a/trust.js';
import { DEFAULT_RUNNER, RUNNER_NAMES } from './core/templates.js';

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
  /** Postgres pool size per instance; unused by SQLite. */
  dbMaxConnections: z.number().int().min(1).optional(),
  maxDepth: z.number().int().min(0),
  maxConcurrency: z.number().int().min(1),
  /** Automatic retries per job for transient runner failures (rate limits, 5xx, unreachable endpoints). */
  runnerRetries: z.number().int().min(0),
  /** How often due schedules are checked. */
  scheduleTickSec: z.number().int().min(5),
  /**
   * How often an instance checks for jobs another instance asked to cancel.
   * Far shorter than the 15s lease heartbeat on purpose: a cancel is a human
   * waiting, and the check is one cheap indexed read over the small running
   * set. The heartbeat itself stays slow — reclaiming early runs work twice.
   */
  cancelPollSec: z.number().int().min(1),
  /** Keep finished history for this many days; unset keeps everything. Read by maintenance_prune. */
  retentionDays: z.number().int().min(1).optional(),
  logLevel: LogLevelSchema,
  defaultRunner: z.enum(RUNNER_NAMES),
  agentsDir: z.string().min(1),
  /** Declarative config file; unset means ./orchestrator.config.json when present, ignored when absent. */
  configFile: z.string().optional(),
  /** Templates excluded from assignment, e.g. in sensitive repos. */
  disabledTemplates: z.array(z.string()),
  cliCommand: z.string().optional(),
  /** Comma-separated, so an argument may itself contain spaces. */
  cliArgs: z.array(z.string()).default([]),
  cliWorkspaceDirs: z.array(z.string()),
  cliAllowNetwork: z.boolean(),
  oauthIssuerUrl: z.string().optional(),
  oauthResourceUrl: z.string().optional(),
  oauthRequiredScopes: z.array(z.string()),
  oauthJwksUrl: z.string().optional(),
  /** App-role values granting orch:admin. Case-sensitive, matched exactly — never lowercased. */
  oauthAdminRoles: z.array(z.string()),
  /** Models allowed to answer borrowed calls. Empty means any. Case-sensitive, matched exactly. */
  samplingAllowedModels: z.array(z.string()),
  /**
   * Post-quantum at-rest encryption (hybrid X25519+ML-KEM-768). Base64 of a
   * v1 key bundle — generate one and keep it like any other secret. Unset
   * means artifacts and memory values rest as plaintext.
   */
  pqcDataKey: z.string().optional(),
  /** Base64 of an ML-DSA-65 secret key. Set to PQC-sign our published A2A Agent Card. */
  pqcSigningKey: z.string().optional(),
  /** Key id advertised alongside the PQC card signature. */
  pqcSigningKid: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  openaiModel: z.string().optional(),
  a2aEnabled: z.boolean(),
  a2aHttpPort: z.number().int().min(1).max(65535),
  a2aTrustMode: z.enum(TRUST_MODES),
  a2aAgentCardUrl: z.string().optional(),
  a2aRegistryUrl: z.string().optional(),
  a2aWebhookAllowedHosts: z.array(z.string()),
  /** Hosts completion callbacks may target, beyond the SSRF baseline. Empty means any public HTTPS. */
  webhookAllowedHosts: z.array(z.string()),
  /**
   * Extra hostnames accepted in an inbound request's Host and Origin headers,
   * beyond loopback and `httpHost`. `httpHost` is a bind *address*
   * (0.0.0.0 to accept remote connections); the Host header a real remote
   * client sends is the public hostname it connects to (e.g. a reverse
   * proxy's domain), which is a different string entirely. Without an entry
   * here, every request from behind a reverse proxy is rejected with 403
   * before OAuth or anything else runs — binding 0.0.0.0 alone does not make
   * the server reachable by a hosted client.
   */
  httpAllowedHosts: z.array(z.string()),
  /**
   * Browser origins allowed to read this server cross-origin. Unset means
   * allow-all (`*`); otherwise a comma-separated list of exact origins
   * (`https://app.example.com`, bare hostnames shorthand to https). Named
   * here also passes the Origin guard — CORS headers without that would be
   * pointless, and the guard without those headers would block what CORS
   * just allowed.
   */
  corsAllowedOrigins: z.array(z.string())
});

export type Config = z.infer<typeof ConfigSchema>;

const splitList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');

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
    ...(env.ORCH_DB_MAX_CONNECTIONS?.trim() && {
      dbMaxConnections: intFromEnv(10).parse(env.ORCH_DB_MAX_CONNECTIONS)
    }),
    maxDepth: intFromEnv(2).parse(env.ORCH_MAX_DEPTH),
    maxConcurrency: intFromEnv(4).parse(env.ORCH_MAX_CONCURRENCY),
    runnerRetries: intFromEnv(2).parse(env.ORCH_RUNNER_RETRIES),
    scheduleTickSec: intFromEnv(30).parse(env.ORCH_SCHEDULE_TICK_SEC),
    cancelPollSec: intFromEnv(2).parse(env.ORCH_CANCEL_POLL_SEC),
    ...(env.ORCH_RETENTION_DAYS?.trim() && {
      retentionDays: intFromEnv(30).parse(env.ORCH_RETENTION_DAYS)
    }),
    logLevel: LogLevelSchema.parse(env.ORCH_LOG_LEVEL?.trim() || 'info'),
    defaultRunner: z.enum(RUNNER_NAMES).parse(env.ORCH_DEFAULT_RUNNER?.trim() || DEFAULT_RUNNER),
    agentsDir: env.ORCH_AGENTS_DIR?.trim() || 'agents',
    ...(env.ORCH_CONFIG_FILE?.trim() && { configFile: env.ORCH_CONFIG_FILE.trim() }),
    disabledTemplates: splitList(env.ORCH_DISABLED_TEMPLATES),
    ...(env.ORCH_CLI_COMMAND?.trim() && { cliCommand: env.ORCH_CLI_COMMAND.trim() }),
    // Some CLIs need a subcommand or flag before they will run headless
    // (`codex exec`, for instance). Without this the runner could only ever
    // invoke a bare command, which silently rules those out.
    cliArgs: splitList(env.ORCH_CLI_ARGS),
    cliWorkspaceDirs: splitList(env.ORCH_CLI_WORKSPACE_DIRS),
    cliAllowNetwork: boolish(false).parse(env.ORCH_CLI_ALLOW_NETWORK),
    ...(env.ORCH_OAUTH_ISSUER_URL?.trim() && { oauthIssuerUrl: env.ORCH_OAUTH_ISSUER_URL.trim() }),
    ...(env.ORCH_OAUTH_RESOURCE_URL?.trim() && { oauthResourceUrl: env.ORCH_OAUTH_RESOURCE_URL.trim() }),
    oauthRequiredScopes: splitList(env.ORCH_OAUTH_REQUIRED_SCOPES),
    ...(env.ORCH_OAUTH_JWKS_URL?.trim() && { oauthJwksUrl: env.ORCH_OAUTH_JWKS_URL.trim() }),
    oauthAdminRoles: splitList(env.ORCH_ADMIN_ROLES),
    samplingAllowedModels: splitList(env.ORCH_SAMPLING_ALLOWED_MODELS),
    ...(env.ORCH_PQC_DATA_KEY?.trim() && { pqcDataKey: env.ORCH_PQC_DATA_KEY.trim() }),
    ...(env.ORCH_PQC_SIGNING_KEY?.trim() && { pqcSigningKey: env.ORCH_PQC_SIGNING_KEY.trim() }),
    ...(env.ORCH_PQC_SIGNING_KID?.trim() && { pqcSigningKid: env.ORCH_PQC_SIGNING_KID.trim() }),
    ...(env.ANTHROPIC_API_KEY?.trim() && { anthropicApiKey: env.ANTHROPIC_API_KEY.trim() }),
    ...(env.ANTHROPIC_MODEL?.trim() && { anthropicModel: env.ANTHROPIC_MODEL.trim() }),
    ...(env.OPENAI_API_KEY?.trim() && { openaiApiKey: env.OPENAI_API_KEY.trim() }),
    ...(env.OPENAI_BASE_URL?.trim() && { openaiBaseUrl: env.OPENAI_BASE_URL.trim() }),
    ...(env.OPENAI_MODEL?.trim() && { openaiModel: env.OPENAI_MODEL.trim() }),
    a2aEnabled: boolish(false).parse(env.A2A_ENABLED),
    a2aHttpPort: intFromEnv(3334).parse(env.A2A_HTTP_PORT),
    a2aTrustMode: z.enum(TRUST_MODES).parse(env.A2A_TRUST_MODE?.trim() || 'verified-only'),
    ...(env.A2A_AGENT_CARD_URL?.trim() && { a2aAgentCardUrl: env.A2A_AGENT_CARD_URL.trim() }),
    ...(env.A2A_REGISTRY_URL?.trim() && { a2aRegistryUrl: env.A2A_REGISTRY_URL.trim() }),
    a2aWebhookAllowedHosts: splitList(env.A2A_WEBHOOK_ALLOWED_HOSTS).map(host => host.toLowerCase()),
    webhookAllowedHosts: splitList(env.ORCH_WEBHOOK_ALLOWED_HOSTS).map(host => host.toLowerCase()),
    httpAllowedHosts: splitList(env.ORCH_HTTP_ALLOWED_HOSTS).map(host => host.toLowerCase()),
    corsAllowedOrigins: splitList(env.ORCH_CORS_ALLOWED_ORIGINS)
  };

  return ConfigSchema.parse(raw);
}
