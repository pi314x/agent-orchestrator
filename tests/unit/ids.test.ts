import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId } from '../../src/ids.js';

describe('ids', () => {
  it('prefixes each entity kind distinctly', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('mints recognizable prefixed ULIDs', () => {
    const id = newId('job');
    expect(id.startsWith('job_')).toBe(true);
    expect(isId('job', id)).toBe(true);
    expect(isId('agent', id)).toBe(false);
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('event')));
    expect(ids.size).toBe(500);
  });

  it('rejects a bare prefix', () => {
    expect(isId('job', 'job_')).toBe(false);
  });
});
