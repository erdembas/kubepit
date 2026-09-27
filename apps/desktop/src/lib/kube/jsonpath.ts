import { isObject } from './accessors';

/**
 * Minimal JSONPath evaluator for CRD `additionalPrinterColumns`:
 * `.spec.replicas`, `.status.conditions[0].type`,
 * `.status.conditions[?(@.type=="Ready")].status`, `.metadata.labels.app`.
 */
export function evalJsonPath(root: unknown, path: string): unknown {
  let rest = path
    .trim()
    .replace(/^\{|\}$/g, '')
    .replace(/^\$/, '');
  let current: unknown[] = [root];
  const token =
    /^\.([^.[]+)|^\[(\d+|\*)\]|^\[\?\(@\.([\w.-]+)\s*==\s*["']?([^"')]*)["']?\)\]|^\['([^']+)'\]/;
  while (rest.length) {
    const m = token.exec(rest);
    if (!m) return undefined;
    rest = rest.slice(m[0].length);
    const next: unknown[] = [];
    for (const value of current) {
      if (m[1] !== undefined || m[5] !== undefined) {
        const key = (m[1] ?? m[5])!;
        if (isObject(value) && key in value) next.push(value[key]);
      } else if (m[2] !== undefined) {
        if (!Array.isArray(value)) continue;
        if (m[2] === '*') next.push(...value);
        else if (value[Number(m[2])] !== undefined) next.push(value[Number(m[2])]);
      } else if (m[3] !== undefined) {
        if (!Array.isArray(value)) continue;
        const [fieldPath, expected] = [m[3], m[4] ?? ''];
        for (const item of value) {
          let v: unknown = item;
          for (const part of fieldPath.split('.')) v = isObject(v) ? v[part] : undefined;
          if (String(v) === expected) next.push(item);
        }
      }
    }
    current = next;
    if (!current.length) return undefined;
  }
  return current.length === 1 ? current[0] : current;
}

export function jsonPathText(root: unknown, path: string): string {
  const value = evalJsonPath(root, path);
  if (value === undefined || value === null) return '';
  if (Array.isArray(value))
    return value.map((v) => (isObject(v) ? JSON.stringify(v) : String(v))).join(', ');
  if (isObject(value)) return JSON.stringify(value);
  return String(value);
}
