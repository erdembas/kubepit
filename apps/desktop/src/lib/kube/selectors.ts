import { asArray, asObject, asString, asStringMap, isObject } from './accessors';

/**
 * Label selector evaluation (metav1.LabelSelector and plain `map[string]string`
 * selectors used by Services / ReplicationControllers).
 */

export interface LabelSelector {
  matchLabels: Record<string, string>;
  matchExpressions: Array<{ key: string; operator: string; values: string[] }>;
}

export function parseSelector(raw: unknown): LabelSelector | null {
  if (!isObject(raw)) return null;
  // A plain map (Service.spec.selector) has no matchLabels/matchExpressions keys.
  if (!('matchLabels' in raw) && !('matchExpressions' in raw)) {
    const matchLabels = asStringMap(raw);
    return Object.keys(matchLabels).length ? { matchLabels, matchExpressions: [] } : null;
  }
  return {
    matchLabels: asStringMap(raw.matchLabels),
    matchExpressions: asArray(raw.matchExpressions)
      .filter(isObject)
      .map((e) => ({
        key: asString(e.key),
        operator: asString(e.operator),
        values: asArray(e.values).map((v) => asString(v)),
      })),
  };
}

export function matchesSelector(
  selector: LabelSelector | null,
  labels: Record<string, string> | undefined,
) {
  if (!selector) return false;
  const l = labels ?? {};
  for (const [k, v] of Object.entries(selector.matchLabels)) if (l[k] !== v) return false;
  for (const e of selector.matchExpressions) {
    const has = Object.hasOwn(l, e.key);
    const value = l[e.key];
    switch (e.operator) {
      case 'In':
        if (!has || !e.values.includes(value!)) return false;
        break;
      case 'NotIn':
        if (has && e.values.includes(value!)) return false;
        break;
      case 'Exists':
        if (!has) return false;
        break;
      case 'DoesNotExist':
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function selectorText(raw: unknown): string[] {
  const s = parseSelector(raw);
  if (!s) return [];
  const out = Object.entries(s.matchLabels).map(([k, v]) => `${k}=${v}`);
  for (const e of s.matchExpressions) {
    if (e.operator === 'Exists') out.push(e.key);
    else if (e.operator === 'DoesNotExist') out.push(`!${e.key}`);
    else out.push(`${e.key} ${e.operator.toLowerCase()} (${e.values.join(', ')})`);
  }
  return out;
}

/** `app=web,tier!=db` → matcher used by the table filter. */
export function selectorFromObject(obj: unknown): LabelSelector | null {
  return parseSelector(asObject(obj));
}
