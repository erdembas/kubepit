import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { ArrowRight, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import { hasListError, isListComplete } from '../data/listState';
import { restartWatch, useWatch } from '../data/watchCache';
import { ExpiryBadge } from '../details/sections/CertificateSections';
import { useNow } from '../util';
import { Card } from './charts';
import { summarizeTlsSecrets, type TlsCertificateGroup, type TlsSecretEntry } from './tlsSummary';

const SECRET_GVK = toGvk(BUILTIN.Secret);
const ALL_NAMESPACES: readonly string[] = [];
const PREVIEW_LIMIT = 5;
const NAMESPACE_LIMIT = 6;

function groupName(group: TlsCertificateGroup): string {
  const name = group.entry.object.metadata.name;
  if (group.members.every((member) => member.object.metadata.name === name)) return name;
  const cert = group.entry.certificate;
  return cert?.subject.cn || cert?.sans[0] || name;
}

function NamespaceTags({ group, clusterId }: { group: TlsCertificateGroup; clusterId: string }) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const namespaces = expanded ? group.namespaces : group.namespaces.slice(0, NAMESPACE_LIMIT);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {namespaces.map((namespace) => {
        const members = group.members.filter(
          (member) => (member.object.metadata.namespace ?? '') === namespace,
        );
        return (
          <button
            key={namespace}
            type="button"
            title={members
              .map((member) => `${namespace}/${member.object.metadata.name}`)
              .join('\n')}
            onClick={() => {
              if (members.length === 1) {
                navigateTo(
                  clusterId,
                  SECRET_GVK,
                  namespace || null,
                  members[0]!.object.metadata.name,
                );
              } else {
                const store = useWorkbenchStore.getState();
                store.setNamespaces(clusterId, namespace ? [namespace] : []);
                store.select(clusterId, 'secrets', null);
                navigateTo(clusterId, SECRET_GVK);
              }
            }}
            className="bg-fg/5 text-fg-muted ring-border/60 hover:bg-fg/8 hover:text-fg max-w-full truncate rounded-md px-1.5 py-0.5 text-left font-mono text-[10.5px] ring-1 transition"
          >
            {namespace || i18n.t('Unknown')}
          </button>
        );
      })}
      {group.namespaces.length > NAMESPACE_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-accent px-1 text-[11px] hover:underline"
        >
          {expanded
            ? i18n.t('Show less')
            : i18n.t('Show all {count}', { count: group.namespaces.length })}
        </button>
      )}
    </div>
  );
}

function ExpiryStatus({ entry }: { entry: TlsSecretEntry }) {
  i18n.useLocale();
  return entry.invalid || !entry.expiry ? (
    <Badge tone="warning" size="sm">
      {i18n.t('Certificate unreadable')}
    </Badge>
  ) : (
    <ExpiryBadge expiry={entry.expiry} />
  );
}

