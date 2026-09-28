import * as i18n from '@/i18n/core';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import {
  TRIVY_KEYS,
  checkCounts,
  complianceSummary,
  reportCounts,
  reportImage,
  reportTarget,
  sbomSummary,
  secretCounts,
  updatedAt,
  vulnerabilities,
  workloadOf,
  type SeverityCounts,
} from '../trivy';
import { Dash, Mono, Muted, RefLink, standard } from './cells';
import type { ColumnDef, KindColumns } from './types';

/** Default columns for the Trivy Operator report kinds. */

const SEV_CLASS: Record<keyof SeverityCounts, string> = {
  critical: 'text-status-error',
  high: 'text-cat-infra',
  medium: 'text-status-starting',
  low: 'text-cat-frontend',
  unknown: 'text-fg-dim',
};

const resourceColumn: ColumnDef = {
  id: 'resource',
  label: () => i18n.t('Resource'),
  width: 'minmax(150px, 2fr)',
  cell: (o, ctx) => {
    const t = reportTarget(o);
    if (!t.name) return <Dash />;
    return (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-fg-dim shrink-0 text-[10.5px]">{t.kind}</span>
        <RefLink target={{ kind: t.kind, name: t.name, namespace: t.namespace }} ctx={ctx} />
      </span>
    );
  },
  sort: (o) => `${reportTarget(o).kind}/${reportTarget(o).name}`,
  text: (o) => `${reportTarget(o).kind}/${reportTarget(o).name}`,
};

const workloadColumn: ColumnDef = {
  id: 'workload',
  label: () => i18n.t('Workload'),
  width: 'minmax(120px, 1.4fr)',
  defaultHidden: true,
  cell: (o) => {
    const w = workloadOf(reportTarget(o));
    return w.name ? <Muted title={`${w.kind} ${w.name}`}>{w.name}</Muted> : <Dash />;
  },
  sort: (o) => workloadOf(reportTarget(o)).name,
};

const containerColumn: ColumnDef = {
  id: 'container',
  label: () => i18n.t('Container'),
  width: 'minmax(90px, 1fr)',
  cell: (o) => {
    const c = reportTarget(o).container;
    return c ? <Muted>{c}</Muted> : <Dash />;
  },
  sort: (o) => reportTarget(o).container,
};

const imageColumn: ColumnDef = {
  id: 'image',
  label: () => i18n.t('Image'),
  width: 'minmax(180px, 2.4fr)',
  cell: (o) => {
    const img = reportImage(o);
    return img.text ? <Mono title={img.digest || img.text}>{img.text}</Mono> : <Dash />;
  },
  sort: (o) => reportImage(o).text,
};

function countColumn(
  key: keyof SeverityCounts,
  label: () => string,
  counts: (o: KubeObject) => SeverityCounts,
  hidden = false,
): ColumnDef {
  return {
    id: key,
    label,
    width: '64px',
    align: 'right',
    defaultHidden: hidden,
    cell: (o) => {
      const n = counts(o)[key];
      return (
        <span
          className={cn('tabular-nums', n ? cn(SEV_CLASS[key], 'font-semibold') : 'text-fg-dim/50')}
        >
          {n}
        </span>
      );
    },
    // Descending by default reads naturally: most findings first.
    sort: (o) => -counts(o)[key],
    value: (o) => counts(o)[key],
  };
}

function severityColumns(counts: (o: KubeObject) => SeverityCounts, unknown = false): ColumnDef[] {
  return [
    countColumn('critical', () => i18n.t('Critical'), counts),
    countColumn('high', () => i18n.t('High'), counts),
    countColumn('medium', () => i18n.t('Medium'), counts),
    countColumn('low', () => i18n.t('Low'), counts),
    ...(unknown ? [countColumn('unknown', () => i18n.t('Unknown'), counts, true)] : []),
  ];
}

const fixableColumn: ColumnDef = {
  id: 'fixable',
  label: () => i18n.t('Fixable'),
  width: '68px',
  align: 'right',
  cell: (o) => {
    const n = vulnerabilities(o).filter((v) => v.fixed).length;
    return <span className={cn('tabular-nums', n ? 'text-fg-muted' : 'text-fg-dim/50')}>{n}</span>;
  },
  sort: (o) => -vulnerabilities(o).filter((v) => v.fixed).length,
};

const updatedColumn: ColumnDef = {
  id: 'updated',
  label: () => i18n.t('Updated'),
  width: '76px',
  align: 'right',
  cell: (o, ctx) => {
    const v = updatedAt(o);
    return v ? (
      <span className="text-fg-muted tabular-nums" title={v}>
        {formatAge(v, ctx.now)}
      </span>
    ) : (
      <Dash />
    );
  },
  sort: (o) => -(Date.parse(updatedAt(o)) || 0),
  value: (o) => updatedAt(o) || null,
};

