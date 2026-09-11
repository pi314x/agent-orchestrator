import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { BUILTIN_TEMPLATES, DEFAULT_RUNNER } from '../../src/core/templates.js';

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data' });

    expect(config.toolProfile).toBe('standard');
    expect(config.transport).toBe('stdio');
    expect(config.httpPort).toBe(3333);
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.maxDepth).toBe(2);
    expect(config.maxConcurrency).toBe(4);
    expect(config.a2aEnabled).toBe(false);
    expect(config.dbUrl).toBe('/data/orchestrator.sqlite');
    expect(config.defaultRunner).toBe('openai-compatible');
  });

  // The same choice is written down in three places — the config default, the
  // built-in templates and `.env.example`. Only the first two share a constant,
  // so the documented one is easy to leave behind.
  it('keeps the default runner, the templates and .env.example in agreement', () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data' });

    expect(config.defaultRunner).toBe(DEFAULT_RUNNER);
    expect([...new Set(BUILTIN_TEMPLATES.map(t => t.runner))]).toEqual([DEFAULT_RUNNER]);

    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(new RegExp(`^ORCH_DEFAULT_RUNNER=${DEFAULT_RUNNER}\\b`, 'm'));
  });

  it('still honours an explicit runner choice', () => {
    expect(loadConfig({ ORCH_DATA_DIR: '/data', ORCH_DEFAULT_RUNNER: 'anthropic' }).defaultRunner).toBe(
      'anthropic'
    );
  });

  it('reads the model for the default runner from the environment', () => {
    const config = loadConfig({ ORCH_DATA_DIR: '/data', OPENAI_MODEL: 'gpt-4.1-mini' });

    expect(config.openaiModel).toBe('gpt-4.1-mini');
  });

  it('reads the transport and port used for Streamable HTTP', () => {
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

  it('rejects an unknown tool profile', () => {
    expect(() => loadConfig({ ORCH_DATA_DIR: '/d', ORCH_TOOL_PROFILE: 'everything' })).toThrow();
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ORCH_DATA_DIR: '/d', ORCH_HTTP_PORT: 'abc' })).toThrow();
  });
});
