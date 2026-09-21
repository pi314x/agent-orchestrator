import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { BUILTIN_TEMPLATES, DEFAULT_RUNNER } from '../../src/core/templates.js';

describe('loadConfig', () => {
  it('applies documented defaults', async () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data' });

    expect(config.toolProfile).toBe('standard');
    expect(config.transport).toBe('stdio');
    expect(config.httpPort).toBe(3333);
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.maxDepth).toBe(2);
    expect(config.maxConcurrency).toBe(4);
    expect(config.runnerRetries).toBe(2);
    expect(config.a2aEnabled).toBe(false);
    // A native filesystem path, so the separators are the OS's own — a POSIX
    // literal here fails on Windows, where join produces backslashes.
    expect(config.dbUrl).toBe(join('/data', 'orchestrator.sqlite'));
    expect(config.defaultRunner).toBe('openai-compatible');
  });

  // The same choice is written down in three places — the config default, the
  // built-in templates and `.env.example`. Only the first two share a constant,
  // so the documented one is easy to leave behind.
  it('keeps the default runner, the templates and .env.example in agreement', async () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data' });

    expect(config.defaultRunner).toBe(DEFAULT_RUNNER);
    expect([...new Set(BUILTIN_TEMPLATES.map(t => t.runner))]).toEqual([DEFAULT_RUNNER]);

    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(new RegExp(`^ORCH_DEFAULT_RUNNER=${DEFAULT_RUNNER}\\b`, 'm'));
  });

  it('still honours an explicit runner choice', async () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/data', ORCH_DEFAULT_RUNNER: 'anthropic' }).defaultRunner).toBe(
      'anthropic'
    );
  });

  it('reads the model for the default runner from the environment', async () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data', OPENAI_MODEL: 'gpt-4.1-mini' });

    expect(config.openaiModel).toBe('gpt-4.1-mini');
  });

  it('reads the transport and port used for Streamable HTTP', async () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data', ORCH_TRANSPORT: 'http', ORCH_HTTP_PORT: '8080' });

    expect(config.transport).toBe('http');
    expect(config.httpPort).toBe(8080);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['ON', true],
    ['false', false],
    ['0', false],
    ['', false]
  ])('parses A2A_ENABLED=%s as %s', (raw, expected) => {
    expect(loadConfig({ ORCH_DATA_DIR: '/d', A2A_ENABLED: raw }).a2aEnabled).toBe(expected);
  });

  it('reads the disabled template list', async () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).disabledTemplates).toEqual([]);
    expect(
      loadConfig({ ORCH_DATA_DIR: '/d', ORCH_DISABLED_TEMPLATES: 'coder, reviewer' }).disabledTemplates
    ).toEqual(['coder', 'reviewer']);
  });

  it('reads reliability, retention, schedule and webhook settings', async () => {
    const defaults = loadConfig({ ORCH_DATA_DIR: '/d' });
    expect(defaults.runnerRetries).toBe(2);
    expect(defaults.retentionDays).toBeUndefined();
    expect(defaults.scheduleTickSec).toBe(30);
    expect(defaults.cancelPollSec).toBe(2);
    expect(defaults.webhookAllowedHosts).toEqual([]);
    expect(defaults.oauthAdminRoles).toEqual([]);

    const configured = loadConfig({
      ORCH_DATA_DIR: '/d',
      ORCH_RUNNER_RETRIES: '0',
      ORCH_RETENTION_DAYS: '90',
      ORCH_SCHEDULE_TICK_SEC: '15',
      ORCH_CANCEL_POLL_SEC: '5',
      ORCH_WEBHOOK_ALLOWED_HOSTS: 'hooks.example.com',
      ORCH_ADMIN_ROLES: 'Orchestrator.Admin, Support'
    });
    expect(configured.runnerRetries).toBe(0);
    expect(configured.retentionDays).toBe(90);
    expect(configured.scheduleTickSec).toBe(15);
    expect(configured.cancelPollSec).toBe(5);
    expect(configured.webhookAllowedHosts).toEqual(['hooks.example.com']);
    // Role values are case-sensitive and never lowercased.
    expect(configured.oauthAdminRoles).toEqual(['Orchestrator.Admin', 'Support']);
  });

  it('reads the sampling model allow-list without lowercasing', async () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).samplingAllowedModels).toEqual([]);
    expect(
      loadConfig({ ORCH_DATA_DIR: '/d', ORCH_SAMPLING_ALLOWED_MODELS: 'Claude-Opus, gpt-4o' }).samplingAllowedModels
    ).toEqual(['Claude-Opus', 'gpt-4o']);
  });

  it('leaves post-quantum keys unset by default and reads them verbatim', async () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).pqcDataKey).toBeUndefined();
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).pqcSigningKey).toBeUndefined();
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).pqcSigningKid).toBeUndefined();

    const configured = loadConfig({
      ORCH_DATA_DIR: '/d',
      ORCH_PQC_DATA_KEY: 'aGVsbG8=',
      ORCH_PQC_SIGNING_KEY: 'c2VjcmV0',
      ORCH_PQC_SIGNING_KID: 'pqc-1'
    });
    // Secrets are never trimmed into something else or lowercased — base64 is
    // case-sensitive and whitespace would corrupt the bundle.
    expect(configured.pqcDataKey).toBe('aGVsbG8=');
    expect(configured.pqcSigningKey).toBe('c2VjcmV0');
    expect(configured.pqcSigningKid).toBe('pqc-1');
  });

  it('reads an explicit JWKS url and config file path', async () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).oauthJwksUrl).toBeUndefined();
    expect(loadConfig({ ORCH_DATA_DIR: '/d' }).configFile).toBeUndefined();
    const configured = loadConfig({
      ORCH_DATA_DIR: '/d',
      ORCH_OAUTH_JWKS_URL: 'https://issuer.example.test/keys',
      ORCH_CONFIG_FILE: '/srv/orchestrator.json'
    });
    expect(configured.oauthJwksUrl).toBe('https://issuer.example.test/keys');
    expect(configured.configFile).toBe('/srv/orchestrator.json');
  });

  it('rejects an unknown tool profile', async () => {
    expect(() => loadConfig({ ORCH_DATA_DIR: '/d', ORCH_TOOL_PROFILE: 'everything' })).toThrow();
  });

  it('rejects a non-numeric port', async () => {
    expect(() => loadConfig({ ORCH_DATA_DIR: '/d', ORCH_HTTP_PORT: 'abc' })).toThrow();
  });
});
