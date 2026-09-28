import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { CircleCheck, ShieldAlert } from 'lucide-react';
import { builtinByGroupKind, parseApiVersion } from '@/lib/kube/catalog';
import type { ColumnContext } from '@/lib/kube/columns';
import { checkTitle, evaluatePod, passingLevel, podInputOf } from '@/lib/kube/pss';
import {
  bindingsOfRole,
  roleKey,
  roleRisks,
  subjectPermissions,
  type RiskId,
  type Subject,
} from '@/lib/kube/rbac';
import { riskLabel } from '@/lib/kube/rbac/titles';
import {
  checkCounts,
  detectTrivy,
  reportCounts,
  reportImage,
  reportTarget,
  reportsFor,
  secretCounts,
  totalOf,
  trivyGvk,
  type TrivyKind,
} from '@/lib/kube/trivy';
import type { KubeObject } from '@/types';
import { PermissionRows } from '../access/PermissionRows';
import { BindingPath, SubjectLabel } from '../access/rbacLinks';
import { useRbacData } from '../access/useRbacData';
import { useWatch } from '../data/watchCache';
import { Section } from '../details/primitives';
import type { SectionProps } from '../details/sections/types';
import { usePodSpecOwners } from './hooks';
import { PodSecurityPanel } from './PodSecurityPanel';
import { CountCells } from './severity';

/**
 * Security sections appended to the details of built-in objects: Trivy
 * reports and Pod Security level of workloads and pods, Pod Security of a
 * namespace, what a ServiceAccount can do and who is bound to a role.
 */

const WORKLOADS = new Set([
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
]);

function openRef(ctx: ColumnContext, o: KubeObject) {
  ctx.navigate({
    apiVersion: o.apiVersion,
    kind: o.kind,
    name: o.metadata.name,
    namespace: o.metadata.namespace ?? null,
  });
}

// ---------------------------------------------------------------------------
// Workloads and pods
// ---------------------------------------------------------------------------

function PodSecurityLevel({ obj }: { obj: KubeObject }) {
  i18n.useLocale();
  const input = useMemo(() => podInputOf(obj), [obj]);
  if (!input) return null;
  const level = passingLevel(input);
  const failing =
    level === 'restricted'
      ? []
      : evaluatePod(
          { level: level === 'baseline' ? 'restricted' : 'baseline', version: 'latest' },
          input,
        );
  return (
    <div className="flex items-start gap-2 text-[12px]">
      {level === 'restricted' ? (
        <CircleCheck className="text-status-running mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <ShieldAlert
          className={
            level === 'baseline'
              ? 'text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0'
              : 'text-status-error mt-0.5 h-3.5 w-3.5 shrink-0'
          }
        />
      )}
      <span className="min-w-0">
        <span className="text-fg">
          {level === 'restricted'
            ? i18n.t('Passes the restricted Pod Security level')
            : level === 'baseline'
              ? i18n.t('Passes baseline, fails restricted')
              : i18n.t('Fails the baseline Pod Security level')}
        </span>
        {failing.length > 0 && (
          <span className="text-fg-muted block text-[11px] leading-relaxed">
            {failing.map((v) => checkTitle(v.check)).join(', ')}
          </span>
        )}
      </span>
    </div>
  );
}

function useReports(
  ctx: ColumnContext,
  kind: TrivyKind,
  namespace: string | null,
  enabled: boolean,
): readonly KubeObject[] {
  const gvk = useMemo(
    () => (enabled ? trivyGvk(kind, ctx.apiResources) : null),
    [enabled, kind, ctx.apiResources],
  );
  return useWatch(ctx.clusterId, gvk, namespace ? [namespace] : [], enabled && !!gvk).items;
}

function ReportLine({
  label,
  counts,
  onOpen,
  detail,
}: {
  label: string;
  counts: ReturnType<typeof reportCounts>;
  onOpen: () => void;
  detail?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-fg/4 group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="text-fg group-hover:text-accent block truncate text-[12px]">
            {label}
          </span>
          {detail && (
            <span className="text-fg-dim block truncate font-mono text-[10.5px]">{detail}</span>
          )}
        </span>
        <CountCells counts={counts} />
      </button>
    </li>
  );
}

