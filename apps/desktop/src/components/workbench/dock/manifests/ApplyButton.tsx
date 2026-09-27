import * as i18n from '@/i18n';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAppStore } from '@/store/useAppStore';
import type { ReviewControls } from './FleetReview';
import type { ApplyPlan } from './model';
import type { FleetReview } from './useFleetReview';

/** Why the reviewed set cannot be applied right now, or null. */
function blocker(
  review: FleetReview | null,
  controls: ReviewControls,
  stale: boolean,
): string | null {
  const { plan } = controls;
  if (!review) return i18n.t('Run the diff first: changes are always reviewed before applying.');
  if (stale) return i18n.t('The manifests changed after this diff. Run the diff again.');
  if (controls.running) return i18n.t('Waiting for the dry run to finish…');
  if (plan.errors > 0)
    return i18n.plural(
      'Deselect or fix {count} rejected object first',
      'Deselect or fix {count} rejected objects first',
      plan.errors,
    );
  if (plan.changes === 0) {
    if (review.targets.every((t) => t.readOnly))
      return i18n.t('Every selected cluster is read-only: nothing can be applied.');
    return i18n.t('Nothing selected would change.');
  }
  return null;
}

/**
 * Applies the reviewed plan. Production targets always need an explicit
 * confirmation (typing the cluster name), like other risky actions.
 */
export function ApplyButton({
  review,
  controls,
  stale,
  onApply,
}: {
  review: FleetReview | null;
  controls: ReviewControls;
  stale: boolean;
  onApply: (plan: ApplyPlan) => Promise<{ ok: number; failed: number }>;
}) {
  i18n.useLocale();
  const { plan, applying } = controls;
  const blocked = blocker(review, controls, stale);
  const clusterCount = plan.targets.length;

  const run = () => {
    const store = useAppStore.getState();
    const name = (id: string) => store.clusters.find((c) => c.id === id)?.name ?? id;
    const production = plan.targets
      .filter((p) => p.target.production)
      .map((p) => name(p.target.clusterId));
    const go = async () => {
      const { ok, failed } = await onApply(plan);
      if (failed === 0)
        store.pushToast(
          'success',
          i18n.plural('Applied {count} change', 'Applied {count} changes', ok),
        );
      else
        store.pushToast(
          'error',
          i18n.plural('{count} object failed to apply', '{count} objects failed to apply', failed),
        );
    };
    if (production.length === 0) return void go();
    store.requestConfirm({
      title: i18n.t('Apply to production?'),
      message: i18n.plural(
        '{count} reviewed change will be applied, including to production: {production}.',
        '{count} reviewed changes will be applied, including to production: {production}.',
        plan.changes,
        { production: production.join(', ') },
      ),
      confirmLabel: i18n.t('Apply'),
      tone: 'danger',
      typeToConfirm: production[0],
      onConfirm: go,
    });
  };

  return (
    <Button
      size="xs"
      variant="primary"
      leftIcon={
        applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />
      }
      disabled={blocked !== null || applying}
      title={
        blocked ??
        i18n.plural(
          'Server-side apply on {count} cluster',
          'Server-side apply on {count} clusters',
          clusterCount,
        )
      }
      onClick={run}
    >
      {applying
        ? i18n.t('Applying…')
        : i18n.plural('Apply {count} change', 'Apply {count} changes', plan.changes)}
    </Button>
  );
}
