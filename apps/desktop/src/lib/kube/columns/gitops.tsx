import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, condition, isObject, spec, status } from '../accessors';
import { GITOPS_KEYS } from '../gitops/kinds';
import {
  argoAppStatus,
  argoDestination,
  argoHealthTone,
  argoSourceText,
  argoSources,
  argoSyncTone,
  fluxArtifact,
  fluxHealthTone,
  fluxSourceRef,
  fluxSourceReference,
  fluxStatus,
  helmReleaseChart,
  readyTone,
  shortRevision,
  timestampOf,
} from '../gitops/model';
import {
  ageColumn,
  Chips,
  Dash,
  Mono,
  Muted,
  nameColumn,
  namespaceColumn,
  RefLink,
  Tone,
} from './cells';
import type { ColumnDef, KindColumns } from './types';

/** Default columns for the Argo CD and Flux kinds (their own list pages). */

function textColumn(
  id: string,
  label: () => string,
  width: string,
  pick: (o: KubeObject) => string,
  opts: { mono?: boolean; hidden?: boolean } = {},
): ColumnDef {
  return {
    id,
    label,
    width,
    defaultHidden: opts.hidden,
    cell: (o) => {
      const v = pick(o);
      if (!v) return <Dash />;
      return opts.mono ? <Mono title={v}>{v}</Mono> : <Muted title={v}>{v}</Muted>;
    },
    sort: pick,
  };
}

const lastColumn = (
  id: string,
  label: () => string,
  pick: (o: KubeObject) => string,
): ColumnDef => ({
  id,
  label,
  width: '84px',
  align: 'right',
  cell: (o, ctx) => {
    const v = pick(o);
    return v ? (
      <span className="text-fg-muted tabular-nums" title={v}>
        {formatAge(v, ctx.now)}
      </span>
    ) : (
      <Dash />
    );
  },
  sort: (o) => -timestampOf(pick(o)),
});

// ---------------------------------------------------------------------------
// Argo CD
// ---------------------------------------------------------------------------

const applicationColumns: KindColumns = {
  searchText: (o) => {
    const s = argoAppStatus(o);
    return `${s.sync} ${s.health} ${s.revision} ${asString(spec(o).project)} ${argoDestination(o).text} ${argoSources(o).map(argoSourceText).join(' ')}`;
  },
  columns: [
    nameColumn,
    namespaceColumn,
    textColumn(
      'project',
      () => i18n.t('Project'),
      'minmax(84px, 0.8fr)',
      (o) => asString(spec(o).project),
    ),
    {
      id: 'sync',
      label: () => i18n.t('Sync'),
      width: '96px',
      cell: (o) => {
        const s = argoAppStatus(o);
        return <Tone tone={argoSyncTone(s.sync)}>{s.sync || 'Unknown'}</Tone>;
      },
      sort: (o) => argoAppStatus(o).sync,
    },
    {
      id: 'health',
      label: () => i18n.t('Health'),
      width: '100px',
      cell: (o) => {
        const s = argoAppStatus(o);
        return (
          <Tone tone={argoHealthTone(s.health)} title={s.healthMessage || undefined}>
            {s.health || 'Unknown'}
          </Tone>
        );
      },
      sort: (o) => argoAppStatus(o).health,
    },
    textColumn(
      'revision',
      () => i18n.t('Revision'),
      '96px',
      (o) => shortRevision(argoAppStatus(o).revision),
      {
        mono: true,
      },
    ),
    textColumn(
      'source',
      () => i18n.t('Source'),
      'minmax(160px, 2fr)',
      (o) => {
        const sources = argoSources(o);
        return sources.length > 1
          ? `${argoSourceText(sources[0]!)} +${sources.length - 1}`
          : sources[0]
            ? argoSourceText(sources[0])
            : '';
      },
    ),
    textColumn(
      'destination',
      () => i18n.t('Destination'),
      'minmax(120px, 1.2fr)',
      (o) => argoDestination(o).text,
    ),
    {
      id: 'auto-sync',
      label: () => i18n.t('Auto-sync'),
      width: '84px',
      cell: (o) => {
        const s = argoAppStatus(o);
        return s.automated ? (
          <Tone tone="success" title={s.selfHeal ? i18n.t('Self-heal on') : undefined}>
            {s.selfHeal ? i18n.t('Self-heal') : i18n.t('On')}
          </Tone>
        ) : (
          <Muted>{i18n.t('Manual')}</Muted>
        );
      },
      sort: (o) => (argoAppStatus(o).automated ? 1 : 0),
    },
    lastColumn(
      'last-sync',
      () => i18n.t('Last sync'),
      (o) => argoAppStatus(o).lastSync,
    ),
    { ...ageColumn, defaultHidden: true },
  ],
};

