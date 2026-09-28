import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpCircle,
  CircleCheck,
  Download,
  Eye,
  Info,
  Loader2,
  Lock,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { resolveKindName } from '@/lib/kube/catalog';
import { deprecatedApi, deprecationMessage } from '@/lib/kube/deprecations';
import type { SchemaIssue } from '@/lib/kube/schema/validate';
import { valuesIssues, valuesSchema } from '@/lib/kube/schema/values';
import { compareVersions, isPrerelease } from '@/lib/semver';
import { useAppStore } from '@/store/useAppStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type {
  HelmChartVersion,
  HelmInstallRequest,
  HelmInstallResult,
  HelmReleaseDetail,
  HelmUpgradePreview,
  HelmUpgradeRequest,
} from '@/types';
import { confirmDestructive } from '../actions/guard';
import { DiffView } from '../common/DiffView';
import { MonacoView } from '../common/MonacoView';
import { useCluster, useNamespaceNames } from '../data/hooks';
import { refreshPolledPrefix, usePolled } from '../data/polled';
import { CodeBlock } from '../details/primitives';
import { errorText, useNow } from '../util';
import { ChartAvatar } from './ChartBits';
import { kindIconFor } from './changeBits';
import {
  CHART_KEYS,
  formatElapsed,
  groupByKind,
  namespaceError,
  parseManifest,
  releaseNameError,
  sameValues,
  valuesError,
} from './charts';
import { UpgradeChanges } from './UpgradeChanges';

export type DeployTarget =
  | { mode: 'install'; chartRef: string; version: string | null }
  | { mode: 'upgrade'; detail: HelmReleaseDetail };

type Pane = 'values' | 'preview';

interface Preview {
  key: string;
  result?: HelmInstallResult;
  /** Upgrades: the object-level review (helm-diff style). */
  upgrade?: HelmUpgradePreview;
  error?: string;
}

const NEWER_DOT = 'rgb(var(--accent))';

/**
 * "Install chart" and "Upgrade release": chart version, release options and
 * a values editor (checked against the chart's `values.schema.json` when it
 * has one), a dry-run preview (resources, manifest, notes — or, for
 * upgrades, a review of added / changed / removed objects against the
 * running revision and optionally the live objects), then the real run with
 * progress. Upgrades are reviewed before they run. Dry runs work on
 * read-only clusters; the real run does not.
 */
