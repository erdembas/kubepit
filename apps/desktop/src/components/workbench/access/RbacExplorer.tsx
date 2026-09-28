import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ChevronRight, Loader2, TriangleAlert, UserRoundSearch, Users } from 'lucide-react';
import { Field, Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { parseResourceRef, resourceRef } from '@/lib/kube/access';
import { BUILTIN_KINDS } from '@/lib/kube/catalog';
import {
  allSubjects,
  asFlag,
  ruleText,
  subjectKey,
  subjectName,
  subjectPermissions,
  whoCan,
  type Subject,
  type WhoCanEntry,
  type WhoCanRequest,
} from '@/lib/kube/rbac';
import { subjectKindLabel } from '@/lib/kube/rbac/titles';
import type { SearchableOption } from '@/lib/selectSearch';
import type { ApiResourceInfo } from '@/types';
import { CodeBlock } from '../details/primitives';
import { PermissionRows } from './PermissionRows';
import { BindingPath, SubjectLabel } from './rbacLinks';
import { useRbacData, type RbacData } from './useRbacData';

/**
 * Cluster RBAC in the My Permissions view: "who can <verb> <resource>" over
 * every subject, with the binding → role → rule behind each grant, and
 * everything one subject can do. Computed locally from Roles, ClusterRoles
 * and their bindings.
 */

const VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection',
  'impersonate',
  'bind',
  'escalate',
  'approve',
  'use',
  '*',
];

const SUBRESOURCES = [
  'pods/log',
  'pods/exec',
  'pods/attach',
  'pods/portforward',
  'pods/eviction',
  'pods/ephemeralcontainers',
  'deployments.apps/scale',
  'statefulsets.apps/scale',
  'serviceaccounts/token',
  'nodes/proxy',
  'services/proxy',
];

interface KindOption {
  ref: string;
  kind: string;
  namespaced: boolean;
  terms: string;
}

function kindOptions(apiResources: readonly ApiResourceInfo[] | null): KindOption[] {
  const source = apiResources?.length
    ? apiResources.map((r) => ({ ...r, shortNames: r.short_names }))
    : BUILTIN_KINDS;
  const seen = new Set<string>();
  const out: KindOption[] = [];
  for (const r of source) {
    const ref = resourceRef({ group: r.group, resource: r.plural, subresource: null });
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      ref,
      kind: r.kind,
      namespaced: r.namespaced,
      terms: `${r.kind} ${r.shortNames.join(' ')}`,
    });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

function Status({ rbac }: { rbac: RbacData }) {
  i18n.useLocale();
  if (!rbac.unavailable.length && !rbac.partial) return null;
  return (
    <p className="text-status-starting flex items-start gap-1.5 px-3 pb-2 text-[11px]">
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        {rbac.unavailable.length
          ? i18n.t('These lists could not be read, so answers may be incomplete: {kinds}', {
              kinds: rbac.unavailable.join(', '),
            })
          : i18n.t(
              'RoleBindings can only be listed in the selected namespaces; grants in other namespaces are not shown.',
            )}
      </span>
    </p>
  );
}

