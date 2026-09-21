import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

/**
 * NIST post-quantum primitives (FIPS 203 ML-KEM-768, FIPS 204 ML-DSA-65),
 * category-3 parameter sets in both cases. Implemented over
 * `@noble/post-quantum` — auditable, dependency-light, pure TypeScript —
 * rather than hand-rolled lattice arithmetic, which is exactly the kind of
 * code this codebase must never carry itself.
 *
 * Lives in core and imports no SDK: the A2A trust path, the OAuth verifier
 * and the at-rest envelope all share these shapes. Everything crossing a
 * process boundary (envelopes, key bundles) is JSON with a version field, so
 * a future FIPS 206 (Falcon) or SLH-DSA parameter set slots in as `v2`
 * without re-reading old rows.
 */

export const PQC_SIGN_ALG = 'ML-DSA-65';
export const PQC_KEM_ALG = 'ML-KEM-768';
/** Hybrid data protection: classical X25519 plus ML-KEM-768, combined below. */
export const PQC_HYBRID_ALG = 'X25519+ML-KEM-768';
export const PQC_ALGORITHMS: readonly string[] = [PQC_SIGN_ALG, PQC_KEM_ALG, PQC_HYBRID_ALG];

export type PqcSigningKeypair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type PqcKemKeypair = { publicKey: Uint8Array; secretKey: Uint8Array };

export function generateSigningKeypair(): PqcSigningKeypair {
  return ml_dsa65.keygen() as PqcSigningKeypair;
}

/** Derive the public key for JWKS publishing or fingerprinting. */
export function pqcGetPublicKey(secretKey: Uint8Array): Uint8Array {
  return ml_dsa65.getPublicKey(secretKey);
}

/** ML-DSA-65 over the raw message. Deterministic per key+message (hedged). */
export function pqcSign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ml_dsa65.sign(message, secretKey);
}

/**
 * Never throws on attacker-controlled input: a bad signature, a wrong key or
 * a truncated buffer all read as `false`. Only programmer errors (wrong
 * types) escape, and those fail closed upstream as verification failures.
 */
export function pqcVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ml_dsa65.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export function generateKemKeypair(): PqcKemKeypair {
  return ml_kem768.keygen() as PqcKemKeypair;
}

export function kemEncapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
  return ml_kem768.encapsulate(publicKey);
}

export function kemDecapsulate(secretKey: Uint8Array, cipherText: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(cipherText, secretKey);
}

/** Display fingerprint of a public key: SHA3-256 hex, no secret material. */
export function keyFingerprint(publicKey: Uint8Array): string {
  return Buffer.from(sha3_256(publicKey)).toString('hex');
}

/**
 * The long-lived data key behind at-rest encryption. Both halves travel
 * together because decryption needs both shared secrets; the whole bundle is
 * what `ORCH_PQC_DATA_KEY` carries (base64 of this JSON).
 */
export type PqcDataKey = {
  v: 1;
  mlKem: { publicKey: string; secretKey: string };
  x: { publicKey: string; secretKey: string };
};

export function generateDataKey(): PqcDataKey {
  const kem = generateKemKeypair();
  const xSecret = randomBytes(32);
  const xPublic = x25519.getPublicKey(xSecret);
  return {
    v: 1,
    mlKem: { publicKey: b64(kem.publicKey), secretKey: b64(kem.secretKey) },
    x: { publicKey: b64(xPublic), secretKey: b64(xSecret) }
  };
}

export function parseDataKey(raw: string): PqcDataKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  } catch {
    throw new Error('ORCH_PQC_DATA_KEY is not base64 of a JSON key bundle.');
  }
  // Every half is checked, not just the first one read: a bundle missing the
  // X25519 side would otherwise boot fine and crash the first sealed write
  // with a bare TypeError, months later, far from the actual mistake.
  const bundle = parsed as { v?: unknown; mlKem?: Record<string, unknown>; x?: Record<string, unknown> };
  const fields = [bundle.mlKem?.['publicKey'], bundle.mlKem?.['secretKey'], bundle.x?.['publicKey'], bundle.x?.['secretKey']];
  if (typeof parsed !== 'object' || parsed === null || bundle.v !== 1 || fields.some(f => typeof f !== 'string')) {
    throw new Error('ORCH_PQC_DATA_KEY is not a v1 key bundle.');
  }
  return parsed as PqcDataKey;
}

export type PqcEnvelope = {
  v: 1;
  alg: typeof PQC_HYBRID_ALG;
  /** ML-KEM-768 ciphertext, base64. */
  ct: string;
  /** Ephemeral X25519 public key, base64. */
  ek: string;
  nonce: string;
  box: string;
};

