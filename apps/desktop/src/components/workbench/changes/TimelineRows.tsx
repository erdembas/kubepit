import * as i18n from '@/i18n';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Anchor,
  Bot,
  ChevronRight,
  KeyRound,
  PencilLine,
  Plus,
  Rocket,
  Trash2,
  TriangleAlert,
  UserRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { journaledGvk } from '@/lib/kube/changes/kinds';
import {
  actorClass,
  actorLabel,
  actorTitle,
  describeChange,
  pathChange,
  type PathChange,
} from '@/lib/kube/changes/summary';
import type { TimelineItem } from '@/lib/kube/changes/timeline';
import { formatAge } from '@/lib/format';
import type { ChangeActor, ChangeOp, ChangeSummary } from '@/types';
import { openObjectChanges } from '../details/detailsTabs';
import { ChangeDiff } from './ChangeDiff';

/** Rows of the change timeline (Changes view and the details Changes tab). */

type Tone = 'added' | 'modified' | 'deleted' | 'warning' | 'helm' | 'rollout';

const TONE: Record<Tone, string> = {
  added: 'bg-status-running/12 text-status-running',
  modified: 'bg-accent/12 text-accent',
  deleted: 'bg-status-error/12 text-status-error',
  warning: 'bg-status-starting/14 text-status-starting',
  helm: 'bg-cat-infra/12 text-cat-infra',
  rollout: 'bg-cat-worker/12 text-cat-worker',
};

const OP_ICON: Record<ChangeOp, LucideIcon> = {
  added: Plus,
  modified: PencilLine,
  deleted: Trash2,
};

/** Clock time of an item; the tooltip carries the date and relative age. */
function Clock({ ts, now }: { ts: number; now: number }) {
  i18n.useLocale();
  return (
    <time
      dateTime={new Date(ts).toISOString()}
      title={`${i18n.date(ts, { dateStyle: 'medium', timeStyle: 'medium' })} · ${i18n.t('{age} ago', { age: formatAge(ts, now) })}`}
      className="text-fg-dim w-[52px] shrink-0 pt-px font-mono text-[11px] tabular-nums"
    >
      {i18n.date(ts, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </time>
  );
}

/** Vertical rail with the item's dot; `first` / `last` trim the line. */
function Rail({
  tone,
  icon: Icon,
  first,
  last,
}: {
  tone: Tone;
  icon: LucideIcon;
  first: boolean;
  last: boolean;
}) {
  return (
    <span aria-hidden className="relative flex w-5 shrink-0 justify-center">
      <span
        className={cn(
          'bg-border absolute w-px',
          first ? 'top-3' : '-top-2',
          last ? 'h-3' : '-bottom-2',
          first && last && 'hidden',
        )}
      />
      <span
        className={cn(
          'ring-surface relative mt-px flex h-5 w-5 items-center justify-center rounded-full ring-[3px]',
          TONE[tone],
        )}
      >
        <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    </span>
  );
}

function RowShell({
  children,
  onActivate,
  expanded,
  label,
}: {
  children: ReactNode;
  onActivate?: () => void;
  expanded?: boolean;
  label: string;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!onActivate || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  };
  return (
    <div
      role={onActivate ? 'button' : undefined}
      tabIndex={onActivate ? 0 : undefined}
      aria-expanded={expanded}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex gap-2.5 py-2 pr-3 pl-3 transition outline-none',
        onActivate && 'focus-visible:bg-fg/5 cursor-pointer',
        expanded ? 'bg-accent/8 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
      )}
    >
      {children}
    </div>
  );
}

const ACTOR_TONE: Record<ReturnType<typeof actorClass>, BadgeTone> = {
  human: 'info',
  gitops: 'accent',
  controller: 'neutral',
  unknown: 'neutral',
};

const ACTOR_ICON: Record<ReturnType<typeof actorClass>, LucideIcon> = {
  human: UserRound,
  gitops: Workflow,
  controller: Bot,
  unknown: Bot,
};

export function ActorBadge({ actor }: { actor: ChangeActor }) {
  i18n.useLocale();
  const cls = actorClass(actor);
  const Icon = ACTOR_ICON[cls];
  return (
    <Badge
      tone={ACTOR_TONE[cls]}
      variant="outline"
      icon={<Icon className="h-2.5 w-2.5" />}
      title={actorTitle(actor)}
      className="max-w-[220px] shrink-0 font-mono"
    >
      <span className="truncate">{actorLabel(actor)}</span>
    </Badge>
  );
}

