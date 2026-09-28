import * as i18n from '@/i18n/core';
import { parsePemBundle, type X509Certificate } from '../x509';

/**
 * `kubectl create secret tls` checks, locally: the certificate chain
 * parses (via `x509.ts`), the private key parses, and the key belongs to
 * the leaf certificate. The key is only read to compare its public part
 * with the certificate's; nothing about it is shown, stored or logged.
 *
 * Supported keys: PKCS#1 (`RSA PRIVATE KEY`), SEC1 (`EC PRIVATE KEY`) and
 * PKCS#8 (`PRIVATE KEY`) with RSA, ECDSA or Ed25519. EC and Ed25519 keys
 * are compared through the public key they embed (OpenSSL always writes
 * it); without one the match stays unknown.
 */

// -- Minimal DER reader --------------------------------------------------------

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function readTlv(der: Uint8Array, offset: number, limit = der.length): Tlv {
  if (offset + 2 > limit) throw new Error('truncated');
  const tag = der[offset]!;
  let len = der[offset + 1]!;
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= limit) throw new Error('truncated');
      len = len * 256 + der[pos++]!;
    }
  }
  if (pos + len > limit) throw new Error('truncated');
  return { tag, start: pos, end: pos + len };
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.start;
  while (pos < parent.end) {
    const t = readTlv(der, pos, parent.end);
    out.push(t);
    pos = t.end;
  }
  return out;
}

function expect(t: Tlv | undefined, tag: number): Tlv {
  if (!t || t.tag !== tag) throw new Error(`expected tag ${tag}`);
  return t;
}

