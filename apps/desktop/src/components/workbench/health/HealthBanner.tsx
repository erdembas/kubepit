import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { isIgnored, mergeFindings, objectFindings, ruleDef } from '@/lib/kube/health';
import { cn } from '@/lib/cn';
import { useHealthIgnores, useHealthStore } from '@/store/useHealthStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';
import { Section } from '../details/primitives';
import { SEVERITY_ICON, SEVERITY_TEXT } from './severity';

const COLLAPSED = 4;

/**
 * Health findings of the object a details panel shows: object-local rules
 * evaluated on the live object, plus cross-object findings (unused, no
 * endpoints…) from the cluster's last health scan. Renders nothing when clean.
 */
export function HealthBanner({
  clusterId,
  obj,
  now,
}: {
  clusterId: string;
  obj: KubeObject;
  now: number;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const ignores = useHealthIgnores(clusterId);
  const scanned = useHealthStore((s) => s.scans[clusterId]?.byUid.get(obj.metadata.uid));
  const findings = useMemo(
    () => mergeFindings(objectFindings(obj, now), scanned).filter((f) => !isIgnored(f, ignores)),
    [obj, now, scanned, ignores],
  );
  if (!findings.length) return null;
  const shown = expanded ? findings : findings.slice(0, COLLAPSED);
  return (
    <Section
      title={i18n.t('Health')}
      actions={
        <button
          type="button"
          onClick={() => useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.clusterHealth)}
          className="text-accent text-[11.5px] hover:underline"
        >
          {i18n.t('All health checks')}
        </button>
      }
    >
      <ul className="space-y-2">
        {shown.map((f) => {
          const Icon = SEVERITY_ICON[f.severity];
          return (
            <li key={f.id} className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', SEVERITY_TEXT[f.severity])} />
              <span className="min-w-0">
                <span className="text-fg block text-[12px] break-words">{f.message}</span>
                <span className="text-fg-dim block text-[11px] leading-relaxed">
                  {f.hint ?? ruleDef(f.ruleId)?.hint()}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {findings.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-accent mt-2 text-[11.5px] hover:underline"
        >
          {expanded ? i18n.t('Show less') : i18n.t('Show all {count}', { count: findings.length })}
        </button>
      )}
    </Section>
  );
}
