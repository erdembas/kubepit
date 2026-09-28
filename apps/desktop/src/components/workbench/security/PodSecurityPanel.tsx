import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  ChevronRight,
  CircleCheck,
  FlaskConical,
  Loader2,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import type { ObjectRef } from '@/lib/kube/columns';
import {
  PSS_MODES,
  checkTitle,
  evaluateNamespace,
  isPssVersion,
  levelLabel,
  modeHint,
  modeLabel,
  policyText,
  violationText,
  type OwnerResult,
  type PssLevel,
} from '@/lib/kube/pss';
import type { KubeObject, PodSecurityDryRun } from '@/types';
import { errorText } from '../util';

/**
 * Pod Security of one namespace: its admission labels, the local
 * evaluation of every workload template at baseline and restricted, and
 * "what would break if I enforce X" — a server-side dry run of the label
 * change, whose warnings list the existing pods the API server would flag.
 */

type LocalLevel = Exclude<PssLevel, 'privileged'>;

function PolicyChip({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-px font-mono text-[10.5px] ring-1',
        muted ? 'text-fg-dim ring-border/60' : 'bg-fg/5 text-fg ring-border/60',
      )}
    >
      {text}
    </span>
  );
}

export function PolicyLabels({ namespace }: { namespace: KubeObject }) {
  i18n.useLocale();
  const pss = evaluateNamespace(namespace, []).pss;
  return (
    <dl className="grid grid-cols-[minmax(64px,88px)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
      {PSS_MODES.map((mode) => {
        const p = pss[mode];
        return (
          <div key={mode} className="contents">
            <dt className="text-fg-dim truncate" title={modeHint(mode)}>
              {modeLabel(mode)}
            </dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
              {p.explicit ? (
                <PolicyChip text={policyText(p)} />
              ) : (
                <span className="text-fg-dim text-[11.5px]">
                  {i18n.t('Not set (cluster default, usually privileged)')}
                </span>
              )}
              {p.invalid && (
                <span className="text-status-starting flex items-center gap-1 text-[11px]">
                  <TriangleAlert className="h-3 w-3" />
                  {i18n.t('Invalid label: treated as restricted:latest')}
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function OwnerRow({ result, onOpen }: { result: OwnerResult; onOpen?: (ref: ObjectRef) => void }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const o = result.owner;
  return (
    <li>
      <div className="flex items-start gap-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={i18n.t('Show failed checks')}
          className="text-fg-dim hover:text-fg mt-0.5 shrink-0"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <span className="text-fg-dim shrink-0 text-[10.5px]">{o.kind}</span>
            {onOpen ? (
              <button
                type="button"
                onClick={() =>
                  onOpen({
                    apiVersion: o.apiVersion,
                    kind: o.kind,
                    name: o.metadata.name,
                    namespace: o.metadata.namespace ?? null,
                  })
                }
                className="text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline"
              >
                {o.metadata.name}
              </button>
            ) : (
              <span className="text-fg truncate">{o.metadata.name}</span>
            )}
          </span>
          <span className="text-fg-muted block text-[11px] leading-relaxed break-words">
            {result.violations.map((v) => checkTitle(v.check)).join(', ')}
          </span>
          {open && (
            <ul className="mt-1 space-y-0.5">
              {result.violations.map((v) => (
                <li
                  key={v.check}
                  className="text-fg-dim font-mono text-[10.5px] leading-relaxed break-words"
                >
                  {violationText(v)}
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>
    </li>
  );
}

const PAGE = 25;

function OwnerList({
  results,
  onOpen,
  empty,
}: {
  results: readonly OwnerResult[];
  onOpen?: (ref: ObjectRef) => void;
  empty: string;
}) {
  i18n.useLocale();
  const [limit, setLimit] = useState(PAGE);
  if (!results.length)
    return (
      <p className="text-status-running flex items-center gap-1.5 text-[12px]">
        <CircleCheck className="h-3.5 w-3.5" />
        {empty}
      </p>
    );
  return (
    <>
      <ul className="divide-border/40 divide-y">
        {results.slice(0, limit).map((r) => (
          <OwnerRow key={r.owner.metadata.uid} result={r} onOpen={onOpen} />
        ))}
      </ul>
      {results.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE * 4)}
          className="text-accent mt-1 text-[11.5px] hover:underline"
        >
          {i18n.t('Show {count} more', { count: results.length - limit })}
        </button>
      )}
    </>
  );
}

function DryRunResult({ result }: { result: PodSecurityDryRun }) {
  i18n.useLocale();
  if (result.unchanged)
    return (
      <p className="text-fg-muted text-[12px] leading-relaxed">
        {i18n.t(
          'The namespace already enforces {policy}. The API server only evaluates existing pods when the enforce level changes; rely on the local evaluation for pods admitted before the label was set.',
          { policy: `${result.level}:${result.version}` },
        )}
      </p>
    );
  return (
    <div className="space-y-2">
      {!result.violations.length ? (
        <p className="text-status-running flex items-center gap-1.5 text-[12px]">
          <CircleCheck className="h-3.5 w-3.5" />
          {i18n.t('No existing pod violates {policy}.', {
            policy: `${result.level}:${result.version}`,
          })}
        </p>
      ) : (
        <ul className="divide-border/40 divide-y">
          {result.violations.map((v) => (
            <li key={v.pod} className="py-1">
              <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                <span className="text-fg truncate font-mono text-[11.5px]">{v.pod}</span>
                {v.others > 0 && (
                  <span className="text-fg-dim shrink-0 text-[11px]">
                    {i18n.plural('and {count} other pod', 'and {count} other pods', v.others)}
                  </span>
                )}
              </span>
              <ul className="mt-0.5 space-y-0.5">
                {v.checks.map((c) => (
                  <li
                    key={c}
                    className="text-fg-dim font-mono text-[10.5px] leading-relaxed break-words"
                  >
                    {c}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {result.notes.map((n) => (
        <p key={n} className="text-status-starting flex items-start gap-1.5 text-[11px]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{n}</span>
        </p>
      ))}
    </div>
  );
}

export function PodSecurityPanel({
  clusterId,
  namespace,
  owners,
  synced,
  onOpen,
}: {
  clusterId: string;
  namespace: KubeObject;
  /** Pod-spec owners of this namespace. */
  owners: readonly KubeObject[];
  synced: boolean;
  onOpen?: (ref: ObjectRef) => void;
}) {
  i18n.useLocale();
  const name = namespace.metadata.name;
  const evaluation = useMemo(() => evaluateNamespace(namespace, owners), [namespace, owners]);
  const [level, setLevel] = useState<LocalLevel>(() =>
    evaluation.pss.enforce.level === 'baseline' ? 'restricted' : 'baseline',
  );
  const [version, setVersion] = useState('latest');
  const [run, setRun] = useState<{
    key: string;
    loading: boolean;
    result: PodSecurityDryRun | null;
    error: string | null;
  } | null>(null);
  const runKey = `${clusterId}|${name}|${level}|${version}`;
  const current = run?.key === runKey ? run : null;
  const local = level === 'baseline' ? evaluation.baseline : evaluation.restricted;
  const versionOk = isPssVersion(version.trim());

  const dryRun = async () => {
    const v = version.trim();
    setRun({ key: runKey, loading: true, result: null, error: null });
    try {
      const result = await ipc.podSecurityDryRun(clusterId, name, level, v);
      setRun({ key: runKey, loading: false, result, error: null });
    } catch (e) {
      setRun({ key: runKey, loading: false, result: null, error: errorText(e) });
    }
  };

  return (
    <div className="@container space-y-4">
      <div>
        <h4 className="text-fg-dim mb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Admission labels')}
        </h4>
        <PolicyLabels namespace={namespace} />
      </div>
      <div>
        <h4 className="text-fg-dim mb-1.5 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Workloads by level')}
          {!synced && <Loader2 className="h-3 w-3 animate-spin" />}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {(['baseline', 'restricted'] as const).map((l) => {
            const n = (l === 'baseline' ? evaluation.baseline : evaluation.restricted).length;
            return (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                aria-pressed={level === l}
                className={cn(
                  'rounded-app border px-3 py-2 text-left transition',
                  level === l
                    ? 'border-border-strong bg-fg/5'
                    : 'border-border hover:border-border-strong',
                )}
              >
                <span
                  lang="en"
                  className="text-fg-dim block text-[10px] font-semibold tracking-[0.12em] uppercase"
                >
                  {levelLabel(l)}
                </span>
                <span
                  className={cn(
                    'mt-1 block text-[12px] tabular-nums',
                    n ? 'text-status-starting' : 'text-status-running',
                  )}
                >
                  {i18n.t('{count} of {total} violate', { count: n, total: evaluation.total })}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-4 @3xl:grid-cols-2">
        <div className="min-w-0">
          <h4 className="text-fg-dim mb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
            {i18n.rich('Local evaluation · {level}', {
              level: <span lang="en">{levelLabel(level)}</span>,
            })}
          </h4>
          <OwnerList
            key={level}
            results={local}
            onOpen={onOpen}
            empty={i18n.t('Every workload passes {level}.', { level: levelLabel(level) })}
          />
        </div>
        <div className="min-w-0">
          <h4 className="text-fg-dim mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
            <ServerCog className="h-3 w-3" />
            {i18n.t('What would break if I enforce…')}
          </h4>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (versionOk) void dryRun();
            }}
          >
            <Select<LocalLevel>
              value={level}
              onChange={setLevel}
              ariaLabel={i18n.t('Level')}
              options={[
                { value: 'baseline', label: levelLabel('baseline') },
                { value: 'restricted', label: levelLabel('restricted') },
              ]}
            />
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              aria-label={i18n.t('Version')}
              title={i18n.t('latest or v1.<minor>, e.g. v1.31')}
              mono
              className={cn('h-7 w-24', !versionOk && 'border-status-error/60')}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={!versionOk || current?.loading}
              leftIcon={
                current?.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="h-3.5 w-3.5" />
                )
              }
            >
              {i18n.t('Dry run')}
            </Button>
          </form>
          <p className="text-fg-dim mt-1.5 text-[11px] leading-relaxed">
            {i18n.t(
              'Sends the enforce label change with dryRun=All; nothing is saved, so it also works on read-only clusters.',
            )}
          </p>
          <div className="mt-2">
            {current?.error ? (
              <p className="text-status-error text-[12px] break-words">{current.error}</p>
            ) : current?.result ? (
              <DryRunResult result={current.result} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
