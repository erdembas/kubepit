import { dock } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import type { AiSuggestion } from './answer';
import { restorePlaceholders, unrestorableMarkers } from './placeholders';

/**
 * Hands an assistant suggestion to an existing flow (spec D10):
 *
 * - a manifest opens the create editor straight in the dry-run review in
 *   `apply` mode (server-side apply, field manager `kubepit`), so it goes
 *   through the same review, production confirmation, `read_only` check
 *   and RBAC as any other change;
 * - a kubectl command is copied (Kubepit never runs it);
 * - PromQL and LogQL open the PromQL and Loki tabs.
 *
 * IP / host placeholders are restored first. A manifest or command with a
 * secret marker, or with a placeholder that cannot be restored, is refused
 * and nothing is opened or copied.
 */

export type OpenResult = { ok: true } | { ok: false; reason: 'secret' | 'missing-placeholder' };

export async function openSuggestion(
  clusterId: ClusterId,
  s: AiSuggestion,
  placeholders: Readonly<Record<string, string>>,
): Promise<OpenResult> {
  switch (s.kind) {
    case 'manifest':
    case 'kubectl': {
      const source = s.kind === 'manifest' ? s.yaml : s.command;
      if (s.blocked || unrestorableMarkers(source).length) return { ok: false, reason: 'secret' };
      const { text, missing } = restorePlaceholders(source, placeholders);
      if (missing.length) return { ok: false, reason: 'missing-placeholder' };
      if (s.kind === 'kubectl') {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      }
      const namespace = s.objects.find((o) => o.namespace)?.namespace ?? null;
      dock.create(clusterId, namespace, text, { reviewMode: 'apply' });
      return { ok: true };
    }
    case 'promql':
      dock.promql(clusterId, restorePlaceholders(s.query, placeholders).text);
      return { ok: true };
    case 'logql':
      dock.loki(clusterId, { query: restorePlaceholders(s.query, placeholders).text });
      return { ok: true };
  }
}
