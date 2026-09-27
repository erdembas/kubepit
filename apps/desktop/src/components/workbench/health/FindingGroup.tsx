import * as i18n from '@/i18n';
import { memo, useState } from 'react';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { categoryLabel, ruleDef, ruleTitle, type Finding, type RuleGroup } from '@/lib/kube/health';
import { cn } from '@/lib/cn';
import type { ApiResourceInfo } from '@/types';
import { IgnoreMenu } from './IgnoreMenu';
import { SEVERITY_ICON, SEVERITY_TEXT, openFindingObject } from './severity';

const PAGE = 50;

function namespacesOf(findings: readonly Finding[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings)
    if (f.ref.namespace) counts.set(f.ref.namespace, (counts.get(f.ref.namespace) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ns]) => ns);
}

function FindingRow({ finding, onOpen }: { finding: Finding; onOpen: (f: Finding) => void }) {
  const f = finding;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(f)}
        className="hover:bg-fg/4 group flex w-full items-start gap-3 py-2 pr-4 pl-10 text-left transition-colors"
      >
        <span className="text-fg-dim w-24 shrink-0 truncate pt-px text-[11px]">{f.ref.kind}</span>
        <span className="min-w-0 flex-1">
          <span className="text-fg group-hover:text-accent block truncate text-[12px] font-medium">
            {f.ref.namespace && <span className="text-fg-dim font-normal">{f.ref.namespace}/</span>}
            {f.ref.name}
          </span>
          <span className="text-fg-muted mt-0.5 block text-[11.5px] leading-relaxed break-words">
            {f.message}
          </span>
          {f.hint && (
            <span className="text-fg-dim mt-0.5 block text-[11px] leading-relaxed">{f.hint}</span>
          )}
        </span>
        <ChevronRight className="text-fg-dim/0 group-hover:text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0 transition-colors" />
      </button>
    </li>
  );
}

/** One rule with its findings; the header collapses the list and offers "Ignore". */
export const FindingGroup = memo(function FindingGroup({
  clusterId,
  group,
  apiResources,
  defaultOpen,
}: {
  clusterId: string;
  group: RuleGroup;
  apiResources: readonly ApiResourceInfo[] | null;
  defaultOpen: boolean;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [limit, setLimit] = useState(PAGE);
  const def = ruleDef(group.ruleId);
  const Icon = SEVERITY_ICON[group.severity];
  const shown = group.findings.slice(0, limit);
  const hidden = group.total - shown.length;
  const onOpen = (f: Finding) => openFindingObject(clusterId, f.ref, apiResources);
  return (
    <section className="border-border/60 border-b last:border-b-0">
      <div className="hover:bg-fg/3 flex items-center gap-2 pr-3 transition-colors">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left"
        >
          <ChevronRight
            className={cn(
              'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
          <Icon className={cn('h-3.5 w-3.5 shrink-0', SEVERITY_TEXT[group.severity])} />
          <span className="text-fg min-w-0 truncate text-[12.5px] font-medium">
            {ruleTitle(group.ruleId)}
          </span>
          <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {group.total}
          </span>
          <Badge tone="neutral" variant="outline" className="hidden sm:inline-flex">
            {categoryLabel(group.category)}
          </Badge>
        </button>
        <IgnoreMenu
          clusterId={clusterId}
          rule={group.ruleId}
          namespaces={namespacesOf(group.findings)}
        />
      </div>
      {open && (
        <div className="pb-1.5">
          {def && (
            <p className="text-fg-dim flex items-start gap-1.5 pr-4 pb-1.5 pl-10 text-[11.5px] leading-relaxed">
              <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{def.hint()}</span>
            </p>
          )}
          <ul className="divide-border/40 divide-y">
            {shown.map((f) => (
              <FindingRow key={f.id} finding={f} onOpen={onOpen} />
            ))}
          </ul>
          {hidden > 0 && (
            <div className="py-1.5 pl-10">
              {shown.length < group.findings.length ? (
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + PAGE * 4)}
                  className="text-accent text-[11.5px] hover:underline"
                >
                  {i18n.t('Show {count} more', {
                    count: i18n.number(group.findings.length - shown.length),
                  })}
                </button>
              ) : (
                <span className="text-fg-dim text-[11.5px]">
                  {i18n.plural(
                    '{count} more finding is not listed',
                    '{count} more findings are not listed',
                    hidden,
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
