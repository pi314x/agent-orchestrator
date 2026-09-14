import { describe, expect, it } from 'vitest';
import { buildStatus, type StatusInputs } from '../../src/core/status.js';

const inputs: StatusInputs = {
  version: '0.0.1',
  profile: 'standard',
  transport: 'http',
  protocolEra: 'modern',
  schemaVersion: 1,
  latestSchemaVersion: 1,
  a2aEnabled: false,
  maxConcurrency: 4,
  maxDepth: 2,
  uptimeSec: 12.4,
  jobs: { queued: 0, running: 0, blocked: 0 }
};

describe('buildStatus', () => {
  it('reports ok when the schema is current', async () => {
    const status = buildStatus(inputs);

    expect(status.status).toBe('ok');
    expect(status.database.migrationsPending).toBe(false);
    expect(status.uptimeSec).toBe(12);
  });

  it('reports degraded when migrations are pending', async () => {
    const status = buildStatus({ ...inputs, schemaVersion: 0, latestSchemaVersion: 1 });

    expect(status.status).toBe('degraded');
    expect(status.database.migrationsPending).toBe(true);
  });

  it('surfaces the A2A gateway switch', async () => {
    expect(buildStatus({ ...inputs, a2aEnabled: true }).a2a.enabled).toBe(true);
  });
});