export function HelmDeployDialog({
  clusterId,
  target,
  namespaceHint,
  onClose,
}: {
  clusterId: string;
  target: DeployTarget;
  /** Preselected namespace for installs (the workbench's single namespace). */
  namespaceHint?: string | null;
  onClose: () => void;
}) {
  i18n.useLocale();
  const upgrade = target.mode === 'upgrade' ? target.detail : null;
  const { cluster, readOnly, production } = useCluster(clusterId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // -- Chart & version ------------------------------------------------------
  const chartSource = useUpgradeChart(upgrade);
  const [chartRefOverride, setChartRefOverride] = useState<string | null>(null);
  const chartRef =
    target.mode === 'install' ? target.chartRef : (chartRefOverride ?? chartSource.chartRef);
  const versions = usePolled(
    chartRef ? CHART_KEYS.versions(chartRef) : null,
    () => ipc.helmChartVersions(chartRef!),
    null,
  );
  const newestStable =
    versions.data?.find((v) => !isPrerelease(v.version))?.version ??
    versions.data?.[0]?.version ??
    null;
  const [versionPick, setVersionPick] = useState<string | null>(
    target.mode === 'install' ? target.version : null,
  );
  const version = versionPick ?? newestStable;
  const chartName = upgrade?.release.chart ?? chartRef?.split('/').pop() ?? '';

  // -- Release ----------------------------------------------------------------
  const [name, setName] = useState(upgrade?.release.name ?? chartName.slice(0, 53));
  const namespacesQuery = useNamespaceNames(clusterId, true);
  const [namespace, setNamespace] = useState(
    upgrade?.release.namespace ?? namespaceHint ?? cluster?.default_namespace ?? 'default',
  );
  const knownNamespace = !namespacesQuery.data || namespacesQuery.data.includes(namespace);
  const [createNamespace, setCreateNamespace] = useState(false);
  useEffect(() => {
    if (!knownNamespace) setCreateNamespace(true);
  }, [knownNamespace]);

  // -- Options ------------------------------------------------------------------
  const [wait, setWait] = useState(false);
  const [atomic, setAtomic] = useState(false);
  const [timeout, setTimeoutText] = useState('300');
  const [description, setDescription] = useState('');
  const [reuseValues, setReuseValues] = useState(false);
  const [resetValues, setResetValues] = useState(false);

  // -- Values -------------------------------------------------------------------
  const defaults = usePolled(
    target.mode === 'install' && chartRef && version ? CHART_KEYS.show(chartRef, version) : null,
    () => ipc.helmChartShow(chartRef!, version),
    null,
  );
  const baseline = upgrade ? upgrade.values_yaml : (defaults.data?.values_yaml ?? null);
  const [draft, setDraft] = useState<string | null>(upgrade ? upgrade.values_yaml : null);
  const [seed, setSeed] = useState<{ text: string; version: string | null } | null>(
    upgrade ? { text: upgrade.values_yaml, version: null } : null,
  );
  const edited = draft !== null && seed !== null && !sameValues(draft, seed.text);
  useEffect(() => {
    // Untouched values follow the defaults of the selected version.
    if (upgrade || baseline === null || edited) return;
    setDraft(baseline);
    setSeed({ text: baseline, version });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline]);
  const valuesProblem = draft ? valuesError(draft) : null;

  // -- Values schema (advisory: completion, hovers, markers; never blocks) ------
  const chartSchema = usePolled(
    chartRef && version ? CHART_KEYS.schema(chartRef, version) : null,
    () => ipc.helmChartValuesSchema(chartRef!, version),
    null,
  );
  // Upgrades keep the running chart version when its repository is unknown.
  const releaseSchema = usePolled(
    upgrade &&
      (!chartRef || chartSchema.error) &&
      (version ?? upgrade.release.chart_version) === upgrade.release.chart_version
      ? `${clusterId}|helm-schema|${upgrade.release.namespace}/${upgrade.release.name}|${upgrade.release.revision}`
      : null,
    () => ipc.helmReleaseValuesSchema(clusterId, upgrade!.release.namespace, upgrade!.release.name),
    null,
  );
  const schemaJson = chartSchema.data ?? releaseSchema.data ?? null;
  // Helm validates the values merged over the chart defaults.
  const upgradeDefaults = usePolled(
    upgrade && schemaJson && chartRef && version ? CHART_KEYS.show(chartRef, version) : null,
    () => ipc.helmChartShow(chartRef!, version),
    null,
  );
  const defaultsYaml = upgrade
    ? (upgradeDefaults.data?.values_yaml ?? null)
    : (defaults.data?.values_yaml ?? null);
  const schema = useMemo(
    () => (schemaJson ? valuesSchema(schemaJson, defaultsYaml) : null),
    [schemaJson, defaultsYaml],
  );
  const schemaProblems = useMemo(
    () => (schema && draft !== null && !valuesProblem ? valuesIssues(draft, schema) : []),
    [schema, draft, valuesProblem],
  );

  // -- Requests ---------------------------------------------------------------
  const timeoutSecs = Number.parseInt(timeout, 10) > 0 ? Number.parseInt(timeout, 10) : null;
  const nameProblem = upgrade ? null : releaseNameError(name);
  const namespaceProblem = upgrade ? null : namespaceError(namespace);
  const ready =
    !!chartRef &&
    !!version &&
    !nameProblem &&
    !namespaceProblem &&
    !valuesProblem &&
    draft !== null;
  const installRequest = (dryRun: boolean): HelmInstallRequest => ({
    release_name: name,
    namespace,
    chart_ref: chartRef ?? '',
    version,
    values_yaml: edited ? (draft ?? '') : '',
    create_namespace: createNamespace,
    wait,
    atomic,
    timeout_secs: timeoutSecs,
    description: description.trim() || null,
    dry_run: dryRun,
  });
  const upgradeRequest = (dryRun: boolean): HelmUpgradeRequest => ({
    chart_ref: chartRef ?? '',
    version,
    values_yaml: draft ?? '',
    reuse_values: reuseValues,
    reset_values: resetValues,
    wait,
    atomic,
    timeout_secs: timeoutSecs,
    dry_run: dryRun,
  });
  const inputsKey = JSON.stringify(upgrade ? upgradeRequest(true) : installRequest(true));
  const release = upgrade?.release;
  const run = (dryRun: boolean) =>
    release
      ? ipc.helmUpgrade(clusterId, release.namespace, release.name, upgradeRequest(dryRun))
      : ipc.helmInstall(clusterId, installRequest(dryRun));

  // -- Preview & run ----------------------------------------------------------
  const [pane, setPane] = useState<Pane>('values');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveDiff, setLiveDiff] = useState(false);
  const now = useNow(1000, running !== null);

  const runPreview = async (live = liveDiff) => {
    if (!ready) return;
    const key = inputsKey;
    setPane('preview');
    setPreviewing(true);
    try {
      if (release) {
        const review = await ipc.helmUpgradePreview(
          clusterId,
          release.namespace,
          release.name,
          upgradeRequest(true),
          live,
        );
        if (mounted.current) setPreview({ key, result: review.result, upgrade: review });
      } else {
        const result = await run(true);
        if (mounted.current) setPreview({ key, result });
      }
    } catch (e) {
      if (mounted.current) setPreview({ key, error: errorText(e) });
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  };
  const changeLiveDiff = (live: boolean) => {
    setLiveDiff(live);
    if (live && preview?.upgrade && !preview.upgrade.live_checked) void runPreview(true);
  };

  const execute = async () => {
    setRunError(null);
    setRunning(Date.now());
    try {
      const result = await run(false);
      const version = result.release?.chart_version ?? versionPick ?? '';
      useAppStore.getState().pushToast(
        'success',
        release
          ? i18n.t('Upgraded {name} to {chart} {version}', {
              name: release.name,
              chart: chartName,
              version,
            })
          : i18n.t('Installed {name} in {namespace}', { name, namespace }),
      );
      refreshPolledPrefix(`${clusterId}|helm-`);
      if (!mounted.current) return;
      onClose();
      if (!release) {
        const store = useWorkbenchStore.getState();
        store.setActiveKind(clusterId, VIEW.helmReleases);
        store.select(clusterId, VIEW.helmReleases, { key: VIEW.helmReleases, namespace, name });
      }
    } catch (e) {
      const message = errorText(e);
      if (mounted.current) setRunError(message);
      else useAppStore.getState().pushToast('error', message);
    } finally {
      if (mounted.current) setRunning(null);
    }
  };

  const submit = () => {
    if (!ready || readOnly) return;
    if (release) {
      confirmDestructive({
        cluster,
        title: i18n.t('Upgrade release'),
        message: i18n.t('Upgrade "{name}" to {chart} {version}? A new revision is created.', {
          name: release.name,
          chart: chartName,
          version: version ?? '',
        }),
        confirmLabel: i18n.t('Upgrade'),
        typeName: release.name,
        // Close the confirmation right away; progress shows in this dialog.
        run: () => void execute(),
      });
      return;
    }
    if (production) {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Install chart'),
        message: `${i18n.t('Install {chart} {version} as "{name}" into {namespace} on {cluster}?', {
          chart: chartRef ?? '',
          version: version ?? '',
          name,
          namespace,
          cluster: cluster?.name ?? '',
        })}\n\n${i18n.t('This is a production cluster.')}`,
        confirmLabel: i18n.t('Install'),
        typeToConfirm: name,
        onConfirm: () => void execute(),
      });
      return;
    }
    void execute();
  };

  const close = () => {
    if (useAppStore.getState().confirm) return;
    // Escape inside the values editor belongs to Monaco (suggestions, find).
    if (document.activeElement?.closest('.monaco-editor')) return;
    onClose();
  };

  const versionOptions = useVersionOptions(
    versions.data,
    newestStable,
    release?.chart_version ?? null,
  );
  const newer = release
    ? (versions.data ?? []).filter((v) => compareVersions(v.version, release.chart_version) > 0)
    : [];
  const stale = !!preview && preview.key !== inputsKey;
  const verb = release ? i18n.t('Upgrade') : i18n.t('Install');
  // Upgrades show their review first (a failed dry run counts: it is the answer).
  const needsReview = !!release && (!preview || stale);

  return (
    <Dialog
      size="xl"
      title={release ? i18n.t('Upgrade release') : i18n.t('Install chart')}
      subtitle={
        release
          ? `${release.namespace}/${release.name} · ${release.chart}-${release.chart_version}`
          : (chartRef ?? '')
      }
      onClose={close}
      bodyClassName="flex min-h-0 flex-1 overflow-hidden"
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center gap-2 text-[11.5px]">
            {running !== null ? (
              <>
                <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
                <span className="text-fg truncate">
                  {release
                    ? i18n.t('Upgrading {name}… {elapsed}', {
                        name: release.name,
                        elapsed: formatElapsed(now - running),
                      })
                    : i18n.t('Installing {name}… {elapsed}', {
                        name,
                        elapsed: formatElapsed(now - running),
                      })}
                </span>
                <span className="text-fg-dim hidden truncate lg:inline">
                  {i18n.t('You can close this window; Kubepit tells you when it finishes.')}
                </span>
              </>
            ) : readOnly ? (
              <span className="text-fg-muted flex items-center gap-1.5">
                <Lock className="h-3 w-3" />
                {i18n.t('Read-only cluster: preview only, changes are blocked.')}
              </span>
            ) : production ? (
              <span className="text-status-starting flex items-center gap-1.5">
                <TriangleAlert className="h-3 w-3" />
                {i18n.t('Production cluster: you will be asked to type the release name.')}
              </span>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {running !== null ? i18n.t('Close') : i18n.t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={
              previewing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )
            }
            disabled={!ready || previewing || running !== null}
            onClick={() => void runPreview()}
          >
            {i18n.t('Preview')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leftIcon={
              needsReview ? (
                <Eye className="h-3.5 w-3.5" />
              ) : release ? (
                <ArrowUpCircle className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
            disabled={
              !ready || running !== null || (needsReview ? previewing : readOnly || previewing)
            }
            title={
              needsReview
                ? i18n.t('Render the upgrade and review the changes before running it')
                : readOnly
                  ? i18n.t('Read-only cluster: changes are blocked')
                  : undefined
            }
            onClick={needsReview ? () => void runPreview() : submit}
          >
            {needsReview ? i18n.t('Review changes') : verb}
          </Button>
        </>
      }
    >
      <div className="flex h-[min(72vh,760px)] min-h-0 w-full">
        <div className="overlay-scroll border-border/60 w-[300px] shrink-0 space-y-4 overflow-y-auto border-r p-4">
          <div className="flex items-center gap-2.5">
            <ChartAvatar name={chartName || 'chart'} size="lg" />
            <div className="min-w-0">
              <p className="text-fg truncate text-[13px] font-semibold">{chartName}</p>
              <p className="text-fg-dim truncate font-mono text-[11px]">
                {chartRef ?? (chartSource.resolving ? i18n.t('Locating chart…') : '—')}
              </p>
            </div>
          </div>
          {release && (
            <Field
              label={i18n.t('Chart')}
              error={
                !chartSource.resolving && !chartRef
                  ? i18n.t(
                      'The chart "{chart}" is not in your repositories. Add its repository, or enter a reference such as oci://registry/chart.',
                      { chart: release.chart },
                    )
                  : null
              }
            >
              <SearchableSelect
                label={i18n.t('Chart')}
                value={chartRef ?? ''}
                onChange={(ref) => {
                  setChartRefOverride(ref);
                  setVersionPick(null);
                }}
                options={chartSource.candidates.map((ref) => ({ value: ref, label: ref }))}
                placeholder={
                  chartSource.resolving ? i18n.t('Locating chart…') : i18n.t('Choose a chart')
                }
                searchPlaceholder={i18n.t('repo/chart or oci://…')}
                createOption={(q) =>
                  /^(oci:\/\/\S+|[\w.-]+\/[\w.-]+)$/.test(q.trim())
                    ? { value: q.trim(), label: q.trim(), badge: i18n.t('custom') }
                    : null
                }
                className="w-full font-mono"
                menuWidth={280}
              />
            </Field>
          )}
          <Field
            label={i18n.t('Version')}
            hint={
              release && versions.data
                ? newer.length
                  ? i18n.plural(
                      '{count} newer version available',
                      '{count} newer versions available',
                      newer.length,
                    )
                  : i18n.t('Already on the newest version.')
                : undefined
            }
            error={versions.error}
          >
            <SearchableSelect
              label={i18n.t('Chart version')}
              value={version ?? ''}
              onChange={setVersionPick}
              options={versionOptions}
              placeholder={chartRef && !versions.data ? i18n.t('Loading…') : i18n.t('Version')}
              searchPlaceholder={i18n.t('Filter versions…')}
              disabled={!versionOptions.length || running !== null}
              className="w-full font-mono"
              menuWidth={280}
            />
          </Field>
          {release ? (
            <div className="text-[12px]">
              <p className="text-fg-dim mb-1 text-[11px] font-semibold tracking-[0.14em] uppercase">
                {i18n.t('Release')}
              </p>
              <p className="text-fg font-mono text-[11.5px]">
                {release.namespace}/{release.name}
              </p>
              <p className="text-fg-dim mt-0.5 text-[11px]">
                {i18n.t('Revision {revision} → {next}', {
                  revision: release.revision,
                  next: release.revision + 1,
                })}
              </p>
            </div>
          ) : (
            <>
              <Field label={i18n.t('Release name')} error={name ? nameProblem : null}>
                <Input
                  mono
                  value={name}
                  onChange={(e) => setName(e.target.value.trim())}
                  maxLength={53}
                  spellCheck={false}
                  disabled={running !== null}
                />
              </Field>
              <Field label={i18n.t('Namespace')} error={namespaceProblem}>
                <SearchableSelect
                  label={i18n.t('Namespace')}
                  value={namespace}
                  onChange={setNamespace}
                  options={[
                    ...(namespacesQuery.data ?? []).map((ns) => ({ value: ns, label: ns })),
                    ...(!knownNamespace
                      ? [{ value: namespace, label: namespace, badge: i18n.t('new') }]
                      : []),
                  ]}
                  createOption={(q) =>
                    !namespaceError(q.trim())
                      ? { value: q.trim(), label: q.trim(), badge: i18n.t('new') }
                      : null
                  }
                  searchPlaceholder={i18n.t('Find or type a namespace…')}
                  disabled={running !== null}
                  className="w-full font-mono"
                  menuWidth={280}
                />
              </Field>
              <Switch
                checked={createNamespace}
                onChange={setCreateNamespace}
                disabled={running !== null}
                label={i18n.t('Create namespace if missing')}
                description={
                  !knownNamespace
                    ? i18n.t('"{namespace}" does not exist yet.', { namespace })
                    : undefined
                }
              />
            </>
          )}
          <div className="border-border/60 space-y-3 border-t pt-4">
            <p className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {i18n.t('Options')}
            </p>
            {release && (
              <>
                <Switch
                  checked={reuseValues}
                  onChange={(v) => {
                    setReuseValues(v);
                    if (v) setResetValues(false);
                  }}
                  label={i18n.t('Reuse current values')}
                  description={i18n.t('Merge the editor over the values of revision {revision}.', {
                    revision: release.revision,
                  })}
                />
                <Switch
                  checked={resetValues}
                  onChange={(v) => {
                    setResetValues(v);
                    if (v) setReuseValues(false);
                  }}
                  label={i18n.t('Reset values')}
                  description={i18n.t('Start from the chart defaults plus the editor only.')}
                />
              </>
            )}
            <Switch
              checked={wait}
              onChange={setWait}
              label={i18n.t('Wait for resources')}
              description={i18n.t('Finish only when pods, services and jobs are ready.')}
            />
            <Switch
              checked={atomic}
              onChange={setAtomic}
              label={i18n.t('Roll back on failure')}
              description={
                release
                  ? i18n.t('Return to the previous revision if the upgrade fails (atomic).')
                  : i18n.t('Uninstall again if the install fails (atomic).')
              }
            />
            <Field label={i18n.t('Timeout (seconds)')} hint={i18n.t('For hooks and waiting.')}>
              <Input
                mono
                inputMode="numeric"
                value={timeout}
                onChange={(e) => setTimeoutText(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            {!release && (
              <Field label={i18n.t('Description')}>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={i18n.t('Optional note stored with the release')}
                />
              </Field>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-border/60 flex h-10 shrink-0 items-center gap-2 border-b px-3">
            <Tabs<Pane>
              value={pane}
              onChange={setPane}
              tabs={[
                { key: 'values', label: i18n.t('Values') },
                {
                  key: 'preview',
                  label: i18n.t('Preview'),
                  badge:
                    preview && !stale ? (
                      preview.error ? (
                        <TriangleAlert className="text-status-error h-3 w-3" />
                      ) : (
                        <CircleCheck className="text-status-running h-3 w-3" />
                      )
                    ) : undefined,
                },
              ]}
            />
            {pane === 'values' && (
              <ValuesStatus
                edited={edited}
                problem={valuesProblem}
                schema={{
                  present: !!schema,
                  loading: chartSchema.loading || releaseSchema.loading,
                  problems: schemaProblems,
                }}
                upgradeRevision={release?.revision ?? null}
                onReset={() => seed && setDraft(seed.text)}
                onDefaults={
                  !upgrade && baseline !== null && seed && seed.text !== baseline
                    ? () => {
                        setDraft(baseline);
                        setSeed({ text: baseline, version });
                      }
                    : null
                }
              />
            )}
          </div>
          {runError && (
            <div className="border-status-error/30 bg-status-error/[0.06] shrink-0 border-b px-4 py-3">
              <p className="text-status-error flex items-center gap-1.5 text-[12px] font-semibold">
                <TriangleAlert className="h-3.5 w-3.5" />
                {release ? i18n.t('Upgrade failed') : i18n.t('Install failed')}
              </p>
              <pre className="text-status-error/90 mt-1.5 max-h-40 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">
                {runError}
              </pre>
            </div>
          )}
          {pane === 'values' ? (
            draft === null ? (
              <PaneMessage>
                {defaults.error ? (
                  <span className="text-status-error font-mono text-[11.5px] break-words">
                    {defaults.error}
                  </span>
                ) : (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {i18n.t('Loading chart values…')}
                  </>
                )}
              </PaneMessage>
            ) : (
              <>
                {!upgrade && edited && seed?.version && version && seed.version !== version && (
                  <p className="border-border/50 bg-status-starting/[0.06] text-fg-muted flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-[11px]">
                    <Info className="text-status-starting h-3 w-3 shrink-0" />
                    {i18n.t('Your edits are kept; the defaults of {version} were not applied.', {
                      version,
                    })}
                  </p>
                )}
                {upgrade && !draft.trim() && !resetValues && (
                  <p className="border-border/50 text-fg-muted flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-[11px]">
                    <Info className="h-3 w-3 shrink-0" />
                    {i18n.t(
                      'With no values, helm keeps the current ones. Turn on "Reset values" to clear them.',
                    )}
                  </p>
                )}
                <MonacoView
                  value={draft}
                  readOnly={false}
                  onChange={setDraft}
                  valuesSchema={schema}
                />
              </>
            )
          ) : (
            <PreviewPane
              upgrade={upgrade}
              preview={preview}
              previewing={previewing}
              stale={stale}
              ready={ready}
              namespace={namespace}
              onRun={() => void runPreview()}
              liveDiff={liveDiff}
              onLiveDiffChange={changeLiveDiff}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Locate the release's chart in the configured repositories (upgrade mode). */
function useUpgradeChart(detail: HelmReleaseDetail | null) {
  const catalog = usePolled(
    detail ? CHART_KEYS.catalog : null,
    () => ipc.helmChartSearch('', { versions: false, devel: false }),
    null,
  );
  const candidates = useMemo(
    () => (catalog.data ?? []).filter((c) => c.chart === detail?.release.chart).map((c) => c.name),
    [catalog.data, detail],
  );
  const [chartRef, setChartRef] = useState<string | null>(null);
  const [resolving, setResolving] = useState(!!detail);
  useEffect(() => {
    if (!detail || chartRef) return;
    if (catalog.error) {
      setResolving(false);
      return;
    }
    if (!catalog.data) return;
    if (!candidates.length) {
      setResolving(false);
      return;
    }
    let cancelled = false;
    // Prefer the repository that serves the running chart version.
    void Promise.all(
      candidates.map((ref) =>
        ipc
          .helmChartVersions(ref)
          .then((list) => [ref, list] as const)
          .catch(() => [ref, [] as HelmChartVersion[]] as const),
      ),
    ).then((found) => {
      if (cancelled) return;
      const exact = found.find(([, list]) =>
        list.some((v) => v.version === detail.release.chart_version),
      );
      setChartRef((exact ?? found[0])![0]);
      setResolving(false);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, chartRef, catalog.data, catalog.error, candidates]);
  return { chartRef, candidates, resolving };
}

function useVersionOptions(
  versions: HelmChartVersion[] | undefined,
  newestStable: string | null,
  current: string | null,
) {
  return useMemo(
    () =>
      (versions ?? []).map((v) => {
        const newer = current !== null && compareVersions(v.version, current) > 0;
        return {
          value: v.version,
          label: v.version,
          description: v.app_version
            ? i18n.t('App {version}', { version: v.app_version })
            : undefined,
          color: newer ? NEWER_DOT : undefined,
          badge:
            v.version === current
              ? i18n.t('current')
              : v.version === newestStable
                ? i18n.t('latest')
                : isPrerelease(v.version)
                  ? i18n.t('pre-release')
                  : newer
                    ? i18n.t('newer')
                    : undefined,
        };
      }),
    [versions, newestStable, current],
  );
}

function ValuesStatus({
  edited,
  problem,
  schema,
  upgradeRevision,
  onReset,
  onDefaults,
}: {
  edited: boolean;
  problem: string | null;
  schema: { present: boolean; loading: boolean; problems: SchemaIssue[] };
  upgradeRevision: number | null;
  onReset: () => void;
  onDefaults: (() => void) | null;
}) {
  i18n.useLocale();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">
      <span className={cn('shrink-0', edited ? 'text-status-starting' : 'text-fg-dim')}>
        {edited
          ? i18n.t('Edited')
          : upgradeRevision !== null
            ? i18n.t('Values of revision {revision}', { revision: upgradeRevision })
            : i18n.t('Chart defaults')}
      </span>
      {problem ? (
        <span className="text-status-error flex min-w-0 items-center gap-1" title={problem}>
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="truncate">{i18n.t('Invalid YAML: {error}', { error: problem })}</span>
        </span>
      ) : schema.present && schema.problems.length ? (
        <span
          className="text-status-starting flex min-w-0 items-center gap-1"
          title={schema.problems
            .slice(0, 8)
            .map((p) => p.message)
            .join('\n')}
        >
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {i18n.plural(
              '{count} problem against values.schema.json',
              '{count} problems against values.schema.json',
              schema.problems.length,
            )}
          </span>
        </span>
      ) : (
        <span className="text-status-running flex shrink-0 items-center gap-1">
          <CircleCheck className="h-3 w-3" />
          {schema.present ? i18n.t('Matches values.schema.json') : i18n.t('Valid YAML')}
        </span>
      )}
      {schema.loading && !schema.present && (
        <Loader2
          className="text-fg-dim h-3 w-3 shrink-0 animate-spin"
          aria-label={i18n.t('Loading values.schema.json')}
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {onDefaults && (
          <Button size="xs" variant="ghost" onClick={onDefaults}>
            {i18n.t('Load new defaults')}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={!edited}
          leftIcon={<RotateCcw className="h-3 w-3" />}
          onClick={onReset}
        >
          {upgradeRevision !== null ? i18n.t('Reset') : i18n.t('Reset to defaults')}
        </Button>
      </div>
    </div>
  );
}

function PaneMessage({ children }: { children: ReactNode }) {
  return (
    <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-8 text-center text-[12px]">
      {children}
    </div>
  );
}

type InstallTab = 'resources' | 'manifest' | 'notes';
type UpgradeTab = 'changes' | 'manifest' | 'values' | 'notes';

function PreviewPane({
  upgrade,
  preview,
  previewing,
  stale,
  ready,
  namespace,
  onRun,
  liveDiff,
  onLiveDiffChange,
}: {
  upgrade: HelmReleaseDetail | null;
  preview: Preview | null;
  previewing: boolean;
  stale: boolean;
  ready: boolean;
  namespace: string;
  onRun: () => void;
  liveDiff: boolean;
  onLiveDiffChange: (live: boolean) => void;
}) {
  i18n.useLocale();
  const [installTab, setInstallTab] = useState<InstallTab>('resources');
  const [upgradeTab, setUpgradeTab] = useState<UpgradeTab>('changes');
  const [computed, setComputed] = useState(false);
  const result = preview?.result;
  const resources = useMemo(() => (result ? parseManifest(result.manifest) : []), [result]);

  // Re-rendering with the live comparison keeps the current review on screen.
  if (previewing && !(preview?.upgrade && liveDiff))
    return (
      <PaneMessage>
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Rendering a dry run against the cluster…')}
      </PaneMessage>
    );
  if (!preview)
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="bg-accent/10 text-accent mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
            <Eye className="h-5 w-5" />
          </div>
          <h3 className="text-fg text-[13.5px] font-semibold">
            {i18n.t('Preview before you apply')}
          </h3>
          <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed">
            {upgrade
              ? i18n.t(
                  'Runs helm upgrade as a server-side dry run and compares the result with the running revision. Nothing changes in the cluster.',
                )
              : i18n.t(
                  'Runs helm install as a server-side dry run and lists what would be created. Nothing changes in the cluster.',
                )}
          </p>
          <Button
            className="mt-4"
            size="sm"
            variant="primary"
            disabled={!ready}
            leftIcon={<Eye className="h-3.5 w-3.5" />}
            onClick={onRun}
          >
            {i18n.t('Run preview')}
          </Button>
        </div>
      </div>
    );

  const staleBar = stale && (
    <p className="border-border/50 bg-status-starting/[0.06] text-fg-muted flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px]">
      <Info className="text-status-starting h-3 w-3 shrink-0" />
      {i18n.t('The inputs changed since this preview.')}
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onRun} disabled={!ready}>
        {i18n.t('Run again')}
      </Button>
    </p>
  );

  if (preview.error)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {staleBar}
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-4">
          <p className="text-status-error mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
            <TriangleAlert className="h-3.5 w-3.5" />
            {i18n.t('The dry run failed')}
          </p>
          <pre className="bg-status-error/[0.06] border-status-error/25 text-status-error rounded-md border p-3 font-mono text-[11px] break-words whitespace-pre-wrap">
            {preview.error}
          </pre>
          <Button className="mt-3" size="sm" variant="secondary" onClick={onRun} disabled={!ready}>
            {i18n.t('Run again')}
          </Button>
        </div>
      </div>
    );
  if (!result) return null;
  const notes = result.notes.trim() ? (
    <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-4">
      <CodeBlock text={result.notes} maxHeight="max-h-none" />
    </div>
  ) : (
    <PaneMessage>{i18n.t('This chart has no notes.')}</PaneMessage>
  );

  if (!upgrade)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {staleBar}
        <div className="border-border/50 flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <Tabs<InstallTab>
            value={installTab}
            onChange={setInstallTab}
            tabs={[
              {
                key: 'resources',
                label: i18n.t('Resources'),
                badge: <span className="text-fg-dim tabular-nums">{resources.length}</span>,
              },
              { key: 'manifest', label: i18n.t('Manifest') },
              { key: 'notes', label: i18n.t('Notes') },
            ]}
          />
          <span className="text-fg-dim ml-auto truncate text-[11px]">
            {i18n.plural(
              '{count} resource will be created in {namespace}',
              '{count} resources will be created in {namespace}',
              resources.length,
              { namespace },
            )}
          </span>
        </div>
        {installTab === 'resources' ? (
          <ResourceGroups resources={resources} namespace={namespace} />
        ) : installTab === 'manifest' ? (
          <MonacoView value={result.manifest} />
        ) : (
          notes
        )}
      </div>
    );

  const next = `${i18n.t('Preview')} · ${result.release?.chart_version ?? ''}`;
  const current = i18n.t('Revision {revision}', { revision: upgrade.release.revision });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {staleBar}
      <div className="border-border/50 flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Tabs<UpgradeTab>
          value={upgradeTab}
          onChange={setUpgradeTab}
          tabs={[
            { key: 'changes', label: i18n.t('Changes') },
            { key: 'manifest', label: i18n.t('Manifest diff') },
            { key: 'values', label: i18n.t('Values diff') },
            { key: 'notes', label: i18n.t('Notes') },
          ]}
        />
      </div>
      {upgradeTab === 'changes' ? (
        preview.upgrade ? (
          <UpgradeChanges
            preview={preview.upgrade}
            currentRevision={upgrade.release.revision}
            live={liveDiff}
            onLiveChange={onLiveDiffChange}
            loadingLive={previewing}
          />
        ) : null
      ) : upgradeTab === 'manifest' ? (
        <DiffView
          original={upgrade.manifest}
          modified={result.manifest}
          originalLabel={current}
          modifiedLabel={next}
          identicalHint={i18n.t('The upgrade renders exactly the same manifest.')}
        />
      ) : upgradeTab === 'values' ? (
        <DiffView
          original={computed ? upgrade.computed_values_yaml : upgrade.values_yaml}
          modified={computed ? result.computed_values_yaml : result.values_yaml}
          originalLabel={current}
          modifiedLabel={next}
          identicalHint={i18n.t('The values do not change.')}
          actions={
            <label className="text-fg-dim mr-2 flex cursor-pointer items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={computed}
                onChange={(e) => setComputed(e.target.checked)}
                className="accent-accent"
              />
              {i18n.t('Computed values')}
            </label>
          }
        />
      ) : (
        notes
      )}
    </div>
  );
}

function ResourceGroups({
  resources,
  namespace,
}: {
  resources: ReturnType<typeof parseManifest>;
  namespace: string;
}) {
  i18n.useLocale();
  const groups = groupByKind(resources);
  if (!groups.length) return <PaneMessage>{i18n.t('The chart renders no resources.')}</PaneMessage>;
  return (
    <div className="overlay-scroll min-h-0 flex-1 space-y-3 overflow-auto p-4">
      {groups.map(([kind, items]) => {
        const Icon = kindIconFor(kind);
        return (
          <section key={kind} className="border-border/60 overflow-hidden rounded-lg border">
            <header className="bg-fg/[0.025] border-border/50 flex h-8 items-center gap-2 border-b px-3">
              <Icon className="text-accent h-3.5 w-3.5" />
              <span className="text-fg text-[12px] font-medium">{kind}</span>
              <span className="bg-surface-muted text-fg-dim rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                {items.length}
              </span>
              <span className="text-fg-dim ml-auto truncate font-mono text-[10.5px]">
                {items[0]!.apiVersion}
              </span>
              <DeprecatedMarker apiVersion={items[0]!.apiVersion} kind={kind} />
            </header>
            <ul>
              {items.map((r) => (
                <li
                  key={`${r.namespace}/${r.name}`}
                  className="border-border/30 flex items-center gap-2 border-b px-3 py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="text-fg min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {r.name}
                  </span>
                  <span className="text-fg-dim shrink-0 font-mono text-[11px]">
                    {r.namespace ??
                      (resolveKindName(r.kind)?.namespaced === false
                        ? i18n.t('cluster-wide')
                        : namespace)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A warning icon when the rendered apiVersion is deprecated or removed. */
function DeprecatedMarker({ apiVersion, kind }: { apiVersion: string; kind: string }) {
  i18n.useLocale();
  const entry = deprecatedApi(apiVersion, kind);
  if (!entry) return null;
  const message = deprecationMessage(entry);
  return (
    <TriangleAlert className="text-status-starting h-3 w-3 shrink-0" aria-label={message}>
      <title>{message}</title>
    </TriangleAlert>
  );
}
