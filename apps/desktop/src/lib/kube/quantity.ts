/**
 * Kubernetes resource.Quantity parsing (`250m`, `1.5`, `512Mi`, `1e9`, `2G`).
 */

const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** Parse to a plain number in base units (cores for CPU, bytes for memory). */
export function parseQuantity(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const m = /^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([a-zA-Z]{0,2})$/.exec(value.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return 0;
  const suffix = m[2] ?? '';
  if (suffix in BINARY) return num * BINARY[suffix]!;
  if (suffix in DECIMAL) return num * DECIMAL[suffix]!;
  return num;
}

export function cpuMillicores(value: unknown): number {
  return Math.round(parseQuantity(value) * 1000);
}

export function memoryBytes(value: unknown): number {
  return parseQuantity(value);
}