function generatorTypes(o: KubeObject): string[] {
  return asArray(spec(o).generators)
    .filter(isObject)
    .flatMap((g) => Object.keys(g));
}

const applicationSetColumns: KindColumns = {
  searchText: (o) => generatorTypes(o).join(' '),
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'generators',
      label: () => i18n.t('Generators'),
      width: 'minmax(140px, 1.4fr)',
      cell: (o) => <Chips values={generatorTypes(o)} max={3} />,
      sort: (o) => generatorTypes(o).join(','),
    },
    textColumn(
      'project',
      () => i18n.t('Project'),
      'minmax(84px, 0.8fr)',
      (o) => asString(asObject(asObject(spec(o).template).spec).project),
    ),
    {
      id: 'applications',
      label: () => i18n.t('Applications'),
      width: '96px',
      align: 'right',
      cell: (o) => <Muted>{asArray(status(o).resources).length}</Muted>,
      sort: (o) => asArray(status(o).resources).length,
    },
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: 'minmax(120px, 1.2fr)',
      cell: (o) => {
        const error = condition(o, 'ErrorOccurred');
        if (error?.status === 'True')
          return (
            <Tone tone="error" title={error.message}>
              {error.reason ?? error.type}
            </Tone>
          );
        const upToDate = condition(o, 'ResourcesUpToDate');
        if (!upToDate) return <Dash />;
        return (
          <Tone tone={upToDate.status === 'True' ? 'success' : 'warning'} title={upToDate.message}>
            {upToDate.reason ?? upToDate.type}
          </Tone>
        );
      },
    },
    ageColumn,
  ],
};

const appProjectColumns: KindColumns = {
  searchText: (o) => asString(spec(o).description),
  columns: [
    nameColumn,
    namespaceColumn,
    textColumn(
      'description',
      () => i18n.t('Description'),
      'minmax(160px, 2fr)',
      (o) => asString(spec(o).description),
    ),
    {
      id: 'sources',
      label: () => i18n.t('Source repositories'),
      width: 'minmax(140px, 1.6fr)',
      cell: (o) => <Chips values={asArray(spec(o).sourceRepos).map((r) => asString(r))} />,
    },
    {
      id: 'destinations',
      label: () => i18n.t('Destinations'),
      width: 'minmax(140px, 1.6fr)',
      cell: (o) => (
        <Chips
          values={asArray(spec(o).destinations)
            .filter(isObject)
            .map(
              (d) =>
                `${asString(d.name) || asString(d.server) || '*'}/${asString(d.namespace) || '*'}`,
            )}
        />
      ),
    },
    ageColumn,
  ],
};

// ---------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------

const readyColumn: ColumnDef = {
  id: 'ready',
  label: () => i18n.t('Ready'),
  width: '96px',
  cell: (o) => {
    const f = fluxStatus(o);
    return (
      <Tone tone={fluxHealthTone(f.health)} title={f.ready?.message}>
        {f.health}
      </Tone>
    );
  },
  sort: (o) => fluxStatus(o).health,
};

