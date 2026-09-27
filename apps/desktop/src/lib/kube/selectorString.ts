import { parseSelector } from './selectors';

/**
 * A metav1.LabelSelector (or a Service's plain map) as the label selector
 * string the API accepts: `app=web,tier in (a,b),!legacy`. Empty when the
 * selector selects nothing we can express (no selector at all).
 */
export function labelSelectorString(raw: unknown): string {
  const selector = parseSelector(raw);
  if (!selector) return '';
  const terms = Object.entries(selector.matchLabels).map(([k, v]) => `${k}=${v}`);
  for (const e of selector.matchExpressions) {
    switch (e.operator) {
      case 'In':
        terms.push(`${e.key} in (${e.values.join(',')})`);
        break;
      case 'NotIn':
        terms.push(`${e.key} notin (${e.values.join(',')})`);
        break;
      case 'Exists':
        terms.push(e.key);
        break;
      case 'DoesNotExist':
        terms.push(`!${e.key}`);
        break;
    }
  }
  return terms.join(',');
}
