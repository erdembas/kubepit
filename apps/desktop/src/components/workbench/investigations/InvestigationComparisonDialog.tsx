import * as i18n from '@/i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, GitCompareArrows, Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import type { Investigation, InvestigationSummary } from '@/types/investigations';
import { DiffView } from '../common/DiffView';
import {
  compareInvestigations,
  comparisonCandidates,
  type ComparisonCoverage,
  type ContainerDifference,
  type EventObservation,
  type PodDifference,
} from './comparison';
import { evidenceReason, investigationError } from './labels';

type Subject = 'manifest' | 'pods' | 'events';

export function InvestigationComparisonDialog({
  record,
  records,
  onClose,
}: {
  record: Investigation;
  records: InvestigationSummary[];
  onClose: () => void;
}) {
  i18n.useLocale();
  const candidates = useMemo(() => comparisonCandidates(record, records), [record, records]);
  const [selected, setSelected] = useState(
    () =>
      candidates.find((item) => item.captured_at < record.captured_at)?.id ??
      candidates[0]?.id ??
      '',
  );
  const [other, setOther] = useState<Investigation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [subject, setSubject] = useState<Subject>('manifest');
  const candidate = candidates.find((item) => item.id === selected);

  useEffect(() => {
    let cancelled = false;
    setOther(null);
    setError(null);
    setLoading(false);
    if (!candidate) return;
    setLoading(true);
    void ipc
      .investigationGet(candidate.id)
      .then((value) => {
        if (!cancelled) setOther(value);
      })
      .catch((error) => {
        if (!cancelled) setError(investigationError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate?.id, candidate?.updated_at]);

  const result = useMemo(() => {
    if (!candidate || !other || other.id !== selected) return null;
    try {
      return compareInvestigations(other, record);
    } catch {
      return null;
    }
  }, [candidate, other, record, selected]);
  const earlierLabel = result?.sameCaptureTime ? i18n.t('Snapshot A') : i18n.t('Earlier snapshot');
  const laterLabel = result?.sameCaptureTime ? i18n.t('Snapshot B') : i18n.t('Later snapshot');
  const coverage = result?.[subject];
  const usable =
    coverage &&
    coverage.beforeCoverage.state !== 'unavailable' &&
    coverage.afterCoverage.state !== 'unavailable';

  return (
    <Dialog
      title={i18n.t('Compare saved investigations')}
      subtitle={`${record.cluster_name} · ${record.target.kind} · ${record.target.namespace}/${record.target.name}`}
      size="xl"
      onClose={onClose}
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="border-border/60 shrink-0 space-y-3 border-b p-4">
        <p className="text-fg-dim text-[11px]">
          {i18n.t(
            'Compare frozen evidence stored on this device. No cluster connection is used and notes are not changed.',
          )}
        </p>
        {!record.cluster_id ? (
          <Notice>
            {i18n.t(
              'Imported bundles do not retain a local cluster ID. Their shared origin cannot be verified for comparison.',
            )}
          </Notice>
        ) : !candidates.length ? (
          <Notice>
            {i18n.t(
              'Save another snapshot of this workload to compare. Records must share the saved cluster ID, resource kind, namespace and name.',
            )}
          </Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <GitCompareArrows className="text-accent h-4 w-4 shrink-0" />
            <span className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
              {i18n.t('Compare with')}
            </span>
            <Select
              value={selected}
              onChange={setSelected}
              ariaLabel={i18n.t('Comparison snapshot')}
              className="min-w-48 flex-1"
              options={candidates.map((item) => ({
                value: item.id,
                label: item.title,
                description: new Date(item.captured_at).toLocaleString(),
              }))}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-status-error text-[12px]">
            {error}
          </p>
        )}
        {!loading && other && !result && (
          <Notice>
            {i18n.t(
              'These records do not identify the same saved workload. Choose another snapshot.',
            )}
          </Notice>
        )}
        {result && (
          <>
            <div className="grid items-start gap-2 sm:grid-cols-[1fr_auto_1fr]">
              <SnapshotHeading label={earlierLabel} record={result.earlier} />
              <ArrowRight className="text-fg-dim mt-4 h-4 w-4" />
              <SnapshotHeading label={laterLabel} record={result.later} />
            </div>
            {result.sameCaptureTime && (
              <Notice>
                {i18n.t(
                  'Both records have the same capture time. Snapshot A is the chosen comparison; snapshot B is the current record. No chronological direction is implied.',
                )}
              </Notice>
            )}
            {result.workloadRecreated && (
              <Notice>
                {i18n.t(
                  'The workload UID changed between captures. These snapshots describe different instances of the same named workload.',
                )}
              </Notice>
            )}
          </>
        )}
      </div>
      {loading && (
        <p role="status" className="text-fg-dim flex items-center gap-2 p-6 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Loading saved comparison…')}
        </p>
      )}
      {!loading && result && (
        <>
          <Tabs<Subject>
            value={subject}
            onChange={setSubject}
            className="shrink-0 px-3 pt-2"
            tabs={[
              { key: 'manifest', label: i18n.t('Manifest') },
              { key: 'pods', label: i18n.t('Pod states and restarts') },
              { key: 'events', label: i18n.t('Events') },
            ]}
          />
          {coverage && (
            <div className="border-border/60 shrink-0 space-y-2 border-b p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Coverage label={earlierLabel} value={coverage.beforeCoverage} />
                <Coverage label={laterLabel} value={coverage.afterCoverage} />
              </div>
              <p className="text-fg-dim text-[11px]">
                {subject === 'events'
                  ? i18n.t(
                      'Events are compared by UID within each capture window. An event missing from a sample may have aged out or been omitted; it is not proof that the event was deleted.',
                    )
                  : subject === 'pods'
                    ? i18n.t(
                        'Pod changes reflect captured samples. Missing Pods do not prove creation or deletion. Restart deltas require the same Pod UID and container.',
                      )
                    : i18n.t(
                        'The diff compares saved, redacted objects with sorted keys. Redacted values cannot be compared and unavailable evidence is never treated as an empty manifest.',
                      )}
              </p>
            </div>
          )}
          {!usable ? (
            <div className="p-4">
              <Notice>
                {i18n.t(
                  'Comparable evidence is unavailable on one or both sides. Open the saved evidence to inspect the reported gaps.',
                )}
              </Notice>
            </div>
          ) : subject === 'manifest' &&
            result.manifest.before !== null &&
            result.manifest.after !== null ? (
            <div className="flex h-[420px] min-h-64 shrink-0 flex-col">
              <DiffView
                original={result.manifest.before}
                modified={result.manifest.after}
                originalLabel={earlierLabel}
                modifiedLabel={laterLabel}
                language="json"
                identicalHint={i18n.t('The available redacted object snapshots are identical.')}
              />
            </div>
          ) : subject === 'pods' ? (
            <div className="space-y-3 p-4">
              {result.pods.recreatedNames.length > 0 && (
                <Notice>
                  {i18n.t(
                    'A Pod name appears with different UIDs. Its instances are shown separately; restart counters are not subtracted across them.',
                  )}
                </Notice>
              )}
              {!result.pods.changes.length && (
                <Empty>{i18n.t('No differences in the comparable Pod observations.')}</Empty>
              )}
              {result.pods.changes.map((change) => (
                <PodChange
                  key={change.uid}
                  change={change}
                  earlierLabel={earlierLabel}
                  laterLabel={laterLabel}
                />
              ))}
              <p className="text-fg-dim text-[11px]">
                {i18n.plural(
                  '{count} unchanged Pod observation',
                  '{count} unchanged Pod observations',
                  result.pods.unchanged,
                )}
              </p>
            </div>
          ) : subject === 'events' ? (
            <div className="space-y-4 p-4">
              <EventGroup
                label={i18n.t('Only in the later sample')}
                entries={result.events.added}
                sameTime={result.sameCaptureTime}
                alternate={i18n.t('Only in snapshot B')}
              />
              <EventGroup
                label={i18n.t('Only in the earlier sample')}
                entries={result.events.removed}
                sameTime={result.sameCaptureTime}
                alternate={i18n.t('Only in snapshot A')}
              />
              <section className="space-y-2">
                <SectionTitle>{i18n.t('Changed event observations')}</SectionTitle>
                {!result.events.changed.length ? (
                  <Empty>{i18n.t('No changed event observations.')}</Empty>
                ) : (
                  result.events.changed.map(({ before, after }) => (
                    <div key={before.uid} className="grid gap-2 sm:grid-cols-2">
                      <EventCard entry={before} side={earlierLabel} />
                      <EventCard entry={after} side={laterLabel} />
                    </div>
                  ))
                )}
              </section>
              <p className="text-fg-dim text-[11px]">
                {i18n.plural(
                  '{count} unchanged event observation',
                  '{count} unchanged event observations',
                  result.events.unchanged,
                )}
              </p>
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function SnapshotHeading({ label, record }: { label: string; record: Investigation }) {
  return (
    <div className="border-border/60 rounded-md border p-2 text-[11px]">
      <p className="text-fg-dim text-[10px] font-semibold tracking-wider uppercase">{label}</p>
      <p className="text-fg mt-1 truncate" title={record.title}>
        {record.title}
      </p>
      <time className="text-fg-muted" dateTime={new Date(record.captured_at).toISOString()}>
        {new Date(record.captured_at).toLocaleString()}
      </time>
      <p className="text-fg-dim mt-1">
        {i18n.t('Requested window: {minutes} minutes', { minutes: record.lookback_minutes })}
      </p>
    </div>
  );
}

function Coverage({ label, value }: { label: string; value: ComparisonCoverage }) {
  const details = [
    value.issues.includes('missing')
      ? i18n.t('This evidence section is absent from the saved record.')
      : '',
    value.issues.includes('invalid')
      ? i18n.t(
          'Some saved evidence could not be parsed or lacks the expected Kubernetes identity. It is excluded from comparison.',
        )
      : '',
    value.issues.includes('limit')
      ? i18n.t('The comparison display limit was reached; additional observations are omitted.')
      : '',
    ...value.sources
      .filter((source) => source.reason)
      .map((source) => evidenceReason(source.reason)),
  ].filter(Boolean);
  return (
    <div
      className={cn(
        'text-[11px]',
        value.state === 'complete' ? 'text-fg-dim' : 'text-status-starting',
      )}
    >
      <p>
        {i18n.t('{side}: {coverage}', {
          side: label,
          coverage:
            value.state === 'complete'
              ? i18n.t('Captured sample')
              : value.state === 'partial'
                ? i18n.t('Partial sample')
                : i18n.t('Unavailable'),
        })}
      </p>
      {[...new Set(details)].map((detail) => (
        <p key={detail} className="mt-1">
          {detail}
        </p>
      ))}
    </div>
  );
}

function PodChange({
  change,
  earlierLabel,
  laterLabel,
}: {
  change: PodDifference;
  earlierLabel: string;
  laterLabel: string;
}) {
  const pod = (change.after ?? change.before)!;
  return (
    <section className="border-border/60 rounded-md border p-3">
      <p className="text-fg font-mono text-[12px]">
        {pod.namespace}/{pod.name}
      </p>
      <p className="text-fg-dim mt-1 font-mono text-[10px]">UID: {pod.uid}</p>
      {!change.before || !change.after ? (
        <p className="text-status-starting mt-2 text-[11px]">
          {i18n.t('Observed only in {side}.', { side: change.before ? earlierLabel : laterLabel })}
        </p>
      ) : (
        <div className="text-fg-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span>
            {i18n.t('Phase: {before} → {after}', {
              before: change.before.phase ?? i18n.t('Unknown'),
              after: change.after.phase ?? i18n.t('Unknown'),
            })}
          </span>
          <span>
            {i18n.t('Ready: {before} → {after}', {
              before: change.before.ready ?? i18n.t('Unknown'),
              after: change.after.ready ?? i18n.t('Unknown'),
            })}
          </span>
        </div>
      )}
      <div className="mt-2 space-y-2">
        {change.containers.map((container) => (
          <ContainerChange
            key={container.key}
            change={container}
            earlierLabel={earlierLabel}
            laterLabel={laterLabel}
          />
        ))}
      </div>
    </section>
  );
}

function ContainerChange({
  change,
  earlierLabel,
  laterLabel,
}: {
  change: ContainerDifference;
  earlierLabel: string;
  laterLabel: string;
}) {
  const item = (change.after ?? change.before)!;
  const ready = (value: boolean | null | undefined) =>
    value == null ? i18n.t('Unknown') : value ? i18n.t('Yes') : i18n.t('No');
  return (
    <div className="border-border/50 border-t pt-2 text-[11px]">
      <p className="text-fg font-mono">
        {item.name} <span className="text-fg-dim">({item.group})</span>
      </p>
      <div className="text-fg-muted mt-1 grid gap-1 sm:grid-cols-2">
        {[
          { label: earlierLabel, value: change.before },
          { label: laterLabel, value: change.after },
        ].map(({ label, value }) => (
          <p key={label}>
            {i18n.t('{side}: {state}; ready {ready}; restarts {count}', {
              side: label,
              state: value?.state ?? i18n.t('Unknown'),
              ready: ready(value?.ready),
              count: value?.restarts ?? i18n.t('Unknown'),
            })}
          </p>
        ))}
      </div>
      {change.counterReset ? (
        <p className="text-status-starting mt-1">
          {i18n.t('The restart counter decreased. The interval total is unknown.')}
        </p>
      ) : (
        change.restartDelta !== null && (
          <p className="text-accent mt-1">
            {i18n.plural(
              '{count} additional restart observed',
              '{count} additional restarts observed',
              change.restartDelta,
            )}
          </p>
        )
      )}
    </div>
  );
}

function EventGroup({
  label,
  entries,
  sameTime,
  alternate,
}: {
  label: string;
  entries: EventObservation[];
  sameTime: boolean;
  alternate: string;
}) {
  return (
    <section className="space-y-2">
      <SectionTitle>{sameTime ? alternate : label}</SectionTitle>
      {!entries.length ? (
        <Empty>{i18n.t('No event observations in this group.')}</Empty>
      ) : (
        entries.map((entry) => <EventCard key={entry.uid} entry={entry} />)
      )}
    </section>
  );
}

function EventCard({ entry, side }: { entry: EventObservation; side?: string }) {
  return (
    <div className="border-border/60 min-w-0 rounded-md border p-3 text-[11px]">
      {side && <p className="text-fg-dim mb-1 text-[10px] uppercase">{side}</p>}
      <p className="text-fg font-mono break-all">
        {[entry.type, entry.reason, entry.regarding].filter(Boolean).join(' · ') || entry.name}
      </p>
      <p className="text-fg-muted mt-1 break-words whitespace-pre-wrap">
        {entry.message ?? i18n.t('No message was captured.')}
      </p>
      <p className="text-fg-dim mt-2">
        {i18n.t('Observed count: {count}', { count: entry.count ?? i18n.t('Unknown') })}
      </p>
      {entry.lastObserved && (
        <p className="text-fg-dim mt-1">
          {i18n.t('Last observed: {time}', { time: entry.lastObserved })}
        </p>
      )}
      <p className="text-fg-dim mt-1 font-mono text-[10px] break-all">UID: {entry.uid}</p>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="border-status-starting/20 bg-status-starting/5 text-status-starting rounded-md border px-3 py-2 text-[11px] leading-relaxed">
      {children}
    </p>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="text-fg-dim py-2 text-[12px]">{children}</p>;
}
function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-fg-muted text-[10px] font-semibold tracking-wider uppercase">{children}</h3>
  );
}
