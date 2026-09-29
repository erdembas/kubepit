import * as i18n from '@/i18n/core';
import type { AiSectionKind, AiUsage, RedactionCounts } from '@/types';
export function sectionKindLabel(kind: AiSectionKind): string {
  switch (kind) {
    case 'scope':
      return i18n.t('Scope');
    case 'object':
      return i18n.t('Object');
    case 'containers':
      return i18n.t('Containers');
    case 'events':
      return i18n.t('Events');
    case 'logs':
      return i18n.t('Logs');
    case 'health':
      return i18n.t('Health');
    case 'changes':
      return i18n.t('Changes');
    case 'alerts':
      return i18n.t('Alerts');
    case 'metrics':
      return i18n.t('Metrics');
    case 'schema':
      return i18n.t('Schema');
    case 'query':
      return i18n.t('Query');
    case 'editor':
      return i18n.t('Editor');
  }
}
export function redactionSummary(c: RedactionCounts): string | null {
  const parts = [
    c.secrets ? i18n.plural('{count} secret', '{count} secrets', c.secrets) : null,
    c.tokens ? i18n.plural('{count} token', '{count} tokens', c.tokens) : null,
    c.ips ? i18n.plural('{count} IP address', '{count} IP addresses', c.ips) : null,
    c.hostnames ? i18n.plural('{count} hostname', '{count} hostnames', c.hostnames) : null,
  ].filter((s): s is string => s !== null);
  return parts.length ? new Intl.ListFormat(i18n.getFormatLocale()).format(parts) : null;
}
export const formatCost = (cost: number) =>
  i18n.number(cost, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 3,
    maximumFractionDigits: 5,
  });
export function usageSummary(u: AiUsage, cost: number | null, local: boolean): string {
  const tokens = i18n.t('{input} in · {output} out', {
    input: i18n.number(u.input_tokens),
    output: i18n.number(u.output_tokens),
  });
  if (local) return i18n.t('{usage} · local', { usage: tokens });
  const cached = u.cache_read_tokens
    ? i18n.t('{usage} · {cached} cached', {
        usage: tokens,
        cached: i18n.number(u.cache_read_tokens),
      })
    : tokens;
  return cost === null
    ? cached
    : i18n.t('{usage} · {cost}', { usage: cached, cost: formatCost(cost) });
}
