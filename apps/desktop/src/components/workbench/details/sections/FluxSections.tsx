import * as i18n from '@/i18n';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  conditions,
  isObject,
  spec,
  status,
} from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { isFluxHelmRelease, isFluxKustomization, isFluxSource } from '@/lib/kube/gitops/kinds';
import {
  fluxArtifact,
  fluxDependsOn,
  fluxHealthTone,
  fluxInventory,
  fluxSourceReference,
  fluxSourceRef,
  fluxStatus,
  helmHistory,
  helmReleaseChart,
  helmReleaseTarget,
  inventoryRef,
  readyTone,
  shortRevision,
} from '@/lib/kube/gitops/model';
import { formatAge, formatBytes } from '@/lib/format';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';
import { ResourceTree, type TreeItem } from '../../gitops/ResourceTree';
import { ChipList, MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { GenericSections } from './GenericSections';
import { ConditionsTable } from './PodSections';
import type { SectionProps } from './types';

function Revision({ value }: { value: string }) {
  return value ? <MonoText title={value}>{shortRevision(value)}</MonoText> : null;
}

/** Ready condition, suspension and reconcile timing shared by every Flux kind. */
function FluxStatusSection({ obj, ctx, title }: SectionProps & { title: string }) {
  i18n.useLocale();
  const f = fluxStatus(obj);
  const s = spec(obj);
  const generation = obj.metadata.generation ?? 0;
  const pending = f.observedGeneration >= 0 && generation > 0 && f.observedGeneration < generation;
  return (
    <Section title={title}>
      <Rows>
        <Row label={i18n.t('Ready')}>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <ToneText tone={fluxHealthTone(f.health)}>{f.health}</ToneText>
            {f.ready?.reason && <ToneText tone={readyTone(f.ready)}>{f.ready.reason}</ToneText>}
            {f.ready?.lastTransitionTime && (
              <span className="text-fg-dim text-[11px]" title={f.ready.lastTransitionTime}>
                {i18n.t('{age} ago', { age: formatAge(f.ready.lastTransitionTime, ctx.now) })}
              </span>
            )}
          </span>
          {f.ready?.message && (
            <p className="text-fg-dim mt-0.5 text-[11px] break-words">{f.ready.message}</p>
          )}
        </Row>
        <Row label={i18n.t('Suspended')}>
          {f.suspended ? (
            <ToneText tone="warning">{i18n.t('Yes')}</ToneText>
          ) : (
            <span className="text-fg-muted">{i18n.t('No')}</span>
          )}
        </Row>
        <Row label={i18n.t('Interval')}>
          {f.interval && (
            <MonoText>
              {f.interval}
              {asString(s.retryInterval) &&
                ` · ${i18n.t('retry {interval}', { interval: asString(s.retryInterval) })}`}
              {asString(s.timeout) &&
                ` · ${i18n.t('timeout {timeout}', { timeout: asString(s.timeout) })}`}
            </MonoText>
          )}
        </Row>
        <Row label={i18n.t('Last reconcile request')}>
          {f.lastHandledReconcileAt ? (
            <span title={f.lastHandledReconcileAt}>
              {i18n.t('{age} ago', { age: formatAge(f.lastHandledReconcileAt, ctx.now) })}
            </span>
          ) : null}
        </Row>
        <Row label={i18n.t('Generation')}>
          {generation > 0 ? (
            <span className={pending ? 'text-status-starting' : 'text-fg-muted'}>
              {pending
                ? i18n.t('{observed} of {generation} observed', {
                    observed: f.observedGeneration,
                    generation,
                  })
                : i18n.t('{generation} (up to date)', { generation })}
            </span>
          ) : null}
        </Row>
      </Rows>
    </Section>
  );
}

function Conditions({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  if (!conditions(obj).length) return null;
  return (
    <Section title={i18n.t('Conditions')}>
      <ConditionsTable obj={obj} now={ctx.now} />
    </Section>
  );
}

function DependsOn({ obj, ctx }: SectionProps) {
  const deps = fluxDependsOn(obj);
  if (!deps.length) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {deps.map((d) => (
        <RefLink
          key={`${d.namespace}/${d.name}`}
          target={d}
          ctx={ctx}
          label={
            d.namespace && d.namespace !== obj.metadata.namespace
              ? `${d.namespace}/${d.name}`
              : d.name
          }
        />
      ))}
    </span>
  );
}

function SourceLink({ obj, ctx }: SectionProps) {
  const ref = fluxSourceRef(obj);
  if (!ref) return null;
  const label = `${ref.kind}/${ref.namespace && ref.namespace !== obj.metadata.namespace ? `${ref.namespace}/` : ''}${ref.name}`;
  return <RefLink target={ref} ctx={ctx} label={label} />;
}

function Revisions({ obj }: { obj: KubeObject }) {
  i18n.useLocale();
  const f = fluxStatus(obj);
  const failing = f.lastAttemptedRevision && f.lastAttemptedRevision !== f.lastAppliedRevision;
  return (
    <>
      <Row label={i18n.t('Last applied')}>
        <Revision value={f.lastAppliedRevision} />
      </Row>
      <Row label={i18n.t('Last attempted')}>
        {f.lastAttemptedRevision ? (
          <span className={failing ? 'text-status-starting' : undefined}>
            <Revision value={f.lastAttemptedRevision} />
          </span>
        ) : null}
      </Row>
    </>
  );
}

/** Flux Kustomization: source, path, revisions, dependencies and the applied inventory. */
export function FluxKustomizationSections(props: SectionProps) {
  i18n.useLocale();
  const { obj, ctx } = props;
  const s = spec(obj);
  const inventory = fluxInventory(obj);
  const remote = isObject(s.kubeConfig);
  const items: TreeItem[] = inventory.map((e) => ({
    key: `${e.namespace}_${e.name}_${e.group}_${e.kind}`,
    kind: e.kind,
    namespace: e.namespace,
    name: e.name,
    ref: remote ? null : inventoryRef(e),
  }));
  return (
    <>
      <FluxStatusSection {...props} title={obj.kind} />
      <Section title={i18n.t('Source')}>
        <Rows>
          <Row label={i18n.t('Source')}>
            <SourceLink {...props} />
          </Row>
          <Row label={i18n.t('Path')}>
            <MonoText>{asString(s.path) || './'}</MonoText>
          </Row>
          <Revisions obj={obj} />
          <Row label={i18n.t('Prune')}>{s.prune === true ? i18n.t('Yes') : i18n.t('No')}</Row>
          <Row label={i18n.t('Target namespace')}>
            {asString(s.targetNamespace) && <MonoText>{asString(s.targetNamespace)}</MonoText>}
          </Row>
          <Row label={i18n.t('Service account')}>
            {asString(s.serviceAccountName) && (
              <MonoText>{asString(s.serviceAccountName)}</MonoText>
            )}
          </Row>
          <Row label={i18n.t('Health checks')}>
            {s.wait === true
              ? i18n.t('Waits for every applied object')
              : asArray(s.healthChecks).length
                ? i18n.t('{count} objects', { count: asArray(s.healthChecks).length })
                : null}
          </Row>
          <Row label={i18n.t('Remote cluster')}>
            {remote ? (
              <MonoText>{asString(asObject(asObject(s.kubeConfig).secretRef).name)}</MonoText>
            ) : null}
          </Row>
          <Row label={i18n.t('Depends on')}>
            <DependsOn {...props} />
          </Row>
        </Rows>
      </Section>
      <Section
        title={
          <>
            {i18n.t('Inventory')}
            <span className="text-fg-dim ml-1.5 tabular-nums">{inventory.length}</span>
          </>
        }
      >
        <ResourceTree items={items} ctx={ctx} />
      </Section>
      <Conditions {...props} />
    </>
  );
}

/** Flux HelmRelease: chart, source, Helm release, remediation, history. */
export function FluxHelmReleaseSections(props: SectionProps) {
  i18n.useLocale();
  const { obj, ctx } = props;
  const s = spec(obj);
  const st = status(obj);
  const chart = helmReleaseChart(obj);
  const target = helmReleaseTarget(obj);
  const history = helmHistory(obj);
  const install = asObject(asObject(s.install).remediation);
  const upgrade = asObject(asObject(s.upgrade).remediation);
  const drift = asString(asObject(s.driftDetection).mode);
  const remote = isObject(s.kubeConfig);
  const openRelease = () => {
    const store = useWorkbenchStore.getState();
    store.setActiveKind(ctx.clusterId, VIEW.helmReleases);
    store.select(ctx.clusterId, VIEW.helmReleases, {
      key: VIEW.helmReleases,
      namespace: target.namespace,
      name: target.name,
    });
  };
  const failures = [
    [i18n.t('Failures'), asNumber(st.failures)],
    [i18n.t('Install failures'), asNumber(st.installFailures)],
    [i18n.t('Upgrade failures'), asNumber(st.upgradeFailures)],
  ].filter(([, n]) => (n as number) > 0) as Array<[string, number]>;
  return (
    <>
      <FluxStatusSection {...props} title={obj.kind} />
      <Section title={i18n.t('Chart')}>
        <Rows>
          <Row label={i18n.t('Chart')}>
            {chart.chart ? <MonoText>{`${chart.chart}@${chart.version || '*'}`}</MonoText> : null}
          </Row>
          <Row label={i18n.t('Source')}>
            <SourceLink {...props} />
          </Row>
          <Revisions obj={obj} />
          <Row label={i18n.t('Helm release')}>
            {remote ? (
              <MonoText>{`${target.namespace}/${target.name}`}</MonoText>
            ) : (
              <button
                type="button"
                onClick={openRelease}
                className="text-accent hover:text-accent-hover text-left hover:underline"
                title={i18n.t('Open in Helm Releases')}
              >
                {`${target.namespace}/${target.name}`}
              </button>
            )}
          </Row>
          <Row label={i18n.t('Target namespace')}>
            {asString(s.targetNamespace) && <MonoText>{asString(s.targetNamespace)}</MonoText>}
          </Row>
          <Row label={i18n.t('Drift detection')}>{drift || null}</Row>
          <Row label={i18n.t('Remediation')}>
            {isObject(asObject(s.install).remediation) ||
            isObject(asObject(s.upgrade).remediation) ? (
              <MonoText>
                {i18n.t('install retries {install} · upgrade retries {upgrade}', {
                  install: asString(install.retries) || '0',
                  upgrade: asString(upgrade.retries) || '0',
                })}
                {asString(upgrade.strategy) && ` · ${asString(upgrade.strategy)}`}
              </MonoText>
            ) : null}
          </Row>
          <Row label={i18n.t('Failures')}>
            {failures.length ? (
              <span className="text-status-error">
                {failures.map(([label, n]) => `${label}: ${n}`).join(' · ')}
              </span>
            ) : null}
          </Row>
          <Row label={i18n.t('Values from')}>
            {asArray(s.valuesFrom).length ? (
              <ChipList
                entries={asArray(s.valuesFrom)
                  .filter(isObject)
                  .map((v) => `${asString(v.kind)}/${asString(v.name)}`)}
              />
            ) : null}
          </Row>
          <Row label={i18n.t('Depends on')}>
            <DependsOn {...props} />
          </Row>
        </Rows>
      </Section>
      {history.length > 0 && (
        <Section title={i18n.t('History')}>
          <MiniTable
            rows={history.slice(0, 10)}
            rowKey={(h) => String(h.version)}
            columns={[
              {
                label: i18n.t('Revision'),
                cell: (h) => <span className="tabular-nums">{h.version}</span>,
              },
              {
                label: i18n.t('Chart'),
                lang: 'en',
                cell: (h) => <MonoText>{`${h.chartName}@${h.chartVersion}`}</MonoText>,
              },
              { label: i18n.t('App version'), cell: (h) => h.appVersion || '—' },
              {
                label: i18n.t('Status'),
                cell: (h) => (
                  <ToneText
                    tone={
                      h.status === 'deployed'
                        ? 'success'
                        : h.status === 'failed'
                          ? 'error'
                          : h.status === 'superseded'
                            ? 'muted'
                            : 'warning'
                    }
                  >
                    {h.status}
                  </ToneText>
                ),
              },
              {
                label: i18n.t('Deployed'),
                cell: (h) => formatAge(h.lastDeployed, ctx.now),
                className: 'text-right whitespace-nowrap',
              },
            ]}
          />
        </Section>
      )}
      <Conditions {...props} />
    </>
  );
}

/** Flux sources: URL, reference, artifact, Ready. */
export function FluxSourceSections(props: SectionProps) {
  i18n.useLocale();
  const { obj, ctx } = props;
  const s = spec(obj);
  const artifact = fluxArtifact(obj);
  const secret = asString(asObject(s.secretRef).name);
  const reference = fluxSourceReference(obj);
  return (
    <>
      <FluxStatusSection {...props} title={obj.kind} />
      <Section title={i18n.t('Source')}>
        <Rows>
          <Row label={i18n.t('URL')}>
            {asString(s.url) && <MonoText>{asString(s.url)}</MonoText>}
          </Row>
          <Row label={i18n.t('Endpoint')}>
            {asString(s.endpoint) && <MonoText>{asString(s.endpoint)}</MonoText>}
          </Row>
          <Row label={obj.kind === 'HelmRepository' ? i18n.t('Type') : i18n.t('Reference')}>
            {reference && <MonoText>{reference}</MonoText>}
          </Row>
          {obj.kind === 'HelmChart' && (
            <Row label={i18n.t('Source')}>
              <SourceLink {...props} />
            </Row>
          )}
          <Row label={i18n.t('Provider')}>{asString(s.provider) || null}</Row>
          <Row label={i18n.t('Secret')}>
            {secret ? (
              <RefLink
                target={{
                  apiVersion: 'v1',
                  kind: 'Secret',
                  name: secret,
                  namespace: obj.metadata.namespace,
                }}
                ctx={ctx}
              />
            ) : null}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Artifact')}>
        {artifact ? (
          <Rows>
            <Row label={i18n.t('Revision')}>
              <MonoText>{artifact.revision}</MonoText>
            </Row>
            <Row label={i18n.t('Digest')}>
              {artifact.digest && (
                <MonoText title={artifact.digest}>{shortRevision(artifact.digest)}</MonoText>
              )}
            </Row>
            <Row label={i18n.t('Updated')}>
              {artifact.lastUpdateTime ? (
                <span title={artifact.lastUpdateTime}>
                  {i18n.t('{age} ago', { age: formatAge(artifact.lastUpdateTime, ctx.now) })}
                </span>
              ) : null}
            </Row>
            <Row label={i18n.t('Size')}>
              {artifact.size > 0 ? formatBytes(artifact.size) : null}
            </Row>
          </Rows>
        ) : (
          <p className="text-fg-dim text-[12px]">{i18n.t('No artifact yet.')}</p>
        )}
      </Section>
      <Conditions {...props} />
    </>
  );
}

/** Other Flux kinds (notifications, image automation): readiness, then the generic view. */
export function FluxGenericSections(props: SectionProps) {
  i18n.useLocale();
  return (
    <>
      <FluxStatusSection {...props} title={props.obj.kind} />
      <GenericSections {...props} />
    </>
  );
}

/** Dedicated section component for a Flux object. */
export function fluxSectionsFor(obj: KubeObject) {
  if (isFluxKustomization(obj)) return FluxKustomizationSections;
  if (isFluxHelmRelease(obj)) return FluxHelmReleaseSections;
  if (isFluxSource(obj)) return FluxSourceSections;
  return FluxGenericSections;
}
