import * as i18n from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import { useAssistantStore } from '@/store/useAssistantStore';
import { querySection } from '@/lib/ai/intents';
import type { ClusterId } from '@/types';

export function AssistantQueryActions({
  clusterId,
  language,
  query,
}: {
  clusterId: ClusterId;
  language: 'promql' | 'logql';
  query: string;
}) {
  i18n.useLocale();
  const enabled = useAppStore((s) => s.settings?.ai.enabled);
  if (!enabled) return null;
  const scope = { cluster_id: clusterId, namespace: null, object: null };
  return (
    <span className="flex shrink-0 gap-1">
      <button
        type="button"
        className="hover:bg-fg/5 rounded px-2 text-[11px] disabled:opacity-50"
        disabled={!query.trim()}
        onClick={() =>
          void useAssistantStore.getState().ask({
            intent: 'explain-query',
            message: i18n.t('Explain this query.'),
            sections: [querySection(language, query)],
            scope,
          })
        }
      >
        {i18n.t('Explain query')}
      </button>
      <button
        type="button"
        className="hover:bg-fg/5 rounded px-2 text-[11px]"
        onClick={() => useAssistantStore.getState().openComposer(language, [], scope)}
      >
        {i18n.t('Ask assistant')}
      </button>
    </span>
  );
}