function PathLine({ change }: { change: PathChange }) {
  i18n.useLocale();
  return (
    <li className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px] leading-[1.55]">
      <span className="text-fg-muted max-w-[55%] shrink-0 truncate" title={change.path}>
        {change.path}
      </span>
      {change.redacted ? (
        <span className="text-tone-warning-fg inline-flex min-w-0 items-center gap-1 font-sans text-[11px]">
          <KeyRound className="h-3 w-3 shrink-0" />
          {change.kind === 'added'
            ? i18n.t('key added')
            : change.kind === 'removed'
              ? i18n.t('key removed')
              : i18n.t('value changed')}
          <span className="text-fg-dim">· {i18n.t('value hidden')}</span>
        </span>
      ) : change.kind === 'added' ? (
        <span className="text-status-running min-w-0 truncate" title={change.after ?? undefined}>
          + {change.after}
        </span>
      ) : change.kind === 'removed' ? (
        <span
          className="text-status-error min-w-0 truncate line-through decoration-1"
          title={change.before ?? undefined}
        >
          {change.before}
        </span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className="text-status-error/90 max-w-[45%] min-w-0 shrink truncate"
            title={change.before ?? undefined}
          >
            {change.before}
          </span>
          <span className="text-fg-dim shrink-0">→</span>
          <span className="text-status-running min-w-0 truncate" title={change.after ?? undefined}>
            {change.after}
          </span>
        </span>
      )}
    </li>
  );
}

/** Up to `max` changed paths plus "+N more". */
export function PathList({ entry, max = 3 }: { entry: ChangeSummary; max?: number }) {
  i18n.useLocale();
  if (entry.op !== 'modified' || !entry.paths.length) return null;
  const shown = entry.paths.slice(0, max);
  const more = entry.path_count - shown.length;
  return (
    <ul className="mt-1 min-w-0 space-y-px">
      {shown.map((p) => (
        <PathLine key={p.path} change={pathChange(p)} />
      ))}
      {more > 0 && (
        <li className="text-fg-dim text-[11px]">
          {i18n.plural('+{count} more change', '+{count} more changes', more)}
        </li>
      )}
    </ul>
  );
}

/** One journal entry; expands to its diff. `compact` hides kind and name (details tab). */
export function ChangeRow({
  entry,
  now,
  first,
  last,
  expanded,
  onToggle,
  compact = false,
  historic = false,
}: {
  entry: ChangeSummary;
  now: number;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  compact?: boolean;
  /** From the persistent history (not the live journal). */
  historic?: boolean;
}) {
  i18n.useLocale();
  const gvk = journaledGvk(entry.gvk);
  const openable = entry.op !== 'deleted';
  const title = describeChange(entry);
  return (
    <li>
      <RowShell onActivate={onToggle} expanded={expanded} label={title}>
        <Clock ts={entry.ts} now={now} />
        <Rail tone={entry.op} icon={OP_ICON[entry.op]} first={first} last={last && !expanded} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {!compact && (
              <>
                <span className="text-fg-dim shrink-0 text-[11px]">{entry.gvk.kind}</span>
                {openable ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openObjectChanges(
                        entry.cluster_id,
                        gvk,
                        entry.namespace,
                        entry.name,
                        entry.uid,
                      );
                    }}
                    title={i18n.t('Open {name}', { name: entry.name })}
                    className="text-fg hover:text-accent min-w-0 truncate text-left text-[12.5px] font-medium hover:underline"
                  >
                    {entry.namespace && <span className="text-fg-muted">{entry.namespace}/</span>}
                    {entry.name}
                  </button>
                ) : (
                  <span className="text-fg min-w-0 truncate text-[12.5px] font-medium">
                    {entry.namespace && <span className="text-fg-muted">{entry.namespace}/</span>}
                    {entry.name}
                  </span>
                )}
              </>
            )}
            {entry.op === 'added' && (
              <Badge tone="success" size="xs">
                {i18n.t('created')}
              </Badge>
            )}
            {entry.op === 'deleted' && (
              <Badge tone="critical" size="xs">
                {i18n.t('deleted')}
              </Badge>
            )}
            {compact && entry.op === 'modified' && (
              <span className="text-fg-muted text-[12px]">
                {i18n.plural('{count} field changed', '{count} fields changed', entry.path_count)}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              {entry.actor && <ActorBadge actor={entry.actor} />}
              <ChevronRight
                aria-hidden
                className={cn(
                  'text-fg-dim h-3.5 w-3.5 transition-transform',
                  expanded && 'rotate-90',
                )}
              />
            </span>
          </div>
          <PathList entry={entry} />
        </div>
      </RowShell>
      {expanded && (
        <div className="border-border/60 bg-surface-muted/30 border-y">
          <ChangeDiff entry={entry} historic={historic} />
        </div>
      )}
    </li>
  );
}

