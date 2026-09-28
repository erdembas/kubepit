/**
 * IPv4 / IPv6 addresses and CIDR ranges as BigInt intervals (pure, no
 * dependencies). Used for `ipBlock` peers and external endpoints.
 */

export interface IpRange {
  v: 4 | 6;
  start: bigint;
  end: bigint;
}

const V4_BITS = 32n;
const V6_BITS = 128n;

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(text: string): bigint | null {
  let s = text;
  // Zone ids (fe80::1%eth0) never appear in policies; reject them.
  if (s.includes('%')) return null;
  let tail: bigint[] = [];
  // Embedded IPv4 (::ffff:10.0.0.1).
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >> 16n) & 0xffffn, v4 & 0xffffn];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const group = (g: string) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? BigInt(`0x${g}`) : null);
  const parse = (part: string) => (part === '' ? [] : part.split(':').map(group));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (head.some((g) => g === null) || rest.some((g) => g === null)) return null;
  let groups: bigint[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...(head as bigint[]), ...Array<bigint>(missing).fill(0n), ...(rest as bigint[])];
  } else {
    if (head.length !== 8) return null;
    groups = head as bigint[];
  }
  if (tail.length) groups.splice(6, 2, ...tail);
  let n = 0n;
  for (const g of groups) n = (n << 16n) | g;
  return n;
}

/** A single address (`10.0.0.1`, `2001:db8::1`). */
export function parseIp(text: string): { v: 4 | 6; n: bigint } | null {
  const s = text.trim();
  if (!s) return null;
  if (s.includes(':')) {
    const n = parseV6(s);
    return n === null ? null : { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

/**
 * A CIDR (`10.0.0.0/8`) or a single address (a /32 or /128). Host bits
 * are masked, like the API server's validation would require.
 */
export function parseCidr(text: string): IpRange | null {
  const s = text.trim();
  const slash = s.indexOf('/');
  const ip = parseIp(slash < 0 ? s : s.slice(0, slash));
  if (!ip) return null;
  const bits = ip.v === 4 ? V4_BITS : V6_BITS;
  let prefix = bits;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = BigInt(Number(p));
    if (prefix > bits) return null;
  }
  const hostBits = bits - prefix;
  const mask = (1n << hostBits) - 1n;
  const start = ip.n & ~mask & ((1n << bits) - 1n);
  return { v: ip.v, start, end: start | mask };
}

export function rangeContains(outer: IpRange, inner: IpRange): boolean {
  return outer.v === inner.v && outer.start <= inner.start && inner.end <= outer.end;
}

export function rangeOverlaps(a: IpRange, b: IpRange): boolean {
  return a.v === b.v && a.start <= b.end && b.start <= a.end;
}

export function ipInRange(ip: string, range: IpRange): boolean {
  const addr = parseIp(ip);
  return !!addr && addr.v === range.v && range.start <= addr.n && addr.n <= range.end;
}

export function rangeSize(r: IpRange): bigint {
  return r.end - r.start + 1n;
}

function formatV4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 0xffn)).join('.');
}

function formatV6(n: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  // Longest run of zero groups (≥ 2) collapses to `::`.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  const left = hex.slice(0, best).join(':');
  const right = hex.slice(best + bestLen).join(':');
  return `${left}::${right}`;
}

export function formatIp(v: 4 | 6, n: bigint): string {
  return v === 4 ? formatV4(n) : formatV6(n);
}

/** `10.0.0.0/8` when the range is a CIDR block, else `start – end`. */
export function formatRange(r: IpRange): string {
  const bits = r.v === 4 ? V4_BITS : V6_BITS;
  const size = rangeSize(r);
  let host = 0n;
  while (1n << host < size) host++;
  if (1n << host === size && (r.start & ((1n << host) - 1n)) === 0n)
    return host === 0n ? formatIp(r.v, r.start) : `${formatIp(r.v, r.start)}/${bits - host}`;
  return `${formatIp(r.v, r.start)} – ${formatIp(r.v, r.end)}`;
}

/**
 * Split `range` at every boundary of `cuts` so each piece lies entirely
 * inside or outside every cut: all addresses of a piece behave alike for
 * ipBlock matching.
 */
export function splitRange(range: IpRange, cuts: readonly IpRange[]): IpRange[] {
  const points = new Set<bigint>([range.start]);
  for (const c of cuts) {
    if (!rangeOverlaps(range, c)) continue;
    if (c.start > range.start) points.add(c.start);
    if (c.end < range.end) points.add(c.end + 1n);
  }
  const sorted = [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map((start, i) => ({
    v: range.v,
    start,
    end: i + 1 < sorted.length ? sorted[i + 1]! - 1n : range.end,
  }));
}
