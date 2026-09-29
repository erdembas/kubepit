import * as i18n from '@/i18n';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, FileText, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { TagInput } from '@/components/cluster-editor/ClusterFields';
import { Field } from '@/components/cluster-editor/Field';
import {
  ENVIRONMENTS,
  allTags,
  environmentMeta,
  guessEnvironment,
  prettyContextName,
} from '@/lib/clusterMeta';
import { sourcePathOf, kubeconfigErrorMessage } from '@/lib/kubeconfigImport';
import { cn } from '@/lib/cn';
import { ipc, isTauri } from '@/lib/ipc';
import { sectionColor } from '@/lib/sectionColors';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import type { ClusterEnvironment, ClusterInput, KubeconfigSource } from '@/types';

const key = (path: string, context: string) => `${path}\u0000${context}`;

/**
 * Bulk import: scans the usual kubeconfig locations, lists every context
 * and lets the user pick many at once, with a target section, shared tags
 * and a per-context environment guess.
 */
export function DiscoverDialog() {
  i18n.useLocale();
  const close = () => useAppStore.getState().setImportDialogOpen(false);
  const clusters = useAppStore((s) => s.clusters);
  const sections = useAppStore((s) => s.sections);
  const [sources, setSources] = useState<KubeconfigSource[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [envs, setEnvs] = useState<Record<string, ClusterEnvironment | null>>({});
  const [sectionId, setSectionId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = useMemo(
    () => new Set(clusters.map((c) => key(sourcePathOf(c), c.context))),
    [clusters],
  );

  const scan = () => {
    setSources(null);
    setError(null);
    void ipc
      .kubeconfigDiscover()
      .then(setSources)
      .catch((e) => {
        setSources([]);
        setError(kubeconfigErrorMessage(e));
      });
  };
  useEffect(scan, []);

  // Connectivity: contexts announced by the kubeconfig watcher start selected.
  useEffect(() => {
    if (!sources) return;
    const preselect = useConnectivityStore.getState().discoverPreselect;
    if (!preselect?.length) return;
    useConnectivityStore.getState().setDiscoverPreselect(null);
    const found = preselect.filter(
      (c) =>
        !existing.has(key(c.path, c.context)) &&
        sources.some((s) => s.path === c.path && s.contexts.some((x) => x.name === c.context)),
    );
    setSelected((prev) => new Set([...prev, ...found.map((c) => key(c.path, c.context))]));
    setEnvs((prev) => {
      const next = { ...prev };
      for (const c of found) next[key(c.path, c.context)] ??= guessEnvironment(c.context);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const addFile = async () => {
    if (!isTauri) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, directory: false });
      if (typeof picked !== 'string') return;
      const parsed = await ipc.kubeconfigParseFile(picked);
      setSources((prev) => [parsed, ...(prev ?? []).filter((s) => s.path !== parsed.path)]);
      setError(parsed.error ? kubeconfigErrorMessage(parsed.error) : null);
    } catch (cause) {
      setError(kubeconfigErrorMessage(cause));
    }
  };

  const toggle = (path: string, context: string) => {
    const k = key(path, context);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setEnvs((prev) => (k in prev ? prev : { ...prev, [k]: guessEnvironment(context) }));
  };

  const toggleSource = (source: KubeconfigSource) => {
    const keys = source.contexts
      .map((c) => key(source.path, c.name))
      .filter((k) => !existing.has(k));
    const allOn = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
    setEnvs((prev) => {
      const next = { ...prev };
      for (const c of source.contexts) {
        const k = key(source.path, c.name);
        if (!(k in next)) next[k] = guessEnvironment(c.name);
      }
      return next;
    });
  };

  const submit = async () => {
    if (!sources || !selected.size) return;
    setBusy(true);
    setError(null);
    try {
      const inputs: ClusterInput[] = [];
      for (const source of sources) {
        for (const c of source.contexts) {
          const k = key(source.path, c.name);
          if (!selected.has(k)) continue;
          inputs.push({
            name: prettyContextName(c.name),
            context: c.name,
            kubeconfig_path: source.path,
            kubeconfig_text: null,
            tags,
            environment: envs[k] ?? null,
            color: null,
            default_namespace: c.namespace,
            accessible_namespaces: [],
            read_only: false,
            notes: '',
          });
        }
      }
      const added = await ipc.clusterAdd(inputs);
      const store = useAppStore.getState();
      const ids = new Set(added.map((c) => c.id));
      store.setClusters([...store.clusters.filter((c) => !ids.has(c.id)), ...added]);
      if (sectionId) for (const c of added) store.assignClusterToSection(c.id, sectionId);
      store.pushToast(
        'success',
        i18n.plural('Imported {count} cluster', 'Imported {count} clusters', added.length),
      );
      close();
    } catch (e) {
      setError(kubeconfigErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={i18n.t('Discover kubeconfig contexts')}
      subtitle={i18n.t('$KUBECONFIG, ~/.kube and your sync folders')}
      onClose={close}
      size="lg"
      footer={
        <>
          {error && (
            <p
              className="text-status-error mr-auto max-w-[55%] truncate text-[11.5px]"
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
            disabled={!selected.size || busy}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {i18n.plural('Import {count} cluster', 'Import {count} clusters', selected.size)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={scan}
          >
            {i18n.t('Rescan')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
            onClick={() => void addFile()}
            disabled={!isTauri}
          >
            {i18n.t('Add file…')}
          </Button>
          <span className="text-fg-dim ml-auto text-[11px]">
            {i18n.t(
              'Selected connections are imported as private copies. Your source files are not changed.',
            )}
          </span>
        </div>

        {sources == null ? (
          <div className="text-fg-dim flex items-center justify-center gap-2 py-10 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Scanning for kubeconfig files…')}
          </div>
        ) : sources.length === 0 ? (
          <p className="text-fg-dim py-10 text-center text-[12px]">
            {i18n.t('No kubeconfig files found. Add a file or paste one from "Add cluster".')}
          </p>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <section
                key={source.path}
                className="border-border/70 overflow-hidden rounded-lg border"
              >
                <header className="bg-surface-raised/60 border-border/60 flex items-center gap-2 border-b px-3 py-2">
                  <FileText className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                  <span className="text-fg min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {source.path}
                  </span>
                  {source.contexts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleSource(source)}
                      className="text-fg-muted hover:text-fg text-[11px]"
                    >
                      {i18n.t('Select all')}
                    </button>
                  )}
                </header>
                {source.error ? (
                  <p className="text-status-error flex items-center gap-2 px-3 py-2.5 text-[11.5px]">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {kubeconfigErrorMessage(source.error)}
                  </p>
                ) : source.contexts.length === 0 ? (
                  <div className="space-y-2 px-3 py-3">
                    <p className="text-fg-dim text-[12px]">
                      {i18n.t(
                        'This kubeconfig has no contexts. Choose a cluster and user to create a connection.',
                      )}
                    </p>
                    <Button
                      size="sm"
                      disabled={source.clusters.length === 0}
                      onClick={() => {
                        useAppStore
                          .getState()
                          .openClusterEditor({ mode: 'add', kubeconfigPath: source.path });
                        close();
                      }}
                    >
                      {i18n.t('Create a connection…')}
                    </Button>
                  </div>
                ) : (
                  <ul className="divide-border/50 divide-y">
                    {source.contexts.map((c) => {
                      const k = key(source.path, c.name);
                      const added = existing.has(k);
                      const on = selected.has(k);
                      const env = environmentMeta(envs[k] ?? guessEnvironment(c.name));
                      return (
                        <li
                          key={c.name}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2 transition-colors',
                            on && 'bg-accent/5',
                            !added && 'hover:bg-fg/3 cursor-pointer',
                          )}
                          onClick={() => !added && toggle(source.path, c.name)}
                        >
                          <span
                            className={cn(
                              'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition',
                              added
                                ? 'border-border bg-fg/10 text-fg-dim'
                                : on
                                  ? 'bg-accent border-accent text-accent-fg'
                                  : 'border-border-strong',
                            )}
                          >
                            {(on || added) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-fg truncate text-[12.5px] font-medium">{c.name}</p>
                            <p className="text-fg-dim truncate font-mono text-[10.5px]">
                              {c.server ?? c.cluster}
                              {c.namespace ? ` · ns/${c.namespace}` : ''}
                              {` · ${c.user}`}
                            </p>
                          </div>
                          {added ? (
                            <span className="text-fg-dim bg-fg/5 rounded px-1.5 py-0.5 text-[10px]">
                              {i18n.t('Already added')}
                            </span>
                          ) : (
                            <div onClick={(e) => e.stopPropagation()}>
                              <Select
                                value={envs[k] ?? guessEnvironment(c.name) ?? ''}
                                onChange={(v) =>
                                  setEnvs((prev) => ({
                                    ...prev,
                                    [k]: (v || null) as ClusterEnvironment | null,
                                  }))
                                }
                                options={[
                                  { value: '', label: i18n.t('No environment') },
                                  ...ENVIRONMENTS.map((e) => ({ value: e.key, label: e.label })),
                                ]}
                                leading={
                                  env ? (
                                    <span className={cn('h-1.5 w-1.5 rounded-full', env.dot)} />
                                  ) : undefined
                                }
                                className="w-36"
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}

        {selected.size > 0 && (
          <div className="border-border/60 grid grid-cols-2 gap-4 border-t pt-4">
            <Field label={i18n.t('Add to section')}>
              <Select
                size="md"
                value={sectionId}
                onChange={setSectionId}
                options={[
                  { value: '', label: i18n.t('Unassigned') },
                  ...sections.map((s) => ({
                    value: s.id,
                    label: s.name,
                    color: sectionColor(s.color).solid,
                  })),
                ]}
              />
            </Field>
            <Field label={i18n.t('Tags for all')}>
              <TagInput value={tags} suggestions={allTags(clusters)} onChange={setTags} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
