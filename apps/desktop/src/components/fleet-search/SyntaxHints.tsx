import * as i18n from '@/i18n';
import { AlertTriangle } from 'lucide-react';
import type { ParsedSearch } from '@/lib/fleet/searchQuery';

/** Clickable query syntax cheatsheet under the search box, plus what the query resolved to. */

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
  const filters = parsed
    ? [
        ...parsed.kinds.map((k) => ({ key: `k:${k.kind}`, label: k.kind })),
        ...(parsed.namespace ? [{ key: 'ns', label: `ns:${parsed.namespace}` }] : []),
        ...parsed.labels.map((l) => ({ key: `l:${l}`, label: l })),
        ...parsed.clusters.map((c) => ({ key: `c:${c}`, label: `cluster:${c}` })),
        ...parsed.environments.map((e) => ({ key: `e:${e}`, label: `env:${e}` })),
      ]
    : [];
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
      {filters.length > 0 && (
        <span className="text-fg-dim ml-auto flex flex-wrap items-center gap-1">
          {i18n.t('Filters')}
          {filters.map((f) => (
            <span key={f.key} className="bg-accent/10 text-accent rounded px-1.5 py-px font-mono">
              {f.label}
            </span>
          ))}
        </span>
      )}
      {parsed?.unknownKinds.length ? (
        <span className="text-status-starting flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {i18n.t('Unknown kind: {kinds}', { kinds: parsed.unknownKinds.join(', ') })}
        </span>
      ) : null}
    </div>
  );
}
