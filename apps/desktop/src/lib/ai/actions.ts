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
 * IP / host placeholders are restored first. A suggestion with a secret
 * marker, or with a placeholder that cannot be restored, is refused and
 * nothing is opened or copied.
 */

export type OpenResult =
  { ok: true } | { ok: false; reason: 'secret' | 'missing-placeholder' | 'clipboard' };

/**
 * `fallbackNamespace` (the session's scope) is the editor namespace for
 * manifests that name none, e.g. partial ones.
 */
export async function openSuggestion(
  clusterId: ClusterId,
  s: AiSuggestion,
  placeholders: Readonly<Record<string, string>>,
  fallbackNamespace: string | null = null,
): Promise<OpenResult> {
  const source = s.kind === 'manifest' ? s.yaml : s.kind === 'kubectl' ? s.command : s.query;
  const blocked = (s.kind === 'manifest' || s.kind === 'kubectl') && s.blocked !== null;
  if (blocked || unrestorableMarkers(source).length) return { ok: false, reason: 'secret' };
  const { text, missing } = restorePlaceholders(source, placeholders);
  if (missing.length) return { ok: false, reason: 'missing-placeholder' };
  switch (s.kind) {
    case 'manifest': {
      const namespace = s.objects.find((o) => o.namespace)?.namespace ?? fallbackNamespace;
      dock.create(clusterId, namespace, text, { reviewMode: 'apply' });
      return { ok: true };
    }
    case 'kubectl':
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return { ok: false, reason: 'clipboard' };
      }
      return { ok: true };
    case 'promql':
      dock.promql(clusterId, text);
      return { ok: true };
    case 'logql':
      dock.loki(clusterId, { query: text });
      return { ok: true };
  }
}
