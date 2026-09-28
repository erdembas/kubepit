import type { LocalFile } from '@/types';
import { sleep } from './bus';
import { register, type MockArgs } from './registry';

/**
 * Local files for the resource wizards in browser previews. The pickers
 * (`components/workbench/wizards/files.ts`) hand out paths in a fictional
 * home folder and `local_file_read` serves fixture content for them.
 *
 * No key material ships with the demo: the TLS certificate and its private
 * key are generated with WebCrypto on first use (a throwaway ECDSA P-256
 * pair, self-signed), and the SSH key is random bytes in OpenSSH framing.
 */

const encoder = new TextEncoder();

function concat(parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// -- A tiny DER writer for one self-signed certificate ---------------------------

function tlv(tag: number, content: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const n = content.length;
  const len: number[] = [];
  if (n < 0x80) len.push(n);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    len.push(0x80 | bytes.length, ...bytes);
  }
  return concat([[tag], len, content]);
}
const seq = (...parts: ArrayLike<number>[]) => tlv(0x30, concat(parts));
const set = (...parts: ArrayLike<number>[]) => tlv(0x31, concat(parts));

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, out);
}

function integer(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0]! & 0x80 ? concat([[0], trimmed]) : trimmed);
}

function utcTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const text = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return tlv(0x17, encoder.encode(text));
}

const commonName = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, encoder.encode(cn)))));

function pem(label: string, der: Uint8Array): string {
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const body = btoa(binary).replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

const DAY = 86_400_000;
const HOST = 'shop.demo.example';

async function generateTls(): Promise<{ cert: string; key: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f;
  const now = Date.now();
  const sans = seq(tlv(0x82, encoder.encode(HOST)), tlv(0x82, encoder.encode(`*.${HOST}`)));
  const tbs = seq(
    tlv(0xa0, integer(new Uint8Array([2]))),
    integer(serial),
    ecdsaSha256,
    commonName('Kubepit Demo CA'),
    seq(utcTime(now - 10 * DAY), utcTime(now + 80 * DAY)),
    commonName(HOST),
    spki,
    tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, sans)))),
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, tbs),
  );
  const signature = seq(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  const cert = seq(tbs, ecdsaSha256, tlv(0x03, concat([[0], signature])));
  return { cert: pem('CERTIFICATE', cert), key: pem('PRIVATE KEY', pkcs8) };
}

let tls: Promise<{ cert: string; key: string }> | null = null;

function sshKey(): string {
  const body = concat([
    encoder.encode('openssh-key-v1\0'),
    crypto.getRandomValues(new Uint8Array(360)),
  ]);
  return pem('OPENSSH PRIVATE KEY', body);
}

function png(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return concat([signature, crypto.getRandomValues(new Uint8Array(2040))]);
}

const TEXT: Record<string, string> = {
  '.env': [
    '# Storefront settings (demo)',
    'LOG_LEVEL=info',
    'FEATURE_CHECKOUT_V2=true',
    'API_BASE_URL="https://api.shop.demo.example"',
    'CACHE_TTL=300 # seconds',
    'export REGION=eu-west-1',
    "GREETING='Hello, world'",
    'this line is not a variable',
    '',
  ].join('\n'),
  'app.properties': [
    'server.port=8080',
    'feature.recommendations=true',
    'cache.ttl=300',
    'payments.provider=demo',
    '',
  ].join('\n'),
  'nginx.conf': [
    'server {',
    '  listen 8080;',
    '  location / {',
    '    root /usr/share/nginx/html;',
    '    try_files $uri /index.html;',
    '  }',
    '}',
    '',
  ].join('\n'),
  known_hosts: [
    'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
    '',
  ].join('\n'),
};

async function contentFor(name: string): Promise<Uint8Array | null> {
  if (name in TEXT) return encoder.encode(TEXT[name]!);
  if (name.endsWith('.crt') || name.endsWith('.key')) {
    tls ??= generateTls();
    const pair = await tls;
    return encoder.encode(name.endsWith('.crt') ? pair.cert : pair.key);
  }
  if (name.startsWith('deploy_')) return encoder.encode(sshKey());
  if (name.endsWith('.png')) return png();
  return null;
}

register({
  local_file_read: async ({ path }: MockArgs): Promise<LocalFile> => {
    await sleep(80);
    const full = String(path);
    const name = full.split(/[\\/]/).pop() ?? full;
    const bytes = await contentFor(name);
    if (!bytes) throw new Error(`cannot read ${full}: No such file or directory (os error 2)`);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    let utf8 = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      utf8 = false;
    }
    return { path: full, name, size: bytes.length, utf8, base64: btoa(binary) };
  },
});
