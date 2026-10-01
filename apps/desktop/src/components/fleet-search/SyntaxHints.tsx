import * as i18n from '@/i18n';
import { AlertTriangle } from 'lucide-react';
import type { ParsedSearch } from '@/lib/fleet/searchQuery';

/** Optional syntax shortcuts; committed filters are shown inside the search editor. */

const TOKENS: Array<{ token: string; hint: () => string }> = [
  { token: 'kind:', hint: () => i18n.t('Kinds, e.g. kind:pod,deploy') },
  { token: 'ns:', hint: () => i18n.t('One namespace') },
  { token: 'app=web', hint: () => i18n.t('Label selector (key=value, key!=value, !key)') },
  { token: 'web-*', hint: () => i18n.t('Glob over the whole name (* and ?)') },
  { token: '/^api-\\d+$/', hint: () => i18n.t('Regular expression, case-insensitive') },
  { token: 'cluster:', hint: () => i18n.t('Clusters whose name contains the text') },
  { token: 'env:', hint: () => i18n.t('Environment: prod, staging, dev, test, local') },
];

export const EXAMPLES = () => [
  { query: 'payment-api', description: i18n.t('Everything named like payment-api, everywhere') },
  { query: 'kind:deploy ns:checkout', description: i18n.t('Deployments of one namespace') },
  { query: 'app=storefront', description: i18n.t('Objects by label, across clusters') },
  { query: 'kind:pod env:prod redis-*', description: i18n.t('Redis pods in production') },
  { query: '/^(postgres|redis)-\\d+$/', description: i18n.t('StatefulSet pods by regex') },
];

export function SyntaxHints({
  onInsert,
  parsed,
}: {
  onInsert: (token: string) => void;
  parsed: ParsedSearch | null;
}) {
  i18n.useLocale();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[10.5px]">
      <span className="text-fg-dim mr-1">{i18n.t('Syntax')}</span>
      {TOKENS.map(({ token, hint }) => (
        <button
          key={token}
          type="button"
          title={hint()}
          onClick={() => onInsert(token)}
          className="text-fg-muted hover:text-fg hover:bg-fg/6 bg-fg/3 rounded px-1.5 py-px font-mono transition"
        >
          {token}
        </button>
      ))}
      {parsed?.unknownKinds.length ? (
        <span className="text-status-starting flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {i18n.t('Unknown kind: {kinds}', { kinds: parsed.unknownKinds.join(', ') })}
        </span>
      ) : null}
    </div>
  );
}
