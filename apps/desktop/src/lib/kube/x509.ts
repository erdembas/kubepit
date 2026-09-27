import type { KubeObject } from '@/types';
import { asObject, field } from './accessors';

/**
 * Minimal, dependency-free X.509 reader (PEM / DER) for certificate
 * insight: names, SANs, validity, serial, algorithms and CA flag. It only
 * *reads* certificates — signatures are never verified — and it never
 * touches private keys: keys and blocks other than `CERTIFICATE` are skipped.
 */

export interface X509Name {
  cn: string;
  o: string;
  /** RFC 4514-ish rendering, most significant RDN first (`CN=…, O=…`). */
  dn: string;
}

export interface X509Certificate {
  subject: X509Name;
  issuer: X509Name;
  /** DNS names, IP addresses, e-mails and URIs of the SAN extension. */
  sans: string[];
  /** Epoch milliseconds. */
  notBefore: number;
  notAfter: number;
  /** Colon-separated upper-case hex. */
  serial: string;
  signatureAlgorithm: string;
  /** `RSA 2048`, `ECDSA P-256`, `Ed25519`… */
  keyAlgorithm: string;
  isCA: boolean;
  selfSigned: boolean;
}

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** Absolute offset of the value. */
  start: number;
  end: number;
}

class DerError extends Error {}

