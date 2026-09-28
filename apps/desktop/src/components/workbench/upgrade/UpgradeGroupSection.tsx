import * as i18n from '@/i18n';
import { memo, useState } from 'react';
import { ChevronRight, Lightbulb, Package } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { noteText, sourceHint, sourceLabel } from '@/lib/kube/deprecations';
import type { UpgradeGroup } from '@/lib/kube/upgrade';
import type { ApiResourceInfo, UpgradeFinding } from '@/types';
import { canOpenFinding, openFinding } from './navigation';
import { SEVERITY_BADGE, SEVERITY_ICON, SEVERITY_TEXT } from './severity';

const PAGE = 50;

function FindingRow({ finding, onOpen }: { finding: UpgradeFinding; onOpen: () => void }) {
  i18n.useLocale();
  const f = finding;
  const clickable = canOpenFinding(f);
  const object = f.object;
  const title = f.helm ? (
    <>
      <Package className="text-fg-dim mr-1 inline h-3 w-3 align-[-1px]" />
      <span className="text-fg-dim font-normal">{f.helm.namespace}/</span>
      {f.helm.name}
      <span className="text-fg-dim font-normal">
        {' '}
        · {f.helm.chart}-{f.helm.chart_version} · {object?.kind}/{object?.name}
      </span>
    </>
  ) : object ? (
    <>
      {object.namespace && <span className="text-fg-dim font-normal">{object.namespace}/</span>}
      {object.name}
    </>
  ) : (
    <span className="font-mono text-[11.5px]">{f.detail ?? f.kind}</span>
  );
  const sub = [
    f.managers.length ? i18n.t('Written by {managers}', { managers: f.managers.join(', ') }) : null,
    f.helm && f.detail ? f.detail : null,
    !f.helm && object && f.detail ? f.detail : null,
  ].filter((x): x is string => !!x);
  const Tag = clickable ? 'button' : 'div';
  return (
    <li>
      <Tag
        type={clickable ? 'button' : undefined}
        onClick={clickable ? onOpen : undefined}
        className={cn(
          'group flex w-full items-start gap-3 py-2 pr-4 pl-10 text-left transition-colors',
          clickable && 'hover:bg-fg/4',
        )}
        title={sourceHint(f.source)}
      >
        <span className="text-fg-dim w-28 shrink-0 truncate pt-px text-[11px]">
          {sourceLabel(f.source)}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'text-fg block truncate text-[12px] font-medium',
              clickable && 'group-hover:text-accent',
            )}
          >
            {title}
          </span>
          {sub.map((line) => (
            <span
              key={line}
              className="text-fg-muted mt-0.5 block truncate font-mono text-[11px]"
              title={line}
            >
              {line}
            </span>
          ))}
        </span>
        {clickable && (
          <ChevronRight className="text-fg-dim/0 group-hover:text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0 transition-colors" />
        )}
      </Tag>
    </li>
  );
}

/** One deprecated apiVersion + kind with its findings (collapsible). */
export const UpgradeGroupSection = memo(function UpgradeGroupSection({
  clusterId,
  group,
  apiResources,
  defaultOpen,
}: {
  clusterId: string;
  group: UpgradeGroup;
  apiResources: readonly ApiResourceInfo[] | null;
  defaultOpen: boolean;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [limit, setLimit] = useState(PAGE);
  const Icon = SEVERITY_ICON[group.severity];
  const shown = group.findings.slice(0, limit);
  const replacement = group.replacement
    ? group.replacementKind
      ? `${group.replacement} ${group.replacementKind}`
      : group.replacement
    : null;
  const badge = group.removedIn
    ? i18n.t('Removed in {version}', { version: group.removedIn })
    : group.deprecatedIn
      ? i18n.t('Deprecated in {version}', { version: group.deprecatedIn })
      : i18n.t('Deprecated');
  const notes = group.notes
    .map((n) => noteText(n, group.findings[0]))
    .filter((n): n is string => !!n);
  return (
    <section className="border-border/60 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:bg-fg/3 flex w-full min-w-0 items-center gap-2.5 py-2.5 pr-4 pl-4 text-left transition-colors"
      >
        <ChevronRight
          className={cn(
            'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <Icon className={cn('h-3.5 w-3.5 shrink-0', SEVERITY_TEXT[group.severity])} />
        <span className="text-fg min-w-0 truncate font-mono text-[12px]">
          {group.apiVersion} <span className="font-semibold">{group.kind}</span>
        </span>
        <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {group.findings.length}
        </span>
        <Badge tone={SEVERITY_BADGE[group.severity]} size="xs" className="ml-auto shrink-0">
          {badge}
        </Badge>
      </button>
      {open && (
        <div className="pb-1.5">
          <div className="space-y-1 pr-4 pb-1.5 pl-10 text-[11.5px] leading-relaxed">
            <p className="text-fg-muted">
              {replacement
                ? i18n.rich('Move to {replacement}.', {
                    replacement: (
                      <code key="r" className="text-fg font-mono text-[11px]">
                        {replacement}
                      </code>
                    ),
                  })
                : i18n.t('There is no replacement API.')}
              {group.alreadyRemoved && (
                <span className="text-status-error ml-1.5">
                  {i18n.t('Already not served by the current version.')}
                </span>
              )}
            </p>
            {notes.map((note) => (
              <p key={note} className="text-fg-dim flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{note}</span>
              </p>
            ))}
          </div>
          <ul className="divide-border/40 divide-y">
            {shown.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                onOpen={() => openFinding(clusterId, f, apiResources)}
              />
            ))}
          </ul>
          {shown.length < group.findings.length && (
            <div className="py-1.5 pl-10">
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE * 4)}
                className="text-accent text-[11.5px] hover:underline"
              >
                {i18n.t('Show {count} more', {
                  count: i18n.number(group.findings.length - shown.length),
                })}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