function WorkloadSecurity({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const trivy = detectTrivy(ctx.apiResources);
  const ns = obj.metadata.namespace ?? null;
  const vulns = useReports(ctx, 'VulnerabilityReport', ns, isActive && trivy);
  const audits = useReports(ctx, 'ConfigAuditReport', ns, isActive && trivy);
  const secrets = useReports(ctx, 'ExposedSecretReport', ns, isActive && trivy);
  const mine = useMemo(
    () => ({
      vulns: reportsFor(obj, vulns),
      audits: reportsFor(obj, audits),
      secrets: reportsFor(obj, secrets).filter((r) => totalOf(secretCounts(r)) > 0),
    }),
    [obj, vulns, audits, secrets],
  );
  const none = !mine.vulns.length && !mine.audits.length && !mine.secrets.length;
  return (
    <Section title={i18n.t('Security')}>
      <PodSecurityLevel obj={obj} />
      {trivy && (
        <div className="mt-3">
          <h4 className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Trivy reports')}
          </h4>
          {none ? (
            <p className="text-fg-dim text-[12px]">
              {i18n.t('Trivy Operator has not reported on this workload yet.')}
            </p>
          ) : (
            <ul className="-mx-1.5">
              {mine.vulns.map((r) => {
                const t = reportTarget(r);
                return (
                  <ReportLine
                    key={r.metadata.uid}
                    label={i18n.t('Vulnerabilities · {container}', {
                      container: t.container || t.name,
                    })}
                    detail={reportImage(r).text}
                    counts={reportCounts(r)}
                    onOpen={() => openRef(ctx, r)}
                  />
                );
              })}
              {mine.audits.map((r) => (
                <ReportLine
                  key={r.metadata.uid}
                  label={i18n.t('Configuration audit')}
                  counts={checkCounts(r)}
                  onOpen={() => openRef(ctx, r)}
                />
              ))}
              {mine.secrets.map((r) => (
                <ReportLine
                  key={r.metadata.uid}
                  label={i18n.t('Exposed secrets · {container}', {
                    container: reportTarget(r).container || reportTarget(r).name,
                  })}
                  detail={reportImage(r).text}
                  counts={secretCounts(r)}
                  onOpen={() => openRef(ctx, r)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

function NamespacePodSecurity({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const scope = useMemo(() => [obj.metadata.name], [obj.metadata.name]);
  const data = usePodSpecOwners(ctx.clusterId, ctx.apiResources, scope, isActive);
  const owners = useMemo(
    () => data.owners.filter((o) => o.metadata.namespace === obj.metadata.name),
    [data.owners, obj.metadata.name],
  );
  return (
    <Section title={i18n.t('Pod Security')}>
      <PodSecurityPanel
        clusterId={ctx.clusterId}
        namespace={obj}
        owners={owners}
        synced={data.synced}
        onOpen={ctx.navigate}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// RBAC: ServiceAccounts and roles
// ---------------------------------------------------------------------------

function RiskChips({ risks }: { risks: readonly RiskId[] }) {
  i18n.useLocale();
  if (!risks.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {risks.map((r) => (
        <span
          key={r}
          className="bg-status-starting/10 text-status-starting ring-status-starting/25 rounded-md px-1.5 py-0.5 text-[10.5px] ring-1"
        >
          {riskLabel(r)}
        </span>
      ))}
    </div>
  );
}

function RbacUnavailable({ kinds }: { kinds: string[] }) {
  i18n.useLocale();
  if (!kinds.length) return null;
  return (
    <p className="text-status-starting mb-2 text-[11px]">
      {i18n.t('These lists could not be read, so answers may be incomplete: {kinds}', {
        kinds: kinds.join(', '),
      })}
    </p>
  );
}

function ServiceAccountPermissions({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const ns = obj.metadata.namespace ?? 'default';
  const fallback = useMemo(() => [ns], [ns]);
  const rbac = useRbacData(ctx.clusterId, ctx.apiResources, isActive, fallback);
  const subject: Subject = useMemo(
    () => ({ kind: 'ServiceAccount', name: obj.metadata.name, namespace: ns }),
    [obj.metadata.name, ns],
  );
  const perms = useMemo(() => subjectPermissions(rbac.index, subject), [rbac.index, subject]);
  const risks = useMemo(() => {
    const out = new Set<RiskId>();
    for (const b of perms.bindings)
      if (b.role)
        for (const r of roleRisks(
          b.role,
          b.binding.kind === 'ClusterRoleBinding' ? 'cluster' : 'namespace',
        ).keys())
          out.add(r);
    return [...out];
  }, [perms.bindings]);
  return (
    <Section title={i18n.t('Permissions')}>
      <RbacUnavailable kinds={rbac.unavailable} />
      {!rbac.synced && !perms.bindings.length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('Reading RBAC objects…')}</p>
      ) : (
        <>
          <RiskChips risks={risks} />
          {perms.bindings.length > 0 && (
            <ul className="mb-3 space-y-0.5">
              {perms.bindings.map((b) => (
                <li key={b.binding.uid} className="min-w-0">
                  <BindingPath clusterId={ctx.clusterId} binding={b.binding} role={b.role} />
                  {b.via.kind === 'Group' && (
                    <span className="text-fg-dim block text-[10.5px]">
                      {i18n.t('through group {group}', { group: b.via.name })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <PermissionRows
            clusterId={ctx.clusterId}
            rows={perms.rows}
            empty={i18n.t('No RBAC rules apply to this service account.')}
          />
        </>
      )}
    </Section>
  );
}

function RoleSubjects({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const ns = obj.metadata.namespace ?? null;
  const fallback = useMemo(() => (ns ? [ns] : []), [ns]);
  const rbac = useRbacData(ctx.clusterId, ctx.apiResources, isActive, fallback);
  const role = useMemo(
    () =>
      obj.kind === 'Role'
        ? rbac.index.roles.get(roleKey(ns, obj.metadata.name))
        : rbac.index.clusterRoles.get(obj.metadata.name),
    [rbac.index, obj, ns],
  );
  const bindings = useMemo(
    () =>
      bindingsOfRole(rbac.index, {
        kind: obj.kind === 'Role' ? 'Role' : 'ClusterRole',
        namespace: ns,
        name: obj.metadata.name,
      }),
    [rbac.index, obj, ns],
  );
  const risks = useMemo(
    () => (role ? [...roleRisks(role, obj.kind === 'Role' ? 'namespace' : 'cluster').keys()] : []),
    [role, obj.kind],
  );
  return (
    <Section title={i18n.t('Bound subjects')}>
      <RbacUnavailable kinds={rbac.unavailable} />
      <RiskChips risks={risks} />
      {!rbac.synced && !bindings.length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('Reading RBAC objects…')}</p>
      ) : !bindings.length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('No binding references this role.')}</p>
      ) : (
        <ul className="divide-border/40 divide-y">
          {bindings.map((b) => (
            <li key={b.uid} className="py-1.5">
              <BindingPath clusterId={ctx.clusterId} binding={b} role={null} />
              <ul className="mt-1 space-y-0.5 pl-3">
                {b.subjects.map((s) => (
                  <li key={`${s.kind}|${s.namespace ?? ''}|${s.name}`}>
                    <SubjectLabel clusterId={ctx.clusterId} subject={s} />
                  </li>
                ))}
                {!b.subjects.length && (
                  <li className="text-fg-dim text-[11px]">{i18n.t('No subjects')}</li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function securitySection(obj: KubeObject) {
  const { group } = parseApiVersion(obj.apiVersion ?? '');
  if (!builtinByGroupKind(group, obj.kind)) return null;
  if (WORKLOADS.has(obj.kind)) return WorkloadSecurity;
  if (obj.kind === 'Namespace') return NamespacePodSecurity;
  if (obj.kind === 'ServiceAccount') return ServiceAccountPermissions;
  if (obj.kind === 'Role' || obj.kind === 'ClusterRole') return RoleSubjects;
  return null;
}

/** Whether `ObjectSecurity` renders anything for this object. */
export function hasObjectSecurity(obj: KubeObject): boolean {
  return securitySection(obj) !== null;
}

export function ObjectSecurity(props: SectionProps) {
  const Kind = securitySection(props.obj);
  return Kind ? <Kind {...props} /> : null;
}
