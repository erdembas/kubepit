import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { FileCode2, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { saveCluster } from '@/lib/clusterActions';
import { guessEnvironment, prettyContextName } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore, type ClusterEditorState } from '@/store/useAppStore';
import type { ClusterDef, ClusterInput, KubeconfigSource } from '@/types';
import { ClusterFields, type ClusterFieldValues } from './ClusterFields';
import { Field } from './Field';
import { PrometheusFields, prometheusConfig, prometheusDraft } from './PrometheusFields';

type SourceMode = 'file' | 'paste';

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
  const clusters = useAppStore((s) => s.clusters);
  const editing = state.mode === 'edit' ? state.cluster : null;
  const [fields, setFields] = useState<ClusterFieldValues>(() =>
    editing ? fieldsFrom(editing, clusterSection[editing.id] ?? null) : emptyFields(),
  );
  const [mode, setMode] = useState<SourceMode>('file');
  const [sources, setSources] = useState<KubeconfigSource[] | null>(null);
  const [source, setSource] = useState<KubeconfigSource | null>(null);
  const [context, setContext] = useState('');
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prometheus, setPrometheus] = useState(() => prometheusDraft(editing?.prometheus));

  // Offer discovered kubeconfig files as quick picks in add mode.
  useEffect(() => {
    if (editing) return;
    void ipc
      .kubeconfigDiscover()
      .then((list) => {
        const usable = list.filter((s) => s.contexts.length > 0);
        setSources(usable);
        const first = usable[0];
        if (first) {
          setSource(first);
          pickContext(first, first.current_context ?? first.contexts[0]?.name ?? '');
        }
      })
      .catch(() => setSources([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const pickContext = (src: KubeconfigSource | null, name: string) => {
    setContext(name);
    const ctx = src?.contexts.find((c) => c.name === name);
    setFields((f) => ({
      ...f,
      name: f.name && f.name !== prettyContextName(context) ? f.name : prettyContextName(name),
      environment: f.environment ?? guessEnvironment(name),
      default_namespace: f.default_namespace || ctx?.namespace || '',
    }));
  };

  const browse = async () => {
    if (!isTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked !== 'string') return;
    const parsed = await ipc.kubeconfigParseFile(picked);
    setSources((prev) => [parsed, ...(prev ?? []).filter((s) => s.path !== parsed.path)]);
    setSource(parsed);
    if (parsed.error) setError(parsed.error);
    else pickContext(parsed, parsed.current_context ?? parsed.contexts[0]?.name ?? '');
  };

  const parsePasted = async (text: string) => {
    setPasted(text);
    if (!text.trim()) {
      setSource(null);
      return;
    }
    const parsed = await ipc.kubeconfigParseText(text);
    setSource(parsed);
    setError(parsed.error);
    if (!parsed.error)
      pickContext(parsed, parsed.current_context ?? parsed.contexts[0]?.name ?? '');
  };

  const submit = async () => {
    setError(null);
    const name = fields.name.trim();
    if (!name) return setError(i18n.t('Give the cluster a name.'));
    setBusy(true);
    try {
      const store = useAppStore.getState();
      if (editing) {
        const metrics = prometheusConfig(prometheus);
        if ('error' in metrics) return setError(metrics.error);
        const saved = await saveCluster({
          ...editing,
          name,
          tags: fields.tags,
          environment: fields.environment,
          color: fields.color,
          default_namespace: fields.default_namespace.trim() || null,
          accessible_namespaces: splitList(fields.accessible_namespaces),
          read_only: fields.read_only,
          notes: fields.notes,
          prometheus: metrics.config,
        });
        store.assignClusterToSection(saved.id, fields.sectionId);
        store.pushToast('success', i18n.t('Saved {name}', { name: saved.name }));
      } else {
        if (!source || !context) return setError(i18n.t('Choose a kubeconfig context first.'));
        const input: ClusterInput = {
          name,
          context,
          kubeconfig_path: mode === 'file' ? source.path : null,
          kubeconfig_text: mode === 'paste' ? pasted : null,
          tags: fields.tags,
          environment: fields.environment,
          color: fields.color,
          default_namespace: fields.default_namespace.trim() || null,
          accessible_namespaces: splitList(fields.accessible_namespaces),
          read_only: fields.read_only,
          notes: fields.notes,
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
      setError(e instanceof Error ? e.message : String(e));
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
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? i18n.t('Save') : i18n.t('Add cluster')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!editing && (
          <section className="space-y-3">
            <div className="bg-fg/4 inline-flex gap-0.5 rounded-lg p-0.5">
              {(
                [
                  ['file', i18n.t('From kubeconfig file'), FolderOpen],
                  ['paste', i18n.t('Paste kubeconfig'), FileCode2],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setMode(key);
                    setError(null);
                    if (key === 'paste') void parsePasted(pasted);
                    else {
                      const first = sources?.[0] ?? null;
                      setSource(first);
                      if (first)
                        pickContext(first, first.current_context ?? first.contexts[0]?.name ?? '');
                    }
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors',
                    mode === key
                      ? 'bg-surface-raised text-fg font-medium shadow-sm'
                      : 'text-fg-dim hover:text-fg',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {mode === 'file' ? (
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <Field label={i18n.t('Kubeconfig file')}>
                  {sources == null ? (
                    <div className="text-fg-dim flex h-8 items-center gap-2 text-[12px]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {i18n.t('Looking for kubeconfig files…')}
                    </div>
                  ) : (
                    <Select
                      size="md"
                      value={source?.path ?? ''}
                      placeholder={i18n.t('No kubeconfig found — browse for a file')}
                      onChange={(path) => {
                        const next = sources.find((s) => s.path === path) ?? null;
                        setSource(next);
                        if (next)
                          pickContext(next, next.current_context ?? next.contexts[0]?.name ?? '');
                      }}
                      options={sources.map((s) => ({
                        value: s.path,
                        label: s.path,
                        description: i18n.plural(
                          '{count} context',
                          '{count} contexts',
                          s.contexts.length,
                        ),
                      }))}
                    />
                  )}
                </Field>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => void browse()}
                  disabled={!isTauri}
                  leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                >
                  {i18n.t('Browse…')}
                </Button>
              </div>
            ) : (
              <Field label={i18n.t('Kubeconfig YAML')}>
                <textarea
                  value={pasted}
                  onChange={(e) => void parsePasted(e.target.value)}
                  spellCheck={false}
                  placeholder={'apiVersion: v1\nkind: Config\nclusters: …'}
                  className="border-border bg-surface-raised text-fg focus:border-accent rounded-app-sm h-36 w-full resize-y border px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none"
                />
                <p className="text-fg-dim mt-1 text-[11px]">
                  {i18n.t('Stored under ~/.kubepit/kubeconfigs with owner-only permissions.')}
                </p>
              </Field>
            )}

            {source && source.contexts.length > 0 && (
              <Field
                label={i18n.t('Context')}
                hint={(() => {
                  const dup =
                    mode === 'file' &&
                    clusters.find(
                      (c) => c.context === context && c.kubeconfig_path === source.path,
                    );
                  return dup
                    ? i18n.t('This context is already added as "{name}".', { name: dup.name })
                    : undefined;
                })()}
              >
                <Select
                  size="md"
                  value={context}
                  onChange={(name) => pickContext(source, name)}
                  options={source.contexts.map((c) => ({
                    value: c.name,
                    label: c.name,
                    description: [c.server, c.namespace && `ns: ${c.namespace}`]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                />
              </Field>
            )}
          </section>
        )}

        <ClusterFields value={fields} onChange={setFields} />

        <div className="border-border/60 space-y-3 border-t pt-4">
          <Switch
            checked={fields.read_only}
            onChange={(read_only) => setFields((f) => ({ ...f, read_only }))}
            label={i18n.t('Read-only')}
            description={i18n.t(
              'Block every change (delete, scale, edit, drain, Helm) for this cluster. Logs and shells still work.',
            )}
          />
        </div>

        {editing && (
          <div className="border-border/60 border-t pt-4">
            <PrometheusFields clusterId={editing.id} value={prometheus} onChange={setPrometheus} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