/** Cluster-wide, live TLS expiry summary; shares the Secrets watch with health and tables. */
export function TlsSummaryCard({ clusterId, isActive }: { clusterId: string; isActive: boolean }) {
  i18n.useLocale();
  const secrets = useWatch(clusterId, SECRET_GVK, ALL_NAMESPACES, isActive);
  const now = useNow(30_000, isActive);
  const summary = useMemo(() => summarizeTlsSecrets(secrets.items, now), [secrets.items, now]);
  const complete = isListComplete(secrets);
  const failed = hasListError(secrets);
  const showSummary = complete || summary.total > 0;
  const nextEntry = summary.earliestExpiry;
  const next = nextEntry
    ? summary.groups.find((group) => group.members.includes(nextEntry))
    : undefined;
  const open = (entry: TlsSecretEntry) =>
    navigateTo(
      clusterId,
      SECRET_GVK,
      entry.object.metadata.namespace ?? null,
      entry.object.metadata.name,
    );
  const counts = [
    { label: i18n.t('TLS Secrets'), value: summary.total, tone: 'text-fg' },
    { label: i18n.t('Expired'), value: summary.expired, tone: 'text-status-error' },
    { label: i18n.t('Within 7 days'), value: summary.within7Days, tone: 'text-status-starting' },
    { label: i18n.t('In 8–30 days'), value: summary.days8To30, tone: 'text-status-starting' },
  ];

  return (
    <Card
      title={i18n.t('TLS certificates')}
      icon={<ShieldCheck />}
      actions={
        <>
          <span className="text-fg-dim hidden text-[11px] sm:inline">
            {i18n.t('All namespaces')}
          </span>
          <button
            type="button"
            onClick={() => {
              useWorkbenchStore.getState().setNamespaces(clusterId, []);
              navigateTo(clusterId, SECRET_GVK);
            }}
            className="text-fg-dim hover:text-accent flex items-center gap-1 text-[11px]"
          >
            {i18n.t('View Secrets')}
            <ArrowRight className="h-3 w-3" />
          </button>
        </>
      }
    >
      {!complete && (
        <div
          className={cn(
            'flex items-start gap-2 px-4 py-3 text-[11.5px]',
            failed ? 'text-tone-warning-fg' : 'text-fg-dim',
            showSummary && 'border-border/60 border-b',
          )}
          role={failed ? 'status' : undefined}
        >
          {failed ? (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          )}
          <span className="min-w-0 flex-1" title={secrets.error ?? undefined}>
            {failed
              ? showSummary
                ? i18n.t('Some Secrets could not be read. This TLS summary is incomplete.')
                : i18n.t('TLS Secrets could not be read.')
              : showSummary
                ? i18n.t('Updating TLS certificates. Counts may be incomplete.')
                : i18n.t('Reading TLS certificates…')}
          </span>
          {failed && (
            <button
              type="button"
              onClick={() => restartWatch(clusterId, SECRET_GVK, ALL_NAMESPACES)}
              className="hover:text-fg shrink-0 underline underline-offset-2"
            >
              {i18n.t('Retry')}
            </button>
          )}
        </div>
      )}
      {showSummary &&
        (summary.total === 0 ? (
          <p className="text-fg-dim px-4 py-5 text-[12px]">{i18n.t('No TLS Secrets found.')}</p>
        ) : (
          <div className="@container">
            <div className="grid gap-4 p-4 @2xl:grid-cols-2">
              <div className="min-w-0 space-y-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @xl:grid-cols-4 @2xl:grid-cols-2 @4xl:grid-cols-4">
                  {counts.map(({ label, value, tone }) => (
                    <div key={label}>
                      <dt className="text-fg-dim text-[10.5px] font-semibold tracking-[0.1em] uppercase">
                        {label}
                      </dt>
                      <dd
                        className={cn(
                          'mt-1 text-[20px] leading-none font-semibold tabular-nums',
                          value ? tone : 'text-fg',
                        )}
                      >
                        {i18n.number(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {next?.entry.certificate && (
                  <div className="border-border/60 space-y-1 border-t pt-3">
                    <p className="text-fg-dim text-[10.5px] font-semibold tracking-[0.1em] uppercase">
                      {i18n.t('Next expiry')}
                    </p>
                    <button
                      type="button"
                      onClick={() => open(next.entry)}
                      className="hover:bg-fg/4 -mx-1.5 flex w-[calc(100%+12px)] flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 text-left"
                    >
                      <ExpiryStatus entry={next.entry} />
                      <span className="text-fg-muted text-[11px] tabular-nums">
                        {i18n.date(next.entry.certificate.notAfter, { dateStyle: 'medium' })}
                      </span>
                      <span className="text-fg-dim w-full truncate text-[11px]">
                        {groupName(next)}
                      </span>
                    </button>
                    <NamespaceTags key={next.id} group={next} clusterId={clusterId} />
                  </div>
                )}
                <div className="text-fg-dim space-y-1 text-[11px]">
                  {summary.valid > 0 && (
                    <p>
                      {i18n.plural(
                        '{count} TLS Secret expires after 30 days',
                        '{count} TLS Secrets expire after 30 days',
                        summary.valid,
                      )}
                    </p>
                  )}
                  {summary.notYetValid > 0 && (
                    <p className="text-tone-info-fg">
                      {i18n.plural(
                        '{count} TLS Secret has a certificate that is not valid yet',
                        '{count} TLS Secrets have certificates that are not valid yet',
                        summary.notYetValid,
                      )}
                    </p>
                  )}
                  {summary.unknown > 0 && (
                    <p className="text-tone-warning-fg">
                      {i18n.plural(
                        '{count} TLS Secret has missing or unreadable certificate data',
                        '{count} TLS Secrets have missing or unreadable certificate data',
                        summary.unknown,
                      )}
                    </p>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-fg-dim mb-1.5 text-[10.5px] font-semibold tracking-[0.1em] uppercase">
                  {i18n.t('Certificate status')}
                </p>
                <ul className="space-y-1">
                  {summary.groups.slice(0, PREVIEW_LIMIT).map((group) => (
                    <li
                      key={group.id}
                      className="hover:bg-fg/4 -mx-1.5 space-y-1.5 rounded-md px-1.5 py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => open(group.entry)}
                        className="flex w-full items-center gap-2 text-left"
                      >
                        <span
                          className="text-fg min-w-0 flex-1 truncate text-[12px]"
                          title={groupName(group)}
                        >
                          {groupName(group)}
                        </span>
                        <span
                          title={
                            group.entry.certificate
                              ? i18n.date(group.entry.certificate.notAfter, {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                })
                              : undefined
                          }
                        >
                          <ExpiryStatus entry={group.entry} />
                        </span>
                      </button>
                      <NamespaceTags group={group} clusterId={clusterId} />
                    </li>
                  ))}
                </ul>
                {summary.groups.length > PREVIEW_LIMIT && (
                  <p className="text-fg-dim mt-2 text-[11px]">
                    {i18n.t('Showing {shown} of {total} certificate groups', {
                      shown: PREVIEW_LIMIT,
                      total: summary.groups.length,
                    })}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
    </Card>
  );
}
