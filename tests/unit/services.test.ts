import { describe, expect, it } from 'vitest';
import { generateDataKey, generateSigningKeypair } from '../../src/core/pqc.js';
import { createServices } from '../../src/services.js';
import { migratedDb, silentLogger, testConfig } from '../helpers.js';

/**
 * Malformed PQC key material must fail the boot with a clear message — not
 * months later inside the first sealed read or card build, where it surfaces
 * as an unrelated 500.
 */
describe('createServices PQC key validation', () => {
  it('rejects a signing key that is not a 4032-byte ML-DSA-65 secret', async () => {
    const db = await migratedDb();
    try {
      expect(() =>
        createServices({
          config: testConfig({ pqcSigningKey: Buffer.from('too short').toString('base64') }),
          db,
          logger: silentLogger()
        })
      ).toThrow(/4032/);
    } finally {
      await db.close();
    }
  });

  it('rejects a data key bundle that does not parse', async () => {
    const db = await migratedDb();
    try {
      expect(() =>
        createServices({
          config: testConfig({ pqcDataKey: Buffer.from('{}').toString('base64') }),
          db,
          logger: silentLogger()
        })
      ).toThrow(/v1/);
    } finally {
      await db.close();
    }
  });

  it('accepts real keys and wires them into the stores', async () => {
    const db = await migratedDb();
    const keys = generateSigningKeypair();
    const dataKey = generateDataKey();
    try {
      const services = createServices({
        config: testConfig({
          pqcSigningKey: Buffer.from(keys.secretKey).toString('base64'),
          pqcSigningKid: 'pqc-1',
          pqcDataKey: Buffer.from(JSON.stringify(dataKey)).toString('base64')
        }),
        db,
        logger: silentLogger()
      });

      expect(services.pqc.cardSigner?.kid).toBe('pqc-1');
      expect(services.pqc.dataKey?.v).toBe(1);
      await services.scheduler.shutdown();
      await services.proxy.close();
    } finally {
      await db.close();
    }
  });
});
