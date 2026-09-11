import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

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