function readTlv(der: Uint8Array, offset: number, limit = der.length): Tlv {
  if (offset + 2 > limit) throw new DerError('truncated');
  const tag = der[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError('high tag numbers are not supported');
  let len = der[offset + 1]!;
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError('unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= limit) throw new DerError('truncated');
      len = len * 256 + der[pos++]!;
    }
  }
  if (pos + len > limit) throw new DerError('truncated');
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

function required(t: Tlv | undefined): Tlv {
  if (!t) throw new DerError('truncated');
  return t;
}

function expect(t: Tlv | undefined, tag: number): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}`);
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

const latin1 = (der: Uint8Array, t: Tlv) => String.fromCharCode(...der.subarray(t.start, t.end));

function text(der: Uint8Array, t: Tlv): string {
  const bytes = der.subarray(t.start, t.end);
  switch (t.tag) {
    case 0x0c: // UTF8String
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    case 0x1e: {
      // BMPString (UTF-16BE)
      let s = '';
      for (let i = 0; i + 1 < bytes.length; i += 2)
        s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
      return s;
    }
    case 0x1c: {
      // UniversalString (UTF-32BE)
      let s = '';
      for (let i = 0; i + 3 < bytes.length; i += 4)
        s += String.fromCodePoint(
          ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0,
        );
      return s;
    }
    default: // PrintableString, IA5String, T61String, NumericString, VisibleString
      return latin1(der, t);
  }
}

function time(der: Uint8Array, t: Tlv): number {
  const s = latin1(der, t);
  let m: RegExpExecArray | null;
  if (t.tag === 0x17) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
    if (!m) throw new DerError('bad UTCTime');
    const yy = Number(m[1]);
    return Date.UTC(
      yy >= 50 ? 1900 + yy : 2000 + yy,
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0),
    );
  }
  if (t.tag === 0x18) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
    if (!m) throw new DerError('bad GeneralizedTime');
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0),
    );
  }
  throw new DerError('expected a time');
}

const NAME_ATTRS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.5': 'SERIALNUMBER',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
  '1.2.840.113549.1.9.1': 'emailAddress',
};

function name(der: Uint8Array, t: Tlv): X509Name {
  const rdns: Array<[string, string]> = [];
  for (const set of children(der, expect(t, 0x30))) {
    for (const atv of children(der, set)) {
      const [type, value] = children(der, atv);
      if (!type || !value) continue;
      const id = oid(der, expect(type, 0x06));
      rdns.push([NAME_ATTRS[id] ?? id, text(der, value)]);
    }
  }
  const first = (key: string) => rdns.find(([k]) => k === key)?.[1] ?? '';
  return {
    cn: first('CN'),
    o: rdns
      .filter(([k]) => k === 'O')
      .map(([, v]) => v)
      .join(', '),
    dn: [...rdns]
      .reverse()
      .map(([k, v]) => `${k}=${v}`)
      .join(', '),
  };
}

const SIGNATURES: Record<string, string> = {
  '1.2.840.113549.1.1.4': 'MD5 with RSA',
  '1.2.840.113549.1.1.5': 'SHA-1 with RSA',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'SHA-256 with RSA',
  '1.2.840.113549.1.1.12': 'SHA-384 with RSA',
  '1.2.840.113549.1.1.13': 'SHA-512 with RSA',
  '1.2.840.10045.4.1': 'ECDSA with SHA-1',
  '1.2.840.10045.4.3.2': 'ECDSA with SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
};

const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
  '1.3.132.0.10': 'secp256k1',
};

/** Bit length of a DER INTEGER (leading zero octets ignored). */
function integerBits(der: Uint8Array, t: Tlv): number {
  let i = t.start;
  while (i < t.end && der[i] === 0) i++;
  if (i >= t.end) return 0;
  return (t.end - i - 1) * 8 + (32 - Math.clz32(der[i]!));
}

function keyAlgorithm(der: Uint8Array, spki: Tlv): string {
  const [alg, bits] = children(der, expect(spki, 0x30));
  const [algOid, params] = children(der, expect(alg, 0x30));
  const id = oid(der, expect(algOid, 0x06));
  if (id === '1.2.840.113549.1.1.1' || id === '1.2.840.113549.1.1.10') {
    try {
      const bs = expect(bits, 0x03);
      // BIT STRING: first octet is the unused-bits count, then RSAPublicKey.
      const inner = readTlv(der, bs.start + 1, bs.end);
      const [modulus] = children(der, expect(inner, 0x30));
      return `RSA ${integerBits(der, expect(modulus, 0x02))}`;
    } catch {
      return 'RSA';
    }
  }
  if (id === '1.2.840.10045.2.1') {
    const curve = params?.tag === 0x06 ? oid(der, params) : '';
    return `ECDSA ${CURVES[curve] ?? curve}`.trim();
  }
  if (id === '1.3.101.112') return 'Ed25519';
  if (id === '1.3.101.113') return 'Ed448';
  if (id === '1.2.840.10040.4.1') return 'DSA';
  return id;
}

function ipText(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join('.');
  if (bytes.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
    return groups.join(':');
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extensions(der: Uint8Array, t: Tlv) {
  const out = { sans: [] as string[], isCA: false };
  const seq = readTlv(der, t.start, t.end);
  for (const ext of children(der, expect(seq, 0x30))) {
    const parts = children(der, ext);
    const id = oid(der, expect(parts[0], 0x06));
    const value = parts[parts.length - 1];
    if (!value || value.tag !== 0x04) continue;
    try {
      const inner = readTlv(der, value.start, value.end);
      if (id === '2.5.29.17') {
        for (const gn of children(der, expect(inner, 0x30))) {
          const bytes = der.subarray(gn.start, gn.end);
          if (gn.tag === 0x82 || gn.tag === 0x81 || gn.tag === 0x86) out.sans.push(latin1(der, gn));
          else if (gn.tag === 0x87) out.sans.push(ipText(bytes));
        }
      } else if (id === '2.5.29.19') {
        const first = children(der, expect(inner, 0x30))[0];
        out.isCA = first?.tag === 0x01 && der[first.start] !== 0;
      }
    } catch {
      /* A malformed extension does not hide the rest of the certificate. */
    }
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return [...bytes.subarray(start)]
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/** Parses one DER certificate; throws on malformed input. */
export function parseDer(der: Uint8Array): X509Certificate {
  const cert = readTlv(der, 0);
  const [tbs, sigAlg] = children(der, expect(cert, 0x30));
  const fields = children(der, expect(tbs, 0x30));
  let i = 0;
  if (fields[0]?.tag === 0xa0) i++; // [0] EXPLICIT version
  const serial = expect(fields[i++], 0x02);
  i++; // signature AlgorithmIdentifier (repeated outside the TBS)
  const issuer = name(der, expect(fields[i++], 0x30));
  const [nb, na] = children(der, expect(fields[i++], 0x30));
  const subject = name(der, expect(fields[i++], 0x30));
  const spki = expect(fields[i++], 0x30);
  const ext = fields.slice(i).find((f) => f.tag === 0xa3);
  const { sans, isCA } = ext ? extensions(der, ext) : { sans: [], isCA: false };
  const sigOid = oid(der, expect(children(der, expect(sigAlg, 0x30))[0], 0x06));
  return {
    subject,
    issuer,
    sans,
    notBefore: time(der, required(nb)),
    notAfter: time(der, required(na)),
    serial: hex(der.subarray(serial.start, serial.end)),
    signatureAlgorithm: SIGNATURES[sigOid] ?? sigOid,
    keyAlgorithm: keyAlgorithm(der, spki),
    isCA,
    selfSigned: subject.dn === issuer.dn,
  };
}

// ---------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------

const PEM_CERT =
  /-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g;

function base64Bytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface CertificateBundle {
  certs: X509Certificate[];
  /** Blocks that looked like certificates but did not parse. */
  invalid: number;
}

export function looksLikePem(text: string): boolean {
  return text.includes('-----BEGIN') && /CERTIFICATE-----/.test(text);
}

/** Every `CERTIFICATE` block of a PEM bundle, in order. Other blocks (keys) are ignored. */
export function parsePemBundle(pem: string, limit = 64): CertificateBundle {
  const out: CertificateBundle = { certs: [], invalid: 0 };
  for (const m of pem.matchAll(PEM_CERT)) {
    if (out.certs.length + out.invalid >= limit) break;
    const der = base64Bytes(m[1] ?? '');
    try {
      if (!der) throw new DerError('bad base64');
      out.certs.push(parseDer(der));
    } catch {
      out.invalid++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'not-yet-valid';

export interface Expiry {
  state: ExpiryState;
  /** Whole days until `notAfter` (negative once expired). */
  daysLeft: number;
}

export function certificateExpiry(
  cert: Pick<X509Certificate, 'notBefore' | 'notAfter'>,
  now = Date.now(),
): Expiry {
  const daysLeft = Math.floor((cert.notAfter - now) / DAY_MS);
  if (cert.notAfter <= now) return { state: 'expired', daysLeft };
  if (cert.notBefore > now) return { state: 'not-yet-valid', daysLeft };
  if (cert.notAfter - now <= EXPIRY_WARNING_DAYS * DAY_MS) return { state: 'expiring', daysLeft };
  return { state: 'valid', daysLeft };
}

// ---------------------------------------------------------------------------
// Secrets and ConfigMaps
// ---------------------------------------------------------------------------

export interface DataCertificates {
  /** Data key, e.g. `tls.crt`. */
  key: string;
  certs: X509Certificate[];
  invalid: number;
}

const CERT_KEY = /(^|[._-])(crt|cert|pem|ca|certificate)$|^ca-bundle|\.(crt|pem|cer)$/i;
const KEY_KEY = /(^|[._-])key$|private/i;
const MAX_VALUE = 256 * 1024;

function decodeBase64Text(value: string): string {
  const bytes = base64Bytes(value);
  return bytes ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : '';
}

const cache = new WeakMap<KubeObject, DataCertificates[]>();

/**
 * Certificates held by a Secret (`kubernetes.io/tls` or any PEM `*.crt` /
 * `ca.crt` key) or ConfigMap (`kube-root-ca.crt`, CA bundles). Keys that
 * hold private keys are never decoded. Memoized per object snapshot.
 */
export function objectCertificates(obj: KubeObject): DataCertificates[] {
  const hit = cache.get(obj);
  if (hit) return hit;
  const out: DataCertificates[] = [];
  const secret = obj.kind === 'Secret';
  if (secret || obj.kind === 'ConfigMap') {
    const tls = secret && field(obj, 'type') === 'kubernetes.io/tls';
    const data = asObject(field(obj, 'data'));
    const keys = Object.keys(data).sort((a, b) =>
      a === 'tls.crt' ? -1 : b === 'tls.crt' ? 1 : a.localeCompare(b),
    );
    for (const key of keys) {
      const raw = data[key];
      if (typeof raw !== 'string' || raw.length > MAX_VALUE || KEY_KEY.test(key)) continue;
      if (!CERT_KEY.test(key) && !(tls && key === 'tls.crt')) continue;
      const text = secret ? decodeBase64Text(raw) : raw;
      if (!looksLikePem(text)) continue;
      const bundle = parsePemBundle(text);
      if (bundle.certs.length || bundle.invalid) out.push({ key, ...bundle });
    }
  }
  cache.set(obj, out);
  return out;
}

/** Earliest `notAfter` of every certificate an object holds, or `null`. */
export function earliestNotAfter(obj: KubeObject): X509Certificate | null {
  let soonest: X509Certificate | null = null;
  for (const entry of objectCertificates(obj))
    for (const c of entry.certs) if (!soonest || c.notAfter < soonest.notAfter) soonest = c;
  return soonest;
}