const reasonColumn: ColumnDef = {
  id: 'status',
  label: () => i18n.t('Status'),
  width: 'minmax(140px, 1.4fr)',
  cell: (o) => {
    const ready = fluxStatus(o).ready;
    if (!ready) return <Dash />;
    return (
      <Tone tone={readyTone(ready)} title={ready.message}>
        {ready.reason ?? ready.status}
      </Tone>
    );
  },
  sort: (o) => fluxStatus(o).ready?.reason ?? '',
};

const messageColumn: ColumnDef = textColumn(
  'message',
  () => i18n.t('Message'),
  'minmax(180px, 2.4fr)',
  (o) => fluxStatus(o).ready?.message ?? '',
  { hidden: true },
);

const suspendedColumn: ColumnDef = {
  id: 'suspended',
  label: () => i18n.t('Suspended'),
  width: '84px',
  cell: (o) => (fluxStatus(o).suspended ? <Tone tone="warning">{i18n.t('Yes')}</Tone> : <Dash />),
  sort: (o) => (fluxStatus(o).suspended ? 1 : 0),
};

const intervalColumn: ColumnDef = textColumn(
  'interval',
  () => i18n.t('Interval'),
  '72px',
  (o) => fluxStatus(o).interval,
  { mono: true },
);

const sourceRefColumn: ColumnDef = {
  id: 'source',
  label: () => i18n.t('Source'),
  width: 'minmax(140px, 1.4fr)',
  cell: (o, ctx) => {
    const ref = fluxSourceRef(o);
    return ref ? <RefLink target={ref} ctx={ctx} label={`${ref.kind}/${ref.name}`} /> : <Dash />;
  },
  sort: (o) => {
    const ref = fluxSourceRef(o);
    return ref ? `${ref.kind}/${ref.name}` : '';
  },
};

const appliedRevisionColumn: ColumnDef = {
  id: 'revision',
  label: () => i18n.t('Revision'),
  width: 'minmax(96px, 1fr)',
  cell: (o) => {
    const f = fluxStatus(o);
    const applied = f.lastAppliedRevision;
    const attempted = f.lastAttemptedRevision;
    if (!applied && !attempted) return <Dash />;
    const pending = attempted && attempted !== applied;
    return (
      <Mono title={pending ? `${applied}\n→ ${attempted}` : applied || attempted}>
        {shortRevision(applied || attempted)}
        {pending && <span className="text-status-starting ml-1">→ {shortRevision(attempted)}</span>}
      </Mono>
    );
  },
  sort: (o) => fluxStatus(o).lastAppliedRevision,
};

function fluxSearch(o: KubeObject): string {
  const f = fluxStatus(o);
  const ref = fluxSourceRef(o);
  return `${f.health} ${f.ready?.reason ?? ''} ${f.ready?.message ?? ''} ${f.lastAppliedRevision} ${ref ? `${ref.kind}/${ref.name}` : ''}`;
}

const kustomizationColumns: KindColumns = {
  searchText: (o) => `${fluxSearch(o)} ${asString(spec(o).path)}`,
  columns: [
    nameColumn,
    namespaceColumn,
    readyColumn,
    reasonColumn,
    appliedRevisionColumn,
    sourceRefColumn,
    textColumn(
      'path',
      () => i18n.t('Path'),
      'minmax(120px, 1.2fr)',
      (o) => asString(spec(o).path),
      {
        mono: true,
      },
    ),
    intervalColumn,
    suspendedColumn,
    messageColumn,
    ageColumn,
  ],
};

const helmReleaseColumns: KindColumns = {
  searchText: (o) => `${fluxSearch(o)} ${helmReleaseChart(o).chart}`,
  columns: [
    nameColumn,
    namespaceColumn,
    readyColumn,
    reasonColumn,
    textColumn(
      'chart',
      () => i18n.t('Chart'),
      'minmax(120px, 1.2fr)',
      (o) => {
        const c = helmReleaseChart(o);
        return c.chart ? `${c.chart}@${c.version || '*'}` : '';
      },
    ),
    appliedRevisionColumn,
    sourceRefColumn,
    intervalColumn,
    suspendedColumn,
    messageColumn,
    ageColumn,
  ],
};

