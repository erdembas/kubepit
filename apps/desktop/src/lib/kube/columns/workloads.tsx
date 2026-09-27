import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asObject, asString, spec, status } from '../accessors';
import { selectorText } from '../selectors';
import {
  cronActive,
  cronSuspended,
  jobBucket,
  jobCompletions,
  replicaCounts,
  workloadConditions,
} from '../workloads';
import {
  ageColumn,
  Chips,
  ConditionWords,
  Dash,
  Muted,
  nameColumn,
  namespaceColumn,
  ownerRef,
  RefLink,
  Tone,
} from './cells';
import type { ColumnDef, KindColumns } from './types';

/** Controller tables: Deployments, StatefulSets, DaemonSets, ReplicaSets, RCs, Jobs, CronJobs. */

const conditionsColumn: ColumnDef = {
  id: 'conditions',
  label: () => i18n.t('Conditions'),
  width: 'minmax(140px, 1.4fr)',
  cell: (o) => <ConditionWords chips={workloadConditions(o)} />,
  sort: (o) =>
    workloadConditions(o)
      .map((c) => c.label)
      .join(','),
};

function readyOf(o: KubeObject) {
  const c = replicaCounts(o);
  const tone =
    c.desired === 0
      ? 'muted'
      : c.ready >= c.desired
        ? 'success'
        : c.ready === 0
          ? 'error'
          : 'warning';
  return <Tone tone={tone}>{`${c.ready}/${c.desired}`}</Tone>;
}

const podsColumn: ColumnDef = {
  id: 'pods',
  label: () => i18n.t('Pods'),
  width: '72px',
  cell: readyOf,
  sort: (o) => replicaCounts(o).ready,
};

const replicasColumn: ColumnDef = {
  id: 'replicas',
  label: () => i18n.t('Replicas'),
  width: '76px',
  align: 'right',
  cell: (o) => <Muted>{replicaCounts(o).desired}</Muted>,
  sort: (o) => replicaCounts(o).desired,
};

const count = (id: string, label: () => string, pick: (o: KubeObject) => number): ColumnDef => ({
  id,
  label,
  width: '72px',
  align: 'right',
  cell: (o) => <Muted>{pick(o)}</Muted>,
  sort: pick,
});

export const deploymentColumns: KindColumns = {
  columns: [nameColumn, namespaceColumn, podsColumn, replicasColumn, ageColumn, conditionsColumn],
};

export const statefulSetColumns: KindColumns = {
  columns: [nameColumn, namespaceColumn, podsColumn, replicasColumn, ageColumn],
};

export const daemonSetColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    count(
      'desired',
      () => i18n.t('Desired'),
      (o) => replicaCounts(o).desired,
    ),
    count(
      'current',
      () => i18n.t('Current'),
      (o) => replicaCounts(o).current,
    ),
    {
      id: 'ready',
      label: () => i18n.t('Ready'),
      width: '72px',
      cell: readyOf,
      sort: (o) => replicaCounts(o).ready,
    },
    {
      id: 'selector',
      label: () => i18n.t('Node Selector'),
      width: 'minmax(140px, 1.5fr)',
      cell: (o) => (
        <Chips
          values={Object.entries(
            asObject(asObject(asObject(spec(o).template).spec).nodeSelector),
          ).map(([k, v]) => `${k}=${asString(v)}`)}
        />
      ),
    },
    ageColumn,
  ],
};

export const replicaSetColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    count(
      'desired',
      () => i18n.t('Desired'),
      (o) => replicaCounts(o).desired,
    ),
    count(
      'current',
      () => i18n.t('Current'),
      (o) => replicaCounts(o).current,
    ),
    {
      id: 'ready',
      label: () => i18n.t('Ready'),
      width: '72px',
      cell: readyOf,
      sort: (o) => replicaCounts(o).ready,
    },
    {
      id: 'controlled',
      label: () => i18n.t('Controlled By'),
      width: 'minmax(120px, 1.2fr)',
      defaultHidden: true,
      cell: (o, ctx) => {
        const ref = ownerRef(o);
        return ref ? <RefLink target={ref} ctx={ctx} /> : <Dash />;
      },
    },
    ageColumn,
  ],
};

export const replicationControllerColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    count(
      'replicas',
      () => i18n.t('Replicas'),
      (o) => replicaCounts(o).desired,
    ),
    count(
      'current',
      () => i18n.t('Current'),
      (o) => replicaCounts(o).current,
    ),
    {
      id: 'ready',
      label: () => i18n.t('Ready'),
      width: '72px',
      cell: readyOf,
      sort: (o) => replicaCounts(o).ready,
    },
    {
      id: 'selector',
      label: () => i18n.t('Selector'),
      width: 'minmax(140px, 1.5fr)',
      cell: (o) => <Chips values={selectorText(spec(o).selector)} />,
    },
    ageColumn,
  ],
};

export const jobColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'completions',
      label: () => i18n.t('Completions'),
      width: '96px',
      cell: (o) => {
        const c = jobCompletions(o);
        return (
          <Tone
            tone={
              c.succeeded >= c.completions
                ? 'success'
                : jobBucket(o) === 'failed'
                  ? 'error'
                  : 'muted'
            }
          >{`${c.succeeded}/${c.completions}`}</Tone>
        );
      },
      sort: (o) => jobCompletions(o).succeeded,
    },
    ageColumn,
    {
      id: 'conditions',
      label: () => i18n.t('Conditions'),
      width: 'minmax(120px, 1.2fr)',
      cell: (o) => {
        const b = jobBucket(o);
        return (
          <Tone
            tone={
              b === 'succeeded'
                ? 'success'
                : b === 'failed'
                  ? 'error'
                  : b === 'suspended'
                    ? 'muted'
                    : 'info'
            }
          >
            {b === 'succeeded'
              ? 'Complete'
              : b === 'failed'
                ? 'Failed'
                : b === 'suspended'
                  ? 'Suspended'
                  : 'Running'}
          </Tone>
        );
      },
      sort: jobBucket,
    },
  ],
};

export const cronJobColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'schedule',
      label: () => i18n.t('Schedule'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => (
        <span className="text-fg-muted truncate font-mono text-[11px]">
          {asString(spec(o).schedule)}
        </span>
      ),
      sort: (o) => asString(spec(o).schedule),
    },
    {
      id: 'suspend',
      label: () => i18n.t('Suspend'),
      width: '76px',
      cell: (o) =>
        cronSuspended(o) ? (
          <Tone tone="warning">{i18n.t('True')}</Tone>
        ) : (
          <Muted>{i18n.t('False')}</Muted>
        ),
      sort: (o) => (cronSuspended(o) ? 1 : 0),
    },
    count('active', () => i18n.t('Active'), cronActive),
    {
      id: 'last',
      label: () => i18n.t('Last schedule'),
      width: '104px',
      align: 'right',
      cell: (o, ctx) => {
        const t = asString(status(o).lastScheduleTime);
        return t ? (
          <span className="text-fg-muted tabular-nums" title={t}>
            {formatAge(t, ctx.now)}
          </span>
        ) : (
          <Dash />
        );
      },
      sort: (o) => -Date.parse(asString(status(o).lastScheduleTime) || '0'),
    },
    ageColumn,
  ],
};