function EntryRow({
  clusterId,
  entry,
  request,
  onPermissions,
}: {
  clusterId: string;
  entry: WhoCanEntry;
  request: WhoCanRequest;
  onPermissions: (s: Subject) => void;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const scopes = [...new Set(entry.paths.map((p) => p.scope))];
  const restricted = entry.paths.every((p) => p.names !== null);
  return (
    <li>
      <div className="hover:bg-fg/3 flex items-start gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={i18n.t('Show how the permission is granted')}
          className="text-fg-dim hover:text-fg mt-0.5 shrink-0"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <SubjectLabel clusterId={clusterId} subject={entry.subject} className="min-w-0 flex-1" />
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span
            className={cn(
              'text-[11px]',
              entry.full ? 'text-status-running' : 'text-status-starting',
            )}
          >
            {entry.full
              ? scopes.includes(null)
                ? i18n.t('everywhere')
                : request.namespace
                  ? i18n.t('in {namespace}', { namespace: request.namespace })
                  : i18n.t('everywhere')
              : restricted
                ? i18n.t('only named objects')
                : i18n.plural('in {count} namespace', 'in {count} namespaces', scopes.length)}
          </span>
          <button
            type="button"
            onClick={() => onPermissions(entry.subject)}
            className="text-accent text-[10.5px] hover:underline"
          >
            {i18n.t('All permissions')}
          </button>
        </span>
      </div>
      {open && (
        <ul className="space-y-1 pr-3 pb-2 pl-9">
          {entry.paths.map((p, i) => (
            <li key={`${p.binding.uid}|${p.ruleIndex}|${i}`} className="min-w-0">
              <BindingPath clusterId={clusterId} binding={p.binding} role={p.role} />
              <span
                className="text-fg-dim block truncate font-mono text-[10.5px]"
                title={p.rule ? ruleText(p.rule) : p.urls?.join(', ')}
              >
                {p.rule ? ruleText(p.rule) : `${p.urls?.join(', ')}`}
                {p.scope !== null && ` · ${p.scope}`}
              </span>
              {p.subject.kind === 'Group' && p.subject.name !== entry.subject.name && (
                <span className="text-fg-dim block text-[10.5px]">
                  {i18n.t('through group {group}', { group: p.subject.name })}
                </span>
              )}
            </li>
          ))}
          {asFlag(entry.subject) && (
            <li className="pt-1">
              <CodeBlock
                maxHeight="max-h-20"
                text={`kubectl auth can-i ${request.verb} ${request.group ? `${request.resource}.${request.group}` : request.resource}${request.name ? `/${request.name}` : ''}${request.subresource ? ` --subresource=${request.subresource}` : ''}${request.namespace ? ` -n ${request.namespace}` : request.namespaced ? ' --all-namespaces' : ''} ${asFlag(entry.subject)}`}
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function SubjectPermissionsCard({
  clusterId,
  rbac,
  subject,
  onSubject,
}: {
  clusterId: string;
  rbac: RbacData;
  subject: Subject | null;
  onSubject: (s: Subject | null) => void;
}) {
  i18n.useLocale();
  const subjects = useMemo(() => allSubjects(rbac.index), [rbac.index]);
  const options = useMemo(
    (): SearchableOption[] =>
      subjects.map((s) => ({
        value: subjectKey(s),
        label: subjectName(s),
        description: subjectKindLabel(s.kind),
        group: subjectKindLabel(s.kind),
      })),
    [subjects],
  );
  const permissions = useMemo(
    () => (subject ? subjectPermissions(rbac.index, subject) : null),
    [rbac.index, subject],
  );
  return (
    <section className="border-border bg-surface-raised/40 flex flex-col rounded-lg border">
      <header className="border-border/60 flex h-10 items-center gap-2 border-b px-3">
        <UserRoundSearch className="text-fg-dim h-3.5 w-3.5" />
        <h3 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('What can a subject do?')}
        </h3>
      </header>
      <div className="space-y-3 px-3 py-3">
        <Field label={i18n.t('Subject')}>
          <SearchableSelect
            value={subject ? subjectKey(subject) : ''}
            onChange={(key) => onSubject(subjects.find((s) => subjectKey(s) === key) ?? null)}
            options={options}
            label={i18n.t('Subject')}
            placeholder={i18n.t('Pick a user, group or service account…')}
            compact
            className="border-border bg-surface-raised w-full border font-mono"
          />
        </Field>
        {subject && permissions && (
          <>
            <p className="text-fg-dim text-[11px] leading-relaxed">
              {subject.kind === 'Group'
                ? i18n.t('Grants bound to this group.')
                : subject.kind === 'ServiceAccount'
                  ? i18n.t(
                      'Includes grants to system:serviceaccounts, system:serviceaccounts:{namespace} and system:authenticated.',
                      { namespace: subject.namespace ?? '' },
                    )
                  : i18n.t(
                      'Includes grants to system:authenticated. Other groups of this user come from the identity provider and are not known here.',
                    )}
            </p>
            <PermissionRows
              clusterId={clusterId}
              rows={permissions.rows}
              empty={i18n.t('No RBAC rules apply to this subject.')}
            />
          </>
        )}
      </div>
    </section>
  );
}

export function RbacExplorer({
  clusterId,
  namespaces,
  defaultNamespace,
  apiResources,
  isActive,
}: {
  clusterId: string;
  namespaces: string[];
  defaultNamespace: string;
  apiResources: ApiResourceInfo[] | null;
  isActive: boolean;
}) {
  i18n.useLocale();
  const [verb, setVerb] = useState('get');
  const [resource, setResource] = useState('secrets');
  const [namespace, setNamespace] = useState(defaultNamespace);
  // When RoleBindings cannot be listed cluster-wide, read those of the asked namespace.
  const fallback = useMemo(() => (namespace ? [namespace] : []), [namespace]);
  const rbac = useRbacData(clusterId, apiResources, isActive, fallback);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState<Subject | null>(null);

  const kinds = useMemo(() => kindOptions(apiResources), [apiResources]);
  const resourceOpts = useMemo((): SearchableOption[] => {
    const group = i18n.t('Resources');
    const subgroup = i18n.t('Subresources');
    return [
      ...kinds.map((k) => ({
        value: k.ref,
        label: k.ref,
        description: k.kind,
        keywords: k.terms,
        group,
      })),
      ...SUBRESOURCES.map((ref) => ({ value: ref, label: ref, group: subgroup })),
    ];
  }, [kinds]);
  const namespaceOpts = useMemo(
    (): SearchableOption[] => [
      { value: '', label: i18n.t('Cluster-wide (all namespaces)') },
      ...[...new Set([...namespaces, defaultNamespace])]
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ value: n, label: n })),
    ],
    [namespaces, defaultNamespace],
  );

  const parsed = parseResourceRef(resource);
  const nonResource = resource.trim().startsWith('/');
  const base = resourceRef({ ...parsed, subresource: null });
  const namespaced = !nonResource && (kinds.find((k) => k.ref === base)?.namespaced ?? true);
  const request: WhoCanRequest = {
    verb,
    group: nonResource ? '' : parsed.group,
    resource: nonResource ? resource.trim() : parsed.resource,
    subresource: nonResource ? null : parsed.subresource,
    name: name.trim() || null,
    namespace: namespaced ? namespace || null : null,
    namespaced,
  };
  const result = useMemo(
    () => (request.resource ? whoCan(rbac.index, request) : null),
    // `request` is rebuilt every render; its fields are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rbac.index, verb, resource, namespace, name, namespaced],
  );
  const loading = !rbac.synced && !rbac.index.bindings.length;

  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="border-border bg-surface-raised/40 flex min-w-0 flex-col rounded-lg border">
          <header className="border-border/60 flex h-10 items-center gap-2 border-b px-3">
            <Users className="text-fg-dim h-3.5 w-3.5" />
            <h3 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
              {i18n.t('Who can…?')}
            </h3>
            {loading && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
          </header>
          <form
            className="grid grid-cols-1 gap-3 px-3 py-3 @md:grid-cols-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <Field label={i18n.t('Verb')}>
              <Select
                value={verb}
                onChange={setVerb}
                options={VERBS.map((v) => ({ value: v, label: v }))}
                ariaLabel={i18n.t('Verb')}
                className="h-8 w-full font-mono"
              />
            </Field>
            <Field label={i18n.t('Resource')}>
              <SearchableSelect
                value={resource}
                onChange={setResource}
                options={resourceOpts}
                label={i18n.t('Resource')}
                compact
                className="border-border bg-surface-raised w-full border font-mono"
                createOption={(q) => {
                  const text = q.trim();
                  return text ? { value: text, label: text, description: i18n.t('Custom') } : null;
                }}
              />
            </Field>
            <Field label={i18n.t('Namespace')}>
              <SearchableSelect
                value={namespaced ? namespace : ''}
                onChange={setNamespace}
                options={namespaceOpts}
                label={i18n.t('Namespace')}
                disabled={!namespaced}
                compact
                className="border-border bg-surface-raised w-full border font-mono"
              />
            </Field>
            <Field label={i18n.t('Name (optional)')}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={i18n.t('Any object')}
                aria-label={i18n.t('Object name')}
                mono
                className="h-8"
              />
            </Field>
          </form>
          <p className="text-fg-dim border-border/60 border-t px-3 py-2 text-[11px] leading-relaxed">
            {i18n.t(
              'Computed from Roles, ClusterRoles and their bindings, the way the RBAC authorizer decides. Grants from other authorizers (webhooks, cloud IAM) are not included.',
            )}
          </p>
          <Status rbac={rbac} />
          <div className="border-border/60 min-h-0 border-t">
            {!result || loading ? (
              <p className="text-fg-dim px-3 py-6 text-center text-[12px]">
                {loading ? i18n.t('Reading RBAC objects…') : i18n.t('Pick a resource.')}
              </p>
            ) : !result.entries.length ? (
              <p className="text-fg-dim px-3 py-6 text-center text-[12px]">
                {i18n.t('No binding grants this permission.')}
              </p>
            ) : (
              <>
                <p className="text-fg-dim px-3 pt-2 text-[11px] tabular-nums">
                  {i18n.plural('{count} subject', '{count} subjects', result.entries.length)}
                </p>
                <ul className="divide-border/40 max-h-[480px] divide-y overflow-auto">
                  {result.entries.map((e) => (
                    <EntryRow
                      key={subjectKey(e.subject)}
                      clusterId={clusterId}
                      entry={e}
                      request={request}
                      onPermissions={setSubject}
                    />
                  ))}
                </ul>
              </>
            )}
            {result && result.missing.length > 0 && (
              <p className="text-fg-dim border-border/40 border-t px-3 py-2 text-[11px]">
                {i18n.plural(
                  '{count} binding references a role that does not exist',
                  '{count} bindings reference roles that do not exist',
                  result.missing.length,
                )}
              </p>
            )}
          </div>
        </section>
        <SubjectPermissionsCard
          clusterId={clusterId}
          rbac={rbac}
          subject={subject}
          onSubject={setSubject}
        />
      </div>
    </div>
  );
}