const artifactRevisionColumn: ColumnDef = {
  id: 'revision',
  label: () => i18n.t('Revision'),
  width: 'minmax(96px, 1fr)',
  cell: (o) => {
    const a = fluxArtifact(o);
    return a?.revision ? <Mono title={a.revision}>{shortRevision(a.revision)}</Mono> : <Dash />;
  },
  sort: (o) => fluxArtifact(o)?.revision ?? '',
};

function sourceColumns(extra: ColumnDef[]): KindColumns {
  return {
    searchText: (o) => `${fluxSearch(o)} ${asString(spec(o).url)} ${fluxSourceReference(o)}`,
    columns: [
      nameColumn,
      namespaceColumn,
      ...extra,
      readyColumn,
      artifactRevisionColumn,
      intervalColumn,
      suspendedColumn,
      messageColumn,
      ageColumn,
    ],
  };
}

const urlColumn = textColumn(
  'url',
  () => i18n.t('URL'),
  'minmax(180px, 2fr)',
  (o) => asString(spec(o).url),
  {
    mono: true,
  },
);
const refColumn = textColumn(
  'ref',
  () => i18n.t('Reference'),
  'minmax(96px, 1fr)',
  fluxSourceReference,
  {
    mono: true,
  },
);

const helmChartColumns: KindColumns = sourceColumns([
  textColumn('chart', () => i18n.t('Chart'), 'minmax(120px, 1.2fr)', fluxSourceReference, {
    mono: true,
  }),
  sourceRefColumn,
]);

const genericFluxColumns: KindColumns = {
  searchText: fluxSearch,
  columns: [
    nameColumn,
    namespaceColumn,
    readyColumn,
    reasonColumn,
    suspendedColumn,
    messageColumn,
    ageColumn,
  ],
};

/** Kind key → columns; merged into the column registry. */
export const GITOPS_COLUMNS: Record<string, KindColumns> = {
  [GITOPS_KEYS.application]: applicationColumns,
  [GITOPS_KEYS.applicationSet]: applicationSetColumns,
  [GITOPS_KEYS.appProject]: appProjectColumns,
  [GITOPS_KEYS.kustomization]: kustomizationColumns,
  [GITOPS_KEYS.helmRelease]: helmReleaseColumns,
  'gitrepositories.source.toolkit.fluxcd.io': sourceColumns([urlColumn, refColumn]),
  'ocirepositories.source.toolkit.fluxcd.io': sourceColumns([urlColumn, refColumn]),
  'helmrepositories.source.toolkit.fluxcd.io': sourceColumns([
    urlColumn,
    textColumn('type', () => i18n.t('Type'), '72px', fluxSourceReference),
  ]),
  'buckets.source.toolkit.fluxcd.io': sourceColumns([
    textColumn(
      'endpoint',
      () => i18n.t('Endpoint'),
      'minmax(160px, 1.6fr)',
      (o) => asString(spec(o).endpoint),
      {
        mono: true,
      },
    ),
    refColumn,
  ]),
  'helmcharts.source.toolkit.fluxcd.io': helmChartColumns,
  'alerts.notification.toolkit.fluxcd.io': genericFluxColumns,
  'providers.notification.toolkit.fluxcd.io': genericFluxColumns,
  'receivers.notification.toolkit.fluxcd.io': genericFluxColumns,
  'imagerepositories.image.toolkit.fluxcd.io': genericFluxColumns,
  'imagepolicies.image.toolkit.fluxcd.io': genericFluxColumns,
  'imageupdateautomations.image.toolkit.fluxcd.io': genericFluxColumns,
};