function oid(der: Uint8Array, t: Tlv): string {
  const parts: number[] = [];
  let value = 0;
  for (let i = t.start; i < t.end; i++) {
    const b = der[i]!;
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      if (!parts.length) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        parts.push(first, value - first * 40);
      } else parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/** INTEGER bytes without leading zero octets, as hex. */
function integerHex(der: Uint8Array, t: Tlv): string {
  let i = t.start;
  while (i < t.end - 1 && der[i] === 0) i++;
  return hex(der.subarray(i, t.end));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** BIT STRING content without the unused-bits octet. */
function bitString(der: Uint8Array, t: Tlv): Uint8Array {
  return der.subarray(t.start + 1, t.end);
}

// -- Public keys ------------------------------------------------------------------

const RSA = '1.2.840.113549.1.1.1';
const RSA_PSS = '1.2.840.113549.1.1.10';
const EC = '1.2.840.10045.2.1';
const ED25519 = '1.3.101.112';

export type KeyAlgorithm = 'RSA' | 'EC' | 'Ed25519';

/** Comparable public part of a key pair. */
interface PublicPart {
  algorithm: KeyAlgorithm;
  /** RSA `n:e`, EC `curve:point`, Ed25519 public key; null when unknown. */
  fingerprint: string | null;
}

function rsaPublic(der: Uint8Array, seq: Tlv): string {
  const [n, e] = children(der, expect(seq, 0x30));
  return `${integerHex(der, expect(n, 0x02))}:${integerHex(der, expect(e, 0x02))}`;
}

/** SubjectPublicKeyInfo → comparable public part. */
function spkiPublic(der: Uint8Array, spki: Tlv): PublicPart | null {
  const [alg, bits] = children(der, expect(spki, 0x30));
  const [algOid, params] = children(der, expect(alg, 0x30));
  const id = oid(der, expect(algOid, 0x06));
  const key = bitString(der, expect(bits, 0x03));
  if (id === RSA || id === RSA_PSS) {
    const inner = readTlv(key, 0);
    return { algorithm: 'RSA', fingerprint: rsaPublic(key, inner) };
  }
  if (id === EC) {
    const curve = params?.tag === 0x06 ? oid(der, params) : '';
    return { algorithm: 'EC', fingerprint: `${curve}:${hex(key)}` };
  }
  if (id === ED25519) return { algorithm: 'Ed25519', fingerprint: hex(key) };
  return null;
}

/** Leaf-first SPKI public parts of every certificate in a PEM bundle. */
function certificatePublics(pem: string): Array<PublicPart | null> {
  const out: Array<PublicPart | null> = [];
  for (const m of pem.matchAll(PEM_CERT)) {
    const der = base64Der(m[1] ?? '');
    try {
      if (!der) throw new Error('bad base64');
      const cert = readTlv(der, 0);
      const [tbs] = children(der, expect(cert, 0x30));
      const fields = children(der, expect(tbs, 0x30));
      const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
      // serial, signature, issuer, validity, subject, then the SPKI.
      out.push(spkiPublic(der, expect(fields[offset + 5], 0x30)));
    } catch {
      out.push(null);
    }
  }
  return out;
}

// -- Private keys ---------------------------------------------------------------

const PEM_CERT =
  /-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g;
const PEM_KEY =
  /-----BEGIN ((?:RSA |EC |ENCRYPTED |OPENSSH |DSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;

function base64Der(body: string): Uint8Array | null {
  try {
    const binary = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface ParsedKey extends PublicPart {
  /** RSA modulus size in bits; curve name for EC. */
  detail: string;
}

const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

function rsaPrivate(der: Uint8Array, seq: Tlv): ParsedKey {
  const [, n, e] = children(der, expect(seq, 0x30));
  const modulus = expect(n, 0x02);
  let i = modulus.start;
  while (i < modulus.end && der[i] === 0) i++;
  const bits = (modulus.end - i - 1) * 8 + (32 - Math.clz32(der[i] ?? 0));
  return {
    algorithm: 'RSA',
    fingerprint: `${integerHex(der, modulus)}:${integerHex(der, expect(e, 0x02))}`,
    detail: `RSA ${bits}`,
  };
}

/** SEC1 ECPrivateKey; `curve` comes from PKCS#8 parameters when present. */
function ecPrivate(der: Uint8Array, seq: Tlv, curve: string): ParsedKey {
  const parts = children(der, expect(seq, 0x30));
  let named = curve;
  let point: Uint8Array | null = null;
  for (const p of parts.slice(2)) {
    if (p.tag === 0xa0) {
      const inner = readTlv(der, p.start, p.end);
      if (inner.tag === 0x06) named = oid(der, inner);
    } else if (p.tag === 0xa1) {
      point = bitString(der, expect(readTlv(der, p.start, p.end), 0x03));
    }
  }
  return {
    algorithm: 'EC',
    fingerprint: point ? `${named}:${hex(point)}` : null,
    detail: `ECDSA ${CURVES[named] ?? named}`.trim(),
  };
}

function pkcs8Private(der: Uint8Array, seq: Tlv): ParsedKey {
  const parts = children(der, expect(seq, 0x30));
  const [algOid, params] = children(der, expect(parts[1], 0x30));
  const id = oid(der, expect(algOid, 0x06));
  const octets = expect(parts[2], 0x04);
  const inner = der.subarray(octets.start, octets.end);
  if (id === RSA || id === RSA_PSS) return rsaPrivate(inner, readTlv(inner, 0));
  if (id === EC) {
    const curve = params?.tag === 0x06 ? oid(der, params) : '';
    return ecPrivate(inner, readTlv(inner, 0), curve);
  }
  if (id === ED25519) {
    // OneAsymmetricKey v2 may carry the public key as [1].
    const pub = parts.slice(3).find((p) => p.tag === 0x81);
    return {
      algorithm: 'Ed25519',
      fingerprint: pub ? hex(der.subarray(pub.start + 1, pub.end)) : null,
      detail: 'Ed25519',
    };
  }
  throw new UnsupportedKey();
}

class UnsupportedKey extends Error {}

export type KeyParse = { ok: true; key: ParsedKey } | { ok: false; error: string };

/** Parses the first private key block of `pem`. Error messages never quote the key. */
export function parsePrivateKey(pem: string): KeyParse {
  if (!pem.trim()) return { ok: false, error: i18n.t('No private key yet.') };
  const m = PEM_KEY.exec(pem);
  if (!m) return { ok: false, error: i18n.t('No PEM private key block found.') };
  const type = m[1]!;
  const body = m[2] ?? '';
  if (type.startsWith('ENCRYPTED') || /Proc-Type:\s*4,ENCRYPTED/.test(body))
    return {
      ok: false,
      error: i18n.t('The key is encrypted; Kubernetes needs an unencrypted key.'),
    };
  if (type.startsWith('OPENSSH') || type.startsWith('DSA'))
    return { ok: false, error: i18n.t('Use an RSA, ECDSA or Ed25519 key in PEM format.') };
  const der = base64Der(body);
  try {
    if (!der) throw new Error('bad base64');
    const seq = readTlv(der, 0);
    if (type === 'RSA PRIVATE KEY') return { ok: true, key: rsaPrivate(der, seq) };
    if (type === 'EC PRIVATE KEY') return { ok: true, key: ecPrivate(der, seq, '') };
    return { ok: true, key: pkcs8Private(der, seq) };
  } catch (err) {
    if (err instanceof UnsupportedKey)
      return { ok: false, error: i18n.t('Use an RSA, ECDSA or Ed25519 key in PEM format.') };
    return { ok: false, error: i18n.t('The private key could not be parsed.') };
  }
}

// -- Pair check -------------------------------------------------------------------

export type KeyMatch = 'match' | 'mismatch' | 'unknown';

export interface TlsCheck {
  certs: X509Certificate[];
  /** Blocking problem with the certificate input. */
  certError: string | null;
  key: ParsedKey | null;
  keyError: string | null;
  /** Null until both parse. */
  match: KeyMatch | null;
  /** 1-based index of the certificate the key belongs to, when it is not the first. */
  matchesIndex: number | null;
}

export function checkTlsPair(certPem: string, keyPem: string): TlsCheck {
  const bundle = certPem.trim() ? parsePemBundle(certPem) : { certs: [], invalid: 0 };
  let certError: string | null = null;
  if (!certPem.trim()) certError = i18n.t('No certificate yet.');
  else if (!bundle.certs.length && !bundle.invalid)
    certError = i18n.t('No PEM certificate block found.');
  else if (bundle.invalid) certError = i18n.t('A certificate block could not be parsed.');
  const parsed = parsePrivateKey(keyPem);
  const key = parsed.ok ? parsed.key : null;
  const out: TlsCheck = {
    certs: bundle.certs,
    certError,
    key,
    keyError: parsed.ok ? null : parsed.error,
    match: null,
    matchesIndex: null,
  };
  if (certError || !key) return out;
  const publics = certificatePublics(certPem);
  const leaf = publics[0];
  if (!leaf || !key.fingerprint || !leaf.fingerprint) {
    out.match = leaf && leaf.algorithm !== key.algorithm ? 'mismatch' : 'unknown';
    return out;
  }
  if (leaf.algorithm === key.algorithm && leaf.fingerprint === key.fingerprint) {
    out.match = 'match';
    return out;
  }
  out.match = 'mismatch';
  const other = publics.findIndex(
    (p, i) => i > 0 && p?.algorithm === key.algorithm && p.fingerprint === key.fingerprint,
  );
  if (other > 0) out.matchesIndex = other + 1;
  return out;
}
