import { describe, expect, it } from 'vitest';
import {
  corsHeaders,
  parseCorsPolicy,
  preflightHeaders,
  requestOrigin
} from '../../src/cors.js';

describe('parseCorsPolicy', () => {
  it('defaults to allow-all when unset or empty', async () => {
    expect(parseCorsPolicy(undefined).allowAll).toBe(true);
    expect(parseCorsPolicy([]).allowAll).toBe(true);
    expect(parseCorsPolicy(['*']).allowAll).toBe(true);
  });

  it('normalizes entries and exposes their hostnames for the origin guard', async () => {
    const policy = parseCorsPolicy(['https://app.example.com:8443', 'other.example.com', 'not a url !!']);

    expect(policy.allowAll).toBe(false);
    expect(policy.origins).toEqual(['https://app.example.com:8443', 'https://other.example.com']);
    expect(policy.originHosts.sort()).toEqual(['app.example.com', 'other.example.com']);
  });
});

describe('requestOrigin', () => {
  it('normalizes the Origin header and rejects garbage', async () => {
    expect(requestOrigin({ origin: 'https://app.example.com/x' })).toBe('https://app.example.com');
    expect(requestOrigin({})).toBeUndefined();
    expect(requestOrigin({ origin: 'not a url' })).toBeUndefined();
  });
});

describe('corsHeaders', () => {
  it('answers allow-all with a bare star', async () => {
    expect(corsHeaders(parseCorsPolicy(undefined), 'https://anything.example/')).toEqual({
      'Access-Control-Allow-Origin': '*'
    });
  });

  it('echoes a named origin with Vary, and stays silent otherwise', async () => {
    const policy = parseCorsPolicy(['https://app.example.com']);

    expect(corsHeaders(policy, 'https://app.example.com')).toEqual({
      'Access-Control-Allow-Origin': 'https://app.example.com',
      Vary: 'Origin'
    });
    expect(corsHeaders(policy, 'https://evil.example.com')).toEqual({});
    expect(corsHeaders(policy, undefined)).toEqual({});
  });
});

describe('preflightHeaders', () => {
  it('names methods and reflects requested headers', async () => {
    const headers = preflightHeaders(parseCorsPolicy(undefined), 'https://x.example/', 'X-Custom, Authorization');

    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(headers['Access-Control-Allow-Headers']).toBe('X-Custom, Authorization');
  });

  it('answers nothing when the origin is not allowed', async () => {
    expect(preflightHeaders(parseCorsPolicy(['https://app.example.com']), 'https://evil.example.com')).toEqual(
      {}
    );
  });
});