function searchText(o: KubeObject): string {
  const t = reportTarget(o);
  return `${t.kind} ${t.name} ${t.container} ${reportImage(o).text}`;
}

function vulnColumns(namespaced: boolean): KindColumns {
  return {
    columns: standard(namespaced, [
      resourceColumn,
      workloadColumn,
      containerColumn,
      imageColumn,
      ...severityColumns((o) => reportCounts(o), true),
      fixableColumn,
      updatedColumn,
    ]),
    defaultSort: { column: 'critical', desc: false },
    searchText,
  };
}

function checkColumns(namespaced: boolean): KindColumns {
  return {
    columns: standard(namespaced, [resourceColumn, ...severityColumns(checkCounts), updatedColumn]),
    defaultSort: { column: 'critical', desc: false },
    searchText,
  };
}

const secretColumns: KindColumns = {
  columns: standard(true, [
    resourceColumn,
    containerColumn,
    imageColumn,
    ...severityColumns(secretCounts),
    updatedColumn,
  ]),
  defaultSort: { column: 'critical', desc: false },
  searchText,
};

const complianceColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'title',
      label: () => i18n.t('Standard'),
      width: 'minmax(180px, 2.4fr)',
      cell: (o) => (
        <Muted title={complianceSummary(o).description}>{complianceSummary(o).title}</Muted>
      ),
      sort: (o) => complianceSummary(o).title,
    },
    {
      id: 'pass',
      label: () => i18n.t('Pass'),
      width: '64px',
      align: 'right',
      cell: (o) => (
        <span className="text-status-running tabular-nums">{complianceSummary(o).pass}</span>
      ),
      sort: (o) => -complianceSummary(o).pass,
    },
    {
      id: 'fail',
      label: () => i18n.t('Fail'),
      width: '64px',
      align: 'right',
      cell: (o) => {
        const n = complianceSummary(o).fail;
        return (
          <span
            className={cn('tabular-nums', n ? 'text-status-error font-semibold' : 'text-fg-dim/50')}
          >
            {n}
          </span>
        );
      },
      sort: (o) => -complianceSummary(o).fail,
    },
    {
      id: 'schedule',
      label: () => i18n.t('Schedule'),
      width: '110px',
      defaultHidden: true,
      cell: (o) => {
        const s = complianceSummary(o).schedule;
        return s ? <Mono>{s}</Mono> : <Dash />;
      },
      sort: (o) => complianceSummary(o).schedule,
    },
    {
      id: 'updated',
      label: () => i18n.t('Updated'),
      width: '76px',
      align: 'right',
      cell: (o, ctx) => {
        const v = complianceSummary(o).updated;
        return v ? (
          <span className="text-fg-muted tabular-nums" title={v}>
            {formatAge(v, ctx.now)}
          </span>
        ) : (
          <Dash />
        );
      },
      sort: (o) => -(Date.parse(complianceSummary(o).updated) || 0),
    },
  ]),
  defaultSort: { column: 'fail', desc: false },
};

function sbomColumns(namespaced: boolean): KindColumns {
  return {
    columns: standard(namespaced, [
      resourceColumn,
      containerColumn,
      imageColumn,
      {
        id: 'components',
        label: () => i18n.t('Components'),
        width: '96px',
        align: 'right',
        cell: (o) => (
          <span className="text-fg-muted tabular-nums">{sbomSummary(o).components}</span>
        ),
        sort: (o) => -sbomSummary(o).components,
      },
      updatedColumn,
    ]),
    searchText,
  };
}

export const TRIVY_COLUMNS: Record<string, KindColumns> = {
  [TRIVY_KEYS.VulnerabilityReport]: vulnColumns(true),
  [TRIVY_KEYS.ClusterVulnerabilityReport]: vulnColumns(false),
  [TRIVY_KEYS.ConfigAuditReport]: checkColumns(true),
  [TRIVY_KEYS.ClusterConfigAuditReport]: checkColumns(false),
  [TRIVY_KEYS.ExposedSecretReport]: secretColumns,
  [TRIVY_KEYS.RbacAssessmentReport]: checkColumns(true),
  [TRIVY_KEYS.ClusterRbacAssessmentReport]: checkColumns(false),
  [TRIVY_KEYS.InfraAssessmentReport]: checkColumns(true),
  [TRIVY_KEYS.ClusterInfraAssessmentReport]: checkColumns(false),
  [TRIVY_KEYS.ClusterComplianceReport]: complianceColumns,
  [TRIVY_KEYS.SbomReport]: sbomColumns(true),
  [TRIVY_KEYS.ClusterSbomReport]: sbomColumns(false),
};