export function WarningRow({
  item,
  now,
  first,
  last,
  onOpen,
}: {
  item: Extract<TimelineItem, { type: 'warning' }>;
  now: number;
  first: boolean;
  last: boolean;
  onOpen: (() => void) | null;
}) {
  i18n.useLocale();
  const o = item.object;
  return (
    <li>
      <RowShell onActivate={onOpen ?? undefined} label={`${item.reason}: ${item.message}`}>
        <Clock ts={item.ts} now={now} />
        <Rail tone="warning" icon={TriangleAlert} first={first} last={last} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-status-starting shrink-0 text-[12px] font-semibold">
              {item.reason}
            </span>
            {item.count > 1 && (
              <span className="bg-fg/5 text-fg-dim shrink-0 rounded px-1 text-[10px] tabular-nums">
                ×{item.count}
              </span>
            )}
            <span className="text-fg-dim shrink-0 text-[11px]">{o.kind}</span>
            <span className="text-fg-muted min-w-0 truncate text-[12px]">
              {o.namespace ? `${o.namespace}/` : ''}
              {o.name}
            </span>
            <span className="ml-auto shrink-0 pl-2">
              <Badge tone="warning" variant="outline" size="xs">
                {i18n.t('Warning')}
              </Badge>
            </span>
          </div>
          <p className="text-fg-muted mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed">
            {item.message}
          </p>
        </div>
      </RowShell>
    </li>
  );
}

export function HelmRow({
  item,
  now,
  first,
  last,
  onOpen,
}: {
  item: Extract<TimelineItem, { type: 'helm' }>;
  now: number;
  first: boolean;
  last: boolean;
  onOpen: () => void;
}) {
  i18n.useLocale();
  const r = item.release;
  return (
    <li>
      <RowShell onActivate={onOpen} label={`${r.namespace}/${r.name}`}>
        <Clock ts={item.ts} now={now} />
        <Rail tone="helm" icon={Anchor} first={first} last={last} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-fg-dim shrink-0 text-[11px]">{i18n.t('Helm release')}</span>
            <span className="text-fg min-w-0 truncate text-[12.5px] font-medium">
              <span className="text-fg-muted">{r.namespace}/</span>
              {r.name}
            </span>
            <span className="bg-fg/6 text-fg shrink-0 rounded px-1.5 py-px font-mono text-[10.5px] font-semibold tabular-nums">
              {i18n.t('revision {revision}', { revision: r.revision })}
            </span>
            <span className="text-fg-muted shrink-0 text-[11px] capitalize">{r.status}</span>
          </div>
          <p className="text-fg-muted mt-0.5 truncate font-mono text-[11.5px]">
            {r.chart}-{r.chart_version}
            {r.description && <span className="text-fg-dim font-sans"> · {r.description}</span>}
          </p>
        </div>
      </RowShell>
    </li>
  );
}

export function RolloutRow({
  item,
  now,
  first,
  last,
  onOpen,
}: {
  item: Extract<TimelineItem, { type: 'rollout' }>;
  now: number;
  first: boolean;
  last: boolean;
  onOpen: () => void;
}) {
  i18n.useLocale();
  const o = item.owner;
  return (
    <li>
      <RowShell onActivate={onOpen} label={`${o.namespace ?? ''}/${o.name}`}>
        <Clock ts={item.ts} now={now} />
        <Rail tone="rollout" icon={Rocket} first={first} last={last} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-fg-dim shrink-0 text-[11px]">{i18n.t('Rollout')}</span>
            <span className="text-fg min-w-0 truncate text-[12.5px] font-medium">
              {o.namespace && <span className="text-fg-muted">{o.namespace}/</span>}
              {o.name}
            </span>
            <span className="bg-fg/6 text-fg shrink-0 rounded px-1.5 py-px font-mono text-[10.5px] font-semibold tabular-nums">
              #{item.revision}
            </span>
          </div>
          <p className="text-fg-muted mt-0.5 truncate font-mono text-[11.5px]">
            <span className="text-fg-dim">{item.replicaSet}</span>
            {item.images.length > 0 && <> · {item.images.join(', ')}</>}
          </p>
        </div>
      </RowShell>
    </li>
  );
}
