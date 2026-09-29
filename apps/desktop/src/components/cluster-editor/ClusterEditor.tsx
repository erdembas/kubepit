import * as i18n from '@/i18n';
import { useCallback, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { saveCluster } from '@/lib/clusterActions';
import { guessEnvironment, prettyContextName } from '@/lib/clusterMeta';
import { kubeconfigErrorMessage } from '@/lib/kubeconfigImport';
import { ipc } from '@/lib/ipc';
import { accessDraft, accessFromDraft, withoutCredentials } from '@/lib/prometheusAccess';
import { useAppStore, type ClusterEditorState } from '@/store/useAppStore';
import type { ClusterDef, ClusterInput } from '@/types';
import { ClusterFields, type ClusterFieldValues } from './ClusterFields';
import { KubeconfigFields, type KubeconfigSelection } from './KubeconfigFields';
import { PrometheusFields, prometheusConfig, prometheusDraft } from './PrometheusFields';
import { LokiFields, lokiConfig, lokiDraft } from './LokiFields';
import { CostFields, costConfig, costDraft } from './CostFields';
import { ProxyField } from './ProxyField';
import { proxyUrlProblem } from '@/lib/proxy';

function emptyFields(): ClusterFieldValues {
  return {
    name: '',
    tags: [],
    environment: null,
    color: null,
    sectionId: null,
    default_namespace: '',
    accessible_namespaces: '',
    read_only: false,
    notes: '',
  };
}

function fieldsFrom(cluster: ClusterDef, sectionId: string | null): ClusterFieldValues {
  return {
    name: cluster.name,
    tags: cluster.tags,
    environment: cluster.environment,
    color: cluster.color,
    sectionId,
    default_namespace: cluster.default_namespace ?? '',
    accessible_namespaces: cluster.accessible_namespaces.join(', '),
    read_only: cluster.read_only,
    notes: cluster.notes,
  };
}

function splitList(value: string) {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ClusterEditor({ state }: { state: NonNullable<ClusterEditorState> }) {
  i18n.useLocale();
  const close = () => useAppStore.getState().openClusterEditor(null);
  const clusterSection = useAppStore((s) => s.clusterSection);
  const [editing, setEditing] = useState<ClusterDef | null>(() =>
    state.mode === 'edit' ? state.cluster : null,
  );
  /** No status lookups run before the cluster exists. */
  const clusterId = editing?.id ?? null;
  const [fields, setFields] = useState<ClusterFieldValues>(() =>
    editing ? fieldsFrom(editing, clusterSection[editing.id] ?? null) : emptyFields(),
  );
  const [replaceKubeconfig, setReplaceKubeconfig] = useState(false);
  const [selection, setSelection] = useState<KubeconfigSelection | null>(null);
  const autoName = useRef('');
  const autoNamespace = useRef('');
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prometheus, setPrometheus] = useState(() => prometheusDraft(editing?.prometheus));
  const [access, setAccess] = useState(() => accessDraft(editing?.prometheus_access));
  const [loki, setLoki] = useState(() => lokiDraft(editing?.loki));
  const [cost, setCost] = useState(() => costDraft(editing?.cost));
  // Connectivity: per-cluster proxy override.
  const [proxy, setProxy] = useState(editing?.proxy_url ?? '');

  const onKubeconfigChange = useCallback(
    (next: KubeconfigSelection | null) => {
      setSelection(next);
      if (!editing && next) {
        const suggested = prettyContextName(next.input.context);
        const previous = autoName.current;
        autoName.current = suggested;
        const previousNamespace = autoNamespace.current;
        autoNamespace.current = next.namespace ?? '';
        setFields((current) => ({
          ...current,
          name: !current.name || current.name === previous ? suggested : current.name,
          environment: current.environment ?? guessEnvironment(next.input.context),
          default_namespace:
            !current.default_namespace || current.default_namespace === previousNamespace
              ? (next.namespace ?? '')
              : current.default_namespace,
        }));
      }
    },
    [editing],
  );

  const submit = async () => {
    setError(null);
    if ((!editing || replaceKubeconfig) && !selection)
      return setError(i18n.t('Choose a valid kubeconfig connection first.'));
    const name = fields.name.trim();
    if (!name) return setError(i18n.t('Give the cluster a name.'));
    const proxyProblem = proxyUrlProblem(proxy);
    if (proxyProblem) return setError(proxyProblem);
    const metrics = prometheusConfig(prometheus);
    if ('error' in metrics) return setError(metrics.error);
    // Hidden while Prometheus is off: kept as saved, without credentials
    // (they need a chosen service).
    const secured =
      metrics.config.mode === 'off'
        ? { access: withoutCredentials(editing?.prometheus_access) }
        : accessFromDraft(access, metrics.config);
    if ('error' in secured) return setError(secured.error);
    const logs = lokiConfig(loki);
    if ('error' in logs) return setError(logs.error);
    const costing = costConfig(cost);
    if ('error' in costing) return setError(costing.error);
    setBusy(true);
    try {
      const store = useAppStore.getState();
      if (editing) {
        const connection =
          replaceKubeconfig && selection
            ? await ipc.clusterReimportKubeconfig(editing.id, selection.input)
            : editing;
        if (connection !== editing) {
          setEditing(connection);
          setReplaceKubeconfig(false);
          setSelection(null);
          setImported(true);
          const latest = useAppStore.getState();
          latest.setClusters(latest.clusters.map((c) => (c.id === connection.id ? connection : c)));
        }
        const saved = await saveCluster({
          ...connection,
          name,
          tags: fields.tags,
          environment: fields.environment,
          color: fields.color,
          default_namespace: fields.default_namespace.trim() || null,
          accessible_namespaces: splitList(fields.accessible_namespaces),
          read_only: fields.read_only,
          notes: fields.notes,
          prometheus: metrics.config,
          prometheus_access: secured.access,
          loki: logs.config,
          cost: costing.config,
          proxy_url: proxy.trim() || null,
        });
        store.assignClusterToSection(saved.id, fields.sectionId);
        store.pushToast('success', i18n.t('Saved {name}', { name: saved.name }));
      } else {
        const input: ClusterInput = {
          name,
          ...selection!.input,
          tags: fields.tags,
          environment: fields.environment,
          color: fields.color,
          default_namespace: fields.default_namespace.trim() || null,
          accessible_namespaces: splitList(fields.accessible_namespaces),
          read_only: fields.read_only,
          notes: fields.notes,
          proxy_url: proxy.trim() || null,
          prometheus: metrics.config,
          prometheus_access: secured.access,
          loki: logs.config,
          cost: costing.config,
        };
        const [added] = await ipc.clusterAdd([input]);
        if (added) {
          store.setClusters([...store.clusters.filter((c) => c.id !== added.id), added]);
          if (fields.sectionId) store.assignClusterToSection(added.id, fields.sectionId);
          store.pushToast('success', i18n.t('Added {name}', { name: added.name }));
        }
      }
      close();
    } catch (e) {
      setError(kubeconfigErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={editing ? i18n.t('Edit cluster') : i18n.t('Add cluster')}
      subtitle={editing ? `${editing.context} · ${editing.kubeconfig_path}` : undefined}
      onClose={close}
      size="lg"
      footer={
        <>
          {error && (
            <p
              className="text-status-error mr-auto max-w-[60%] truncate text-[11.5px]"
              title={error}
            >
              {error}
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={close}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || ((!editing || replaceKubeconfig) && !selection)}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? i18n.t('Save') : i18n.t('Add cluster')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {imported && (
          <p role="status" className="text-fg-muted text-[12px]">
            {i18n.t(
              'The kubeconfig copy was updated. Save again to finish updating the cluster settings.',
            )}
          </p>
        )}
        {editing && (
          <Switch
            checked={replaceKubeconfig}
            onChange={(enabled) => {
              setReplaceKubeconfig(enabled);
              setSelection(null);
              setError(null);
            }}
            disabled={busy}
            label={i18n.t('Repair or replace kubeconfig')}
            description={i18n.t(
              'Choose another context or import a new kubeconfig while keeping this cluster’s name, settings and tabs. The current connection will be disconnected.',
            )}
          />
        )}
        {(!editing || replaceKubeconfig) && (
          <KubeconfigFields
            editing={editing}
            initialPath={state.mode === 'add' ? state.kubeconfigPath : undefined}
            namespace={fields.default_namespace}
            disabled={busy}
            onChange={onKubeconfigChange}
          />
        )}

        <ClusterFields value={fields} onChange={setFields} />

        <div className="border-border/60 space-y-3 border-t pt-4">
          <ProxyField value={proxy} onChange={setProxy} clusterId={clusterId} />
          <Switch
            checked={fields.read_only}
            onChange={(read_only) => setFields((f) => ({ ...f, read_only }))}
            label={i18n.t('Read-only')}
            description={i18n.t(
              'Block every change (delete, scale, edit, drain, Helm) for this cluster. Logs and shells still work.',
            )}
          />
        </div>

        <div className="border-border/60 border-t pt-4">
          <PrometheusFields
            clusterId={clusterId}
            value={prometheus}
            onChange={setPrometheus}
            access={access}
            onAccessChange={setAccess}
          />
        </div>
        <div className="border-border/60 border-t pt-4">
          <LokiFields clusterId={clusterId} value={loki} onChange={setLoki} />
          <CostFields clusterId={clusterId} value={cost} onChange={setCost} />
        </div>
      </div>
    </Dialog>
  );
}
