import type { Protocol } from './model';

/**
 * Port sets: sorted, merged inclusive ranges per protocol. Rules allow
 * port sets, sides union them, a connection intersects both sides.
 */

export type PortRange = readonly [number, number];
export type PortSet = Readonly<Record<Protocol, readonly PortRange[]>>;

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const FULL: readonly PortRange[] = [[MIN_PORT, MAX_PORT]];

export const NO_PORTS: PortSet = { TCP: [], UDP: [], SCTP: [] };
export const ALL_PORTS: PortSet = { TCP: FULL, UDP: FULL, SCTP: FULL };

const PROTOS: readonly Protocol[] = ['TCP', 'UDP', 'SCTP'];

function merge(ranges: readonly PortRange[]): PortRange[] {
  const sorted = ranges
    .map(([a, b]) => [Math.max(MIN_PORT, a), Math.min(MAX_PORT, b)] as const)
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function portSet(entries: Partial<Record<Protocol, readonly PortRange[]>>): PortSet {
  return {
    TCP: merge(entries.TCP ?? []),
    UDP: merge(entries.UDP ?? []),
    SCTP: merge(entries.SCTP ?? []),
  };
}

export function unionPorts(a: PortSet, b: PortSet): PortSet {
  if (a === ALL_PORTS || b === ALL_PORTS) return ALL_PORTS;
  if (isEmptyPorts(a)) return b;
  if (isEmptyPorts(b)) return a;
  return {
    TCP: merge([...a.TCP, ...b.TCP]),
    UDP: merge([...a.UDP, ...b.UDP]),
    SCTP: merge([...a.SCTP, ...b.SCTP]),
  };
}

function intersectRanges(a: readonly PortRange[], b: readonly PortRange[]): PortRange[] {
  const out: PortRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]);
    const hi = Math.min(a[i]![1], b[j]![1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

export function intersectPorts(a: PortSet, b: PortSet): PortSet {
  if (a === ALL_PORTS) return b;
  if (b === ALL_PORTS) return a;
  return {
    TCP: intersectRanges(a.TCP, b.TCP),
    UDP: intersectRanges(a.UDP, b.UDP),
    SCTP: intersectRanges(a.SCTP, b.SCTP),
  };
}

export function hasPort(set: PortSet, protocol: Protocol, port: number): boolean {
  return set[protocol].some(([a, b]) => a <= port && port <= b);
}

export function isEmptyPorts(set: PortSet): boolean {
  return PROTOS.every((p) => set[p].length === 0);
}

export function isAllPorts(set: PortSet): boolean {
  return PROTOS.every(
    (p) => set[p].length === 1 && set[p][0]![0] === MIN_PORT && set[p][0]![1] === MAX_PORT,
  );
}

/** Every port of one protocol is in the set. */
export function isAllOf(set: PortSet, protocol: Protocol): boolean {
  const r = set[protocol];
  return r.length === 1 && r[0]![0] === MIN_PORT && r[0]![1] === MAX_PORT;
}

/** Stable text for signatures and tests: `TCP:80,8000-8080 UDP:53`. */
export function portsKey(set: PortSet): string {
  return PROTOS.map((p) => `${p}:${set[p].map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',')}`)
    .filter((s) => !s.endsWith(':'))
    .join(' ');
}

/** Ranges of the set per protocol, protocols without ports omitted. */
export function portEntries(set: PortSet): Array<[Protocol, readonly PortRange[]]> {
  return PROTOS.filter((p) => set[p].length > 0).map((p) => [p, set[p]]);
}
