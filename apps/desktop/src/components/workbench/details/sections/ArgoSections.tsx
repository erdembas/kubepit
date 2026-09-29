import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { ExternalLink, GitPullRequestArrow, OctagonX } from 'lucide-react';
import { Switch } from '@/components/ui/Switch';
import { ipc } from '@/lib/ipc';
import {
  asArray,
  asObject,
  asString,
  condition,
  isObject,
  spec,
  status,
} from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import {
  argoAppStatus,
  argoConditions,
  argoConditionTone,
  argoDestination,
  argoHealthTone,
  argoHistory,
  argoOperationTone,
  argoResourceRef,
  argoResources,
  argoSources,
  argoSyncTone,
  repoShort,
  shortRevision,
} from '@/lib/kube/gitops/model';
import { argoAutomatedPatch, argoTerminatePatch } from '@/lib/kube/gitops/patches';
import { formatAge } from '@/lib/format';
import type { Gvk, KubeObject } from '@/types';
import { OPEN_GATE, useActionGates } from '../../access/gates';
import { requiredAccess } from '../../actions/access';
import { openArgoSync, setArgoAutoSync } from '../../actions/gitopsActions';
import { confirmDestructive, runMutation } from '../../actions/guard';
import { openExternal } from '../../actions/openExternal';
import { useCluster } from '../../data/hooks';
import { ResourceTree, type TreeItem } from '../../gitops/ResourceTree';
import { ChipList, MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import type { SectionProps } from './types';

const IN_CLUSTER = 'https://kubernetes.default.svc';

/** Gate of one GitOps action for inline controls (read-only cluster, RBAC). */
export function useGitOpsGate(
  clusterId: string,
  id: string,
  obj: KubeObject,
  gvk: Gvk,
  readOnly: boolean,
) {
  const actions = useMemo(
    () => [{ id, mutating: true, access: requiredAccess(id, obj, gvk) }],
    [id, obj, gvk],
  );
  return useActionGates(clusterId, actions, readOnly).get(id) ?? OPEN_GATE;
}

function InlineButton({
  onClick,
  disabled,
  title,
  icon: Icon,
  children,
  danger,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon: typeof OctagonX;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        danger
          ? 'text-status-error inline-flex items-center gap-1 text-[11.5px] hover:underline disabled:opacity-40 disabled:hover:no-underline'
          : 'text-accent inline-flex items-center gap-1 text-[11.5px] hover:underline disabled:opacity-40 disabled:hover:no-underline'
      }
    >
      <Icon className="h-3 w-3" />
      {children}
    </button>
  );
}

function RepoLink({ url }: { url: string }) {
  const web = /^https?:\/\//.test(url);
  return web ? (
    <button
      type="button"
      onClick={() => void openExternal(url)}
      className="text-accent inline-flex max-w-full items-center gap-1 text-left font-mono text-[11.5px] break-all hover:underline"
      title={url}
    >
      {repoShort(url)}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </button>
  ) : (
    <MonoText title={url}>{url}</MonoText>
  );
}

