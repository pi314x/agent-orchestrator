import { describe, expect, it } from 'vitest';
import {
  generateDataKey,
  generateKemKeypair,
  generateSigningKeypair,
  kemDecapsulate,
  kemEncapsulate,
  keyFingerprint,
  parseDataKey,
  pqcOpen,
  pqcSeal,
  pqcSign,
  pqcVerify,
  PQC_ALGORITHMS
} from '../../src/core/pqc.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('ML-DSA-65 signatures (FIPS 204)', () => {
  it('round-trips and rejects tampered messages', async () => {
    const keys = generateSigningKeypair();
    const message = text('agent-card canonical bytes');

    const signature = pqcSign(keys.secretKey, message);
    expect(pqcVerify(keys.publicKey, message, signature)).toBe(true);
    expect(pqcVerify(keys.publicKey, text('agent-card canonical bytex'), signature)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const signature = pqcSign(a.secretKey, text('hello'));

    expect(pqcVerify(b.publicKey, text('hello'), signature)).toBe(false);
  });

  it('reads truncated or garbage input as false, never a throw', async () => {
    const keys = generateSigningKeypair();

    expect(pqcVerify(keys.publicKey, text('hello'), new Uint8Array(10))).toBe(false);
    expect(pqcVerify(new Uint8Array(10), text('hello'), new Uint8Array(10))).toBe(false);
  });

  it('fingerprints stably without exposing secrets', async () => {
    const keys = generateSigningKeypair();

    expect(keyFingerprint(keys.publicKey)).toBe(keyFingerprint(keys.publicKey));
    expect(keyFingerprint(keys.publicKey)).not.toContain(Buffer.from(keys.secretKey).toString('hex'));
  });
});

describe('ML-KEM-768 encapsulation (FIPS 203)', () => {
  it('both sides agree on the shared secret', async () => {
    const keys = generateKemKeypair();
    const { cipherText, sharedSecret } = kemEncapsulate(keys.publicKey);

    expect(kemDecapsulate(keys.secretKey, cipherText)).toEqual(sharedSecret);
  });
});

describe('hybrid data-key envelope (X25519+ML-KEM-768)', () => {
  it('seal/open round-trips and the bundle survives base64', async () => {
    const key = generateDataKey();
    const restored = parseDataKey(Buffer.from(JSON.stringify(key)).toString('base64'));

    const envelope = pqcSeal(restored, text('secret artifact content'));
    expect(new TextDecoder().decode(pqcOpen(restored, envelope))).toBe('secret artifact content');
  });

  it('tampering with the box fails closed', async () => {
    const key = generateDataKey();
    const envelope = pqcSeal(key, text('hello'));
    const tampered = { ...envelope, box: Buffer.from(envelope.box, 'base64').fill(0).toString('base64') };

    expect(() => pqcOpen(key, tampered)).toThrow();
  });

  it('a different data key cannot open the envelope', async () => {
    const envelope = pqcSeal(generateDataKey(), text('hello'));

    expect(() => pqcOpen(generateDataKey(), envelope)).toThrow();
  });

  it('rejects a malformed bundle instead of booting half-keyed', async () => {
    expect(() => parseDataKey('not-base64!!')).toThrow(/key bundle/);
    expect(() => parseDataKey(Buffer.from('{}').toString('base64'))).toThrow(/v1/);
  });

  it('rejects a bundle missing any of the four key halves', async () => {
    const full = generateDataKey();
    const withoutX = { v: full.v, mlKem: full.mlKem };

    expect(() => parseDataKey(Buffer.from(JSON.stringify(withoutX)).toString('base64'))).toThrow(/v1/);
    expect(() =>
      parseDataKey(
        Buffer.from(JSON.stringify({ ...full, mlKem: { ...full.mlKem, secretKey: 42 } })).toString('base64')
      )
    ).toThrow(/v1/);
  });

  it('advertises exactly the three NIST algorithms', async () => {
    expect(PQC_ALGORITHMS).toEqual(['ML-DSA-65', 'ML-KEM-768', 'X25519+ML-KEM-768']);
  });
});