/**
 * Hybrid seal: an ephemeral X25519 share plus an ML-KEM-768 encapsulation,
 * combined with SHA3-256 over a domain-separated transcript, then
 * XChaCha20-Poly1305. An attacker with a quantum computer still faces the
 * lattice KEM; an attacker who breaks the lattice still faces X25519. Either
 * half alone reveals nothing.
 */
export function pqcSeal(dataKey: PqcDataKey, plaintext: Uint8Array): PqcEnvelope {
  const kemCt = kemEncapsulate(unb64(dataKey.mlKem.publicKey));
  const eSecret = randomBytes(32);
  const ePublic = x25519.getPublicKey(eSecret);
  const ssX = x25519.getSharedSecret(eSecret, unb64(dataKey.x.publicKey));
  const key = combineSecrets(ssX, kemCt.sharedSecret, kemCt.cipherText, ePublic);
  const nonce = randomBytes(24);
  const box = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return { v: 1, alg: PQC_HYBRID_ALG, ct: b64(kemCt.cipherText), ek: b64(ePublic), nonce: b64(nonce), box: b64(box) };
}

/** Throws on tamper or a wrong key — the AEAD tag is the integrity check. */
export function pqcOpen(dataKey: PqcDataKey, envelope: PqcEnvelope): Uint8Array {
  if (envelope.v !== 1 || envelope.alg !== PQC_HYBRID_ALG) {
    throw new Error(`Unsupported envelope ${envelope.v}/${envelope.alg}.`);
  }
  const ct = unb64(envelope.ct);
  const ssKem = kemDecapsulate(unb64(dataKey.mlKem.secretKey), ct);
  const ssX = x25519.getSharedSecret(unb64(dataKey.x.secretKey), unb64(envelope.ek));
  const key = combineSecrets(ssX, ssKem, ct, unb64(envelope.ek));
  return xchacha20poly1305(key, unb64(envelope.nonce)).decrypt(unb64(envelope.box));
}

function combineSecrets(ssX: Uint8Array, ssKem: Uint8Array, ctKem: Uint8Array, ek: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode('orchestrator-pqc-hybrid-v1');
  const transcript = Buffer.concat([Buffer.from(domain), Buffer.from(ssX), Buffer.from(ssKem), Buffer.from(ctKem), Buffer.from(ek)]);
  return sha3_256(transcript);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function unb64(raw: string): Uint8Array {
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

/**
 * Transparent at-rest envelopes. Rows written while `ORCH_PQC_DATA_KEY` is
 * set carry these; rows written before it stay plaintext and keep reading
 * back exactly as before — no migration, no rewrite, mixed tables work.
 * Reading an enveloped row without a configured key fails closed rather than
 * handing ciphertext back as content.
 */

/** Stored-text prefix for sealed artifact content. */
export const PQC_TEXT_PREFIX = 'pqc1.';

export function sealText(dataKey: PqcDataKey, text: string): string {
  const envelope = pqcSeal(dataKey, new TextEncoder().encode(text));
  return `${PQC_TEXT_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString('base64')}`;
}

export function openText(dataKey: PqcDataKey | undefined, stored: string): string {
  if (!stored.startsWith(PQC_TEXT_PREFIX)) return stored;
  if (dataKey === undefined) {
    throw new Error('This row is PQC-sealed but no ORCH_PQC_DATA_KEY is configured.');
  }
  const envelope = JSON.parse(Buffer.from(stored.slice(PQC_TEXT_PREFIX.length), 'base64').toString('utf8')) as PqcEnvelope;
  return new TextDecoder().decode(pqcOpen(dataKey, envelope));
}

/** Single-key wrapper for sealed memory values (which are arbitrary JSON). */
export const PQC_VALUE_MARKER = '__pqc_envelope_v1';

export function sealValue(dataKey: PqcDataKey, value: unknown): Record<string, string> {
  return { [PQC_VALUE_MARKER]: Buffer.from(JSON.stringify(pqcSeal(dataKey, new TextEncoder().encode(JSON.stringify(value ?? null))))).toString('base64') };
}

export function openValue(dataKey: PqcDataKey | undefined, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== PQC_VALUE_MARKER) return value;
  if (dataKey === undefined) {
    throw new Error('This row is PQC-sealed but no ORCH_PQC_DATA_KEY is configured.');
  }
  const envelope = JSON.parse(
    Buffer.from((value as Record<string, string>)[PQC_VALUE_MARKER] ?? '', 'base64').toString('utf8')
  ) as PqcEnvelope;
  return JSON.parse(new TextDecoder().decode(pqcOpen(dataKey, envelope))) as unknown;
}