function ApplicationStatus({ obj, gvk, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  const s = argoAppStatus(obj);
  const { cluster } = useCluster(ctx.clusterId);
  const terminateGate = useGitOpsGate(ctx.clusterId, 'argo-terminate', obj, gvk, readOnly);
  const name = obj.metadata.name;
  const op = asObject(status(obj).operationState);
  const opSync = asObject(asObject(op.operation).sync);
  const initiator = asObject(asObject(op.operation).initiatedBy);
  const project = asString(spec(obj).project);
  const terminate = () =>
    confirmDestructive({
      cluster,
      title: i18n.t('Terminate operation'),
      message: i18n.t(
        'Stop the running operation of {name}? Resources it already applied stay as they are.',
        { name },
      ),
      confirmLabel: i18n.t('Terminate'),
      typeName: name,
      run: () =>
        void runMutation(
          () =>
            ipc.resourcePatch(
              ctx.clusterId,
              gvk,
              obj.metadata.namespace ?? null,
              name,
              argoTerminatePatch(),
              'merge',
            ),
          i18n.t('Terminating the operation of {name}', { name }),
        ),
    });
  return (
    <Section title={obj.kind}>
      <Rows>
        <Row label={i18n.t('Sync')}>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <ToneText tone={argoSyncTone(s.sync)}>{s.sync || 'Unknown'}</ToneText>
            {s.revision && (
              <span
                className="text-fg-dim font-mono text-[11px]"
                title={s.revisions.join('\n') || s.revision}
              >
                {s.revisions.length > 1
                  ? s.revisions.map((r) => shortRevision(r)).join(', ')
                  : shortRevision(s.revision)}
              </span>
            )}
          </span>
        </Row>
        <Row label={i18n.t('Health')}>
          <ToneText tone={argoHealthTone(s.health)}>{s.health || 'Unknown'}</ToneText>
          {s.healthMessage && <p className="text-fg-dim mt-0.5 text-[11px]">{s.healthMessage}</p>}
        </Row>
        <Row label={i18n.t('Operation')}>
          {s.operationPhase || s.operationRunning ? (
            <span className="block">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <ToneText tone={argoOperationTone(s.operationPhase || 'Running')}>
                  {s.operationPhase || 'Running'}
                </ToneText>
                {asString(opSync.revision) && (
                  <span
                    className="text-fg-dim font-mono text-[11px]"
                    title={asString(opSync.revision)}
                  >
                    {shortRevision(asString(opSync.revision))}
                  </span>
                )}
                {s.operationRunning && s.operationPhase !== 'Terminating' && (
                  <InlineButton
                    icon={OctagonX}
                    danger
                    disabled={terminateGate.blocked}
                    title={terminateGate.message ?? undefined}
                    onClick={terminate}
                  >
                    {i18n.t('Terminate')}
                  </InlineButton>
                )}
              </span>
              {s.operationMessage && (
                <span className="text-fg-dim mt-0.5 block text-[11px] break-words">
                  {s.operationMessage}
                </span>
              )}
              <span className="text-fg-dim mt-0.5 block text-[11px]">
                {s.operationFinishedAt
                  ? i18n.t('Finished {age} ago', { age: formatAge(s.operationFinishedAt, ctx.now) })
                  : s.operationStartedAt
                    ? i18n.t('Started {age} ago', { age: formatAge(s.operationStartedAt, ctx.now) })
                    : null}
                {asString(initiator.username) && (
                  <>
                    {' · '}
                    {i18n.t('by {user}', { user: asString(initiator.username) })}
                  </>
                )}
                {initiator.automated === true && (
                  <>
                    {' · '}
                    {i18n.t('automated')}
                  </>
                )}
              </span>
            </span>
          ) : null}
        </Row>
        <Row label={i18n.t('Reconciled')}>
          {s.reconciledAt ? (
            <span title={s.reconciledAt}>
              {i18n.t('{age} ago', { age: formatAge(s.reconciledAt, ctx.now) })}
            </span>
          ) : null}
        </Row>
        <Row label={i18n.t('Project')}>
          {project ? (
            <RefLink
              target={{
                apiVersion: obj.apiVersion,
                kind: 'AppProject',
                name: project,
                namespace: obj.metadata.namespace ?? null,
              }}
              ctx={ctx}
            />
          ) : null}
        </Row>
      </Rows>
    </Section>
  );
}

function SyncPolicy({ obj, gvk, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  const s = argoAppStatus(obj);
  const { cluster } = useCluster(ctx.clusterId);
  const gate = useGitOpsGate(ctx.clusterId, 'argo-auto-sync', obj, gvk, readOnly);
  const retry = asObject(asObject(spec(obj).syncPolicy).retry);
  const backoff = asObject(retry.backoff);
  const name = obj.metadata.name;
  const setField = (field: 'prune' | 'selfHeal', value: boolean) =>
    void runMutation(
      () =>
        ipc.resourcePatch(
          ctx.clusterId,
          gvk,
          obj.metadata.namespace ?? null,
          name,
          argoAutomatedPatch(field, value),
          'merge',
        ),
      field === 'prune'
        ? value
          ? i18n.t('Auto-prune enabled for {name}', { name })
          : i18n.t('Auto-prune disabled for {name}', { name })
        : value
          ? i18n.t('Self-heal enabled for {name}', { name })
          : i18n.t('Self-heal disabled for {name}', { name }),
    );
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, off = false) => (
    <span className="flex items-center gap-2" title={gate.message ?? undefined}>
      <Switch bare checked={checked} disabled={gate.blocked || off} onChange={onChange} />
      <span className={checked ? 'text-fg' : 'text-fg-dim'}>{label}</span>
    </span>
  );
  return (
    <Section title={i18n.t('Sync policy')}>
      <Rows>
        <Row label={i18n.t('Auto-sync')}>
          {toggle(s.automated ? i18n.t('On') : i18n.t('Manual'), s.automated, (v) =>
            setArgoAutoSync({ clusterId: ctx.clusterId, cluster, gvk, obj }, v),
          )}
        </Row>
        <Row label={i18n.t('Prune')}>
          {toggle(
            s.prune ? i18n.t('On') : i18n.t('Off'),
            s.prune,
            (v) => setField('prune', v),
            !s.automated,
          )}
        </Row>
        <Row label={i18n.t('Self-heal')}>
          {toggle(
            s.selfHeal ? i18n.t('On') : i18n.t('Off'),
            s.selfHeal,
            (v) => setField('selfHeal', v),
            !s.automated,
          )}
        </Row>
        <Row label={i18n.t('Sync options')}>
          {s.syncOptions.length ? <ChipList entries={s.syncOptions} /> : null}
        </Row>
        <Row label={i18n.t('Retry')}>
          {isObject(asObject(spec(obj).syncPolicy).retry) ? (
            <MonoText>
              {i18n.t('limit {limit}', { limit: asString(retry.limit) || '∞' })}
              {asString(backoff.duration) &&
                ` · ${asString(backoff.duration)} ×${asString(backoff.factor) || '2'} ≤ ${asString(backoff.maxDuration) || '3m'}`}
            </MonoText>
          ) : null}
        </Row>
      </Rows>
    </Section>
  );
}

function Sources({ obj }: { obj: KubeObject }) {
  i18n.useLocale();
  const sources = argoSources(obj);
  if (!sources.length) return null;
  return (
    <Section title={sources.length > 1 ? i18n.t('Sources') : i18n.t('Source')}>
      <div className="space-y-3">
        {sources.map((src, i) => (
          <Rows key={`${src.repoURL}-${i}`}>
            <Row label={i18n.t('Repository')}>
              <RepoLink url={src.repoURL} />
            </Row>
            <Row label={i18n.t('Path')}>{src.path && <MonoText>{src.path}</MonoText>}</Row>
            <Row label={i18n.t('Chart')}>{src.chart && <MonoText>{src.chart}</MonoText>}</Row>
            <Row label={i18n.t('Target revision')}>
              <MonoText>{src.targetRevision || 'HEAD'}</MonoText>
            </Row>
            <Row label={i18n.t('Reference')}>{src.ref && <MonoText>{src.ref}</MonoText>}</Row>
          </Rows>
        ))}
      </div>
    </Section>
  );
}

function Destination({ obj, ctx }: { obj: KubeObject; ctx: SectionProps['ctx'] }) {
  i18n.useLocale();
  const d = argoDestination(obj);
  const inCluster = d.server === IN_CLUSTER || d.name === 'in-cluster';
  return (
    <Section title={i18n.t('Destination')}>
      <Rows>
        <Row label={i18n.t('Cluster')}>
          <MonoText title={d.server || undefined}>
            {d.name || (inCluster ? 'in-cluster' : d.server) || '—'}
          </MonoText>
        </Row>
        <Row label={i18n.t('Namespace')}>
          {d.namespace ? (
            inCluster ? (
              <RefLink
                target={{ apiVersion: 'v1', kind: 'Namespace', name: d.namespace }}
                ctx={ctx}
              />
            ) : (
              <MonoText>{d.namespace}</MonoText>
            )
          ) : null}
        </Row>
      </Rows>
    </Section>
  );
}

function ManagedResources({ obj, ctx }: { obj: KubeObject; ctx: SectionProps['ctx'] }) {
  i18n.useLocale();
  const d = argoDestination(obj);
  const inCluster = d.server === IN_CLUSTER || d.name === 'in-cluster';
  const resources = argoResources(obj);
  const items: TreeItem[] = resources.map((r) => ({
    key: `${r.group}/${r.kind}/${r.namespace}/${r.name}`,
    kind: r.kind,
    namespace: r.namespace,
    name: r.name,
    ref: inCluster ? argoResourceRef(r) : null,
    sync: r.status ? { text: r.status, tone: argoSyncTone(r.status) } : undefined,
    health: r.health
      ? { text: r.health, tone: argoHealthTone(r.health), title: r.healthMessage || undefined }
      : undefined,
    flag: r.requiresPruning ? i18n.t('prune') : r.hook ? i18n.t('hook') : undefined,
    attention:
      r.status === 'OutOfSync' || r.requiresPruning || (!!r.health && r.health !== 'Healthy'),
  }));
  return (
    <Section
      title={
        <>
          {i18n.t('Resources')}
          <span className="text-fg-dim ml-1.5 tabular-nums">{resources.length}</span>
        </>
      }
    >
      <ResourceTree items={items} ctx={ctx} attentionLabel={i18n.t('Out of sync or unhealthy')} />
    </Section>
  );
}

function History({ obj, gvk, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  const gate = useGitOpsGate(ctx.clusterId, 'argo-sync', obj, gvk, readOnly);
  const history = argoHistory(obj);
  const current = argoAppStatus(obj).revision;
  if (!history.length) return null;
  return (
    <Section title={i18n.t('History')}>
      <MiniTable
        rows={history.slice(0, 20)}
        rowKey={(h) => String(h.id)}
        columns={[
          { label: 'ID', lang: 'en', cell: (h) => <span className="tabular-nums">{h.id}</span> },
          {
            label: i18n.t('Revision'),
            cell: (h) => (
              <span className="font-mono text-[11px]" title={h.revision}>
                {shortRevision(h.revision)}
                {h.revision === current && (
                  <span className="text-status-running ml-1.5 font-sans text-[10.5px]">
                    {i18n.t('current')}
                  </span>
                )}
              </span>
            ),
          },
          {
            label: i18n.t('Deployed'),
            cell: (h) => <span title={h.deployedAt}>{formatAge(h.deployedAt, ctx.now)}</span>,
            className: 'whitespace-nowrap',
          },
          {
            label: i18n.t('Initiated by'),
            cell: (h) => (h.automated ? i18n.t('automated') : h.initiatedBy || '—'),
          },
          {
            label: '',
            className: 'text-right',
            cell: (h) =>
              h.revision && h.revision !== current ? (
                <InlineButton
                  icon={GitPullRequestArrow}
                  disabled={gate.blocked}
                  title={gate.message ?? i18n.t('Sync to this revision…')}
                  onClick={() => openArgoSync(ctx.clusterId, gvk, obj, h.revision)}
                >
                  {i18n.t('Sync…')}
                </InlineButton>
              ) : null,
          },
        ]}
      />
    </Section>
  );
}

function ArgoConditions({ obj, ctx }: { obj: KubeObject; ctx: SectionProps['ctx'] }) {
  i18n.useLocale();
  const list = argoConditions(obj);
  if (!list.length) return null;
  return (
    <Section title={i18n.t('Conditions')}>
      <MiniTable
        rows={list}
        rowKey={(c, i) => `${c.type}-${i}`}
        columns={[
          {
            label: i18n.t('Type'),
            cell: (c) => <ToneText tone={argoConditionTone(c.type)}>{c.type}</ToneText>,
          },
          {
            label: i18n.t('Message'),
            cell: (c) => <span className="break-words">{c.message}</span>,
          },
          {
            label: i18n.t('Updated'),
            cell: (c) => formatAge(c.lastTransitionTime, ctx.now),
            className: 'text-right whitespace-nowrap',
          },
        ]}
      />
    </Section>
  );
}

function Summary({ obj }: { obj: KubeObject }) {
  i18n.useLocale();
  const summary = asObject(status(obj).summary);
  const images = asArray(summary.images).map((x) => asString(x));
  const urls = asArray(summary.externalURLs).map((x) => asString(x));
  if (!images.length && !urls.length) return null;
  return (
    <Section title={i18n.t('Summary')}>
      <Rows>
        <Row label={i18n.t('Images')}>{images.length ? <ChipList entries={images} /> : null}</Row>
        <Row label={i18n.t('URLs')}>
          {urls.length ? (
            <span className="flex flex-col gap-0.5">
              {urls.map((u) => (
                <RepoLink key={u} url={u} />
              ))}
            </span>
          ) : null}
        </Row>
      </Rows>
    </Section>
  );
}

/** Argo CD Application: status, sync policy, sources, destination, resources, history. */
export function ArgoApplicationSections(props: SectionProps) {
  i18n.useLocale();
  return (
    <>
      <ApplicationStatus {...props} />
      <ArgoConditions obj={props.obj} ctx={props.ctx} />
      <ManagedResources obj={props.obj} ctx={props.ctx} />
      <SyncPolicy {...props} />
      <Sources obj={props.obj} />
      <Destination obj={props.obj} ctx={props.ctx} />
      <History {...props} />
      <Summary obj={props.obj} />
    </>
  );
}

/** Argo CD ApplicationSet: generators, template, generated applications. */
export function ArgoApplicationSetSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const template = asObject(s.template);
  const tmeta = asObject(template.metadata);
  const tspec = asObject(template.spec);
  const generators = asArray(s.generators).filter(isObject);
  const apps = asArray(status(obj).resources).filter(isObject);
  const error = condition(obj, 'ErrorOccurred');
  const policy = asObject(s.syncPolicy);
  return (
    <>
      <Section title={i18n.t('Generators')}>
        {generators.length ? (
          <div className="space-y-1.5">
            {generators.map((g, i) => {
              const [type, value] = Object.entries(g)[0] ?? ['', {}];
              const v = asObject(value);
              const detail =
                type === 'list'
                  ? i18n.t('{count} elements', { count: asArray(v.elements).length })
                  : type === 'git'
                    ? `${repoShort(asString(v.repoURL))}@${asString(v.revision) || 'HEAD'}`
                    : type === 'clusters'
                      ? Object.entries(asObject(asObject(v.selector).matchLabels))
                          .map(([k, val]) => `${k}=${asString(val)}`)
                          .join(', ')
                      : '';
              return (
                <div key={`${type}-${i}`} className="flex items-baseline gap-2 text-[12px]">
                  <span className="bg-fg/5 text-fg-muted ring-border/60 rounded px-1.5 py-px font-mono text-[10.5px] ring-1">
                    {type}
                  </span>
                  <span className="text-fg-dim min-w-0 truncate font-mono text-[11px]">
                    {detail}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <span className="text-fg-dim text-[12px]">{i18n.t('None')}</span>
        )}
      </Section>
      <Section title={i18n.t('Template')}>
        <Rows>
          <Row label={i18n.t('Name')}>
            {asString(tmeta.name) && <MonoText>{asString(tmeta.name)}</MonoText>}
          </Row>
          <Row label={i18n.t('Project')}>
            {asString(tspec.project) && <MonoText>{asString(tspec.project)}</MonoText>}
          </Row>
          <Row label={i18n.t('Repository')}>
            {asString(asObject(tspec.source).repoURL) && (
              <RepoLink url={asString(asObject(tspec.source).repoURL)} />
            )}
          </Row>
          <Row label={i18n.t('Path')}>
            {asString(asObject(tspec.source).path) && (
              <MonoText>{asString(asObject(tspec.source).path)}</MonoText>
            )}
          </Row>
          <Row label={i18n.t('Destination')}>
            {(asString(asObject(tspec.destination).server) ||
              asString(asObject(tspec.destination).name)) && (
              <MonoText>
                {asString(asObject(tspec.destination).name) ||
                  asString(asObject(tspec.destination).server)}
                /{asString(asObject(tspec.destination).namespace) || '—'}
              </MonoText>
            )}
          </Row>
          <Row label={i18n.t('Sync policy')}>
            {policy.preserveResourcesOnDeletion === true
              ? i18n.t('Preserve resources on deletion')
              : asString(policy.applicationsSync) || null}
          </Row>
        </Rows>
      </Section>
      <Section
        title={
          <>
            {i18n.t('Applications')}
            <span className="text-fg-dim ml-1.5 tabular-nums">{apps.length}</span>
          </>
        }
      >
        {error?.status === 'True' && (
          <p className="text-status-error mb-2 text-[11.5px] break-words">{error.message}</p>
        )}
        <MiniTable
          rows={apps}
          rowKey={(a) => `${asString(a.namespace)}/${asString(a.name)}`}
          columns={[
            {
              label: i18n.t('Name'),
              cell: (a) => (
                <RefLink
                  target={{
                    apiVersion: obj.apiVersion,
                    kind: 'Application',
                    name: asString(a.name),
                    namespace: asString(a.namespace) || obj.metadata.namespace || null,
                  }}
                  ctx={ctx}
                />
              ),
            },
            {
              label: i18n.t('Health'),
              cell: (a) => {
                const h = asString(asObject(a.health).status);
                return h ? <ToneText tone={argoHealthTone(h)}>{h}</ToneText> : '—';
              },
            },
            {
              label: i18n.t('Status'),
              cell: (a) => asString(a.status) || '—',
            },
          ]}
        />
      </Section>
    </>
  );
}

/** Argo CD AppProject: allowed sources, destinations, resource rules and roles. */
export function ArgoProjectSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const destinations = asArray(s.destinations).filter(isObject);
  const kinds = (value: unknown) =>
    asArray(value)
      .filter(isObject)
      .map((r) => `${asString(r.group) || 'core'}/${asString(r.kind)}`);
  const roles = asArray(s.roles).filter(isObject);
  const windows = asArray(s.syncWindows).filter(isObject);
  return (
    <>
      <Section title={i18n.t('Project')}>
        <Rows>
          <Row label={i18n.t('Description')}>{asString(s.description) || null}</Row>
          <Row label={i18n.t('Source repositories')}>
            <ChipList entries={asArray(s.sourceRepos).map((r) => asString(r))} />
          </Row>
          <Row label={i18n.t('Cluster resources')}>
            <ChipList entries={kinds(s.clusterResourceWhitelist)} empty={i18n.t('None allowed')} />
          </Row>
          <Row label={i18n.t('Denied namespaced')}>
            {kinds(s.namespaceResourceBlacklist).length ? (
              <ChipList entries={kinds(s.namespaceResourceBlacklist)} />
            ) : null}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Destinations')}>
        <MiniTable
          rows={destinations}
          rowKey={(d, i) => `${asString(d.server)}-${asString(d.namespace)}-${i}`}
          columns={[
            {
              label: i18n.t('Cluster'),
              lang: 'en',
              cell: (d) => <MonoText>{asString(d.name) || asString(d.server) || '*'}</MonoText>,
            },
            {
              label: i18n.t('Namespace'),
              lang: 'en',
              cell: (d) => <MonoText>{asString(d.namespace) || '*'}</MonoText>,
            },
          ]}
        />
      </Section>
      {roles.length > 0 && (
        <Section title={i18n.t('Roles')}>
          <MiniTable
            rows={roles}
            rowKey={(r) => asString(r.name)}
            columns={[
              {
                label: i18n.t('Name'),
                cell: (r) => <span className="text-fg">{asString(r.name)}</span>,
              },
              { label: i18n.t('Description'), cell: (r) => asString(r.description) || '—' },
              {
                label: i18n.t('Policies'),
                cell: (r) => asArray(r.policies).length,
                className: 'text-right',
              },
            ]}
          />
        </Section>
      )}
      {windows.length > 0 && (
        <Section title={i18n.t('Sync windows')}>
          <MiniTable
            rows={windows}
            rowKey={(w, i) => `${asString(w.schedule)}-${i}`}
            columns={[
              { label: i18n.t('Kind'), cell: (w) => asString(w.kind) },
              {
                label: i18n.t('Schedule'),
                cell: (w) => <MonoText>{asString(w.schedule)}</MonoText>,
              },
              { label: i18n.t('Duration'), cell: (w) => asString(w.duration) },
            ]}
          />
        </Section>
      )}
      <ArgoConditions obj={obj} ctx={ctx} />
    </>
  );
}
