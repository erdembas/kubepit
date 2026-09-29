import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileCode2, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { ipc, isTauri } from '@/lib/ipc';
import {
  initialKubeconfigChoice,
  kubeconfigChoiceProblem,
  kubeconfigErrorMessage,
  nextContextName,
  sourcePathOf,
  type KubeconfigChoice,
} from '@/lib/kubeconfigImport';
import type { ClusterDef, KubeconfigImportInput, KubeconfigSource } from '@/types';
import { Field } from './Field';

type SourceMode = 'current' | 'file' | 'paste';
const EMPTY_CHOICE: KubeconfigChoice = { create: false, context: '', cluster: '', user: null };
export interface KubeconfigSelection {
  input: KubeconfigImportInput;
  namespace: string | null;
}

export function KubeconfigFields({
  editing,
  initialPath,
  namespace,
  disabled = false,
  onChange,
}: {
  editing: ClusterDef | null;
  initialPath?: string;
  namespace: string;
  disabled?: boolean;
  onChange: (selection: KubeconfigSelection | null) => void;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const keychain = useAppStore((s) => s.settings?.keychain_kubeconfigs ?? false);
  const [mode, setMode] = useState<SourceMode>(editing ? 'current' : 'file');
  const [sources, setSources] = useState<KubeconfigSource[] | null>(null);
  const [source, setSource] = useState<KubeconfigSource | null>(null);
  const [choice, setChoice] = useState<KubeconfigChoice>(EMPTY_CHOICE);
  const [pasted, setPasted] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const touched = useRef(false);
  const accept = useCallback(
    (next: KubeconfigSource) => {
      setSource(next);
      setChoice(initialKubeconfigChoice(next, editing?.context));
      setError(next.error ? kubeconfigErrorMessage(next.error) : null);
    },
    [editing?.context],
  );
  const parse = useCallback(
    async (load: () => Promise<KubeconfigSource>) => {
      const request = ++generation.current;
      setSource(null);
      setChoice(EMPTY_CHOICE);
      setError(null);
      setLoading(true);
      try {
        const next = await load();
        if (request === generation.current) accept(next);
      } catch (cause) {
        if (request === generation.current) setError(kubeconfigErrorMessage(cause));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [accept],
  );
  useEffect(() => {
    let active = true;
    void ipc.kubeconfigDiscover().then(
      (list) => {
        if (!active) return;
        const usable = list.filter((item) => !item.error && item.clusters.length > 0);
        setSources(usable);
        if (!editing && !initialPath && !touched.current && usable[0]) accept(usable[0]);
      },
      () => {
        if (active) setSources([]);
      },
    );
    if (editing) void parse(() => ipc.clusterKubeconfigSource(editing.id));
    else if (initialPath) void parse(() => ipc.kubeconfigParseFile(initialPath));
    return () => {
      active = false;
      ++generation.current;
    };
  }, [editing?.id, initialPath, accept, parse]);
  const fileSources =
    source?.path && !sources?.some((item) => item.path === source.path)
      ? [source, ...(sources ?? [])]
      : (sources ?? []);
  const duplicate =
    mode === 'file' && !editing
      ? clusters.find(
          (cluster) =>
            source && sourcePathOf(cluster) === source.path && cluster.context === choice.context,
        )
      : null;
  const problem = loading ? null : kubeconfigChoiceProblem(source, choice);
  useEffect(() => {
    if (!source || loading || problem) {
      onChange(null);
      return;
    }
    const existing = source.contexts.find((c) => c.name === choice.context);
    onChange({
      input: {
        context: choice.create ? choice.context.trim() : choice.context,
        kubeconfig_path: mode === 'file' ? source.path : null,
        kubeconfig_text: mode === 'paste' ? pasted : null,
        create_context: choice.create
          ? {
              cluster: choice.cluster,
              user: choice.user || null,
              namespace: namespace.trim() || null,
            }
          : null,
      },
      namespace: choice.create ? namespace.trim() || null : (existing?.namespace ?? null),
    });
  }, [source, choice, mode, pasted, namespace, loading, problem, onChange]);
  const changeMode = (next: SourceMode) => {
    touched.current = true;
    ++generation.current;
    setMode(next);
    setSource(null);
    setChoice(EMPTY_CHOICE);
    setError(null);
    setLoading(false);
    if (next === 'current' && editing) void parse(() => ipc.clusterKubeconfigSource(editing.id));
    else if (next === 'paste' && pasted.trim()) void parse(() => ipc.kubeconfigParseText(pasted));
    else if (next === 'file' && sources?.[0]) accept(sources[0]);
  };
  const browse = async () => {
    if (!isTauri) return;
    touched.current = true;
    const dialogGeneration = generation.current;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, directory: false });
      if (typeof picked !== 'string' || dialogGeneration !== generation.current) return;
      await parse(async () => {
        const next = await ipc.kubeconfigParseFile(picked);
        setSources((items) => [next, ...(items ?? []).filter((item) => item.path !== next.path)]);
        return next;
      });
    } catch (cause) {
      setError(kubeconfigErrorMessage(cause));
    }
  };
  const modes = [
    ...(editing
      ? [{ id: 'current' as const, label: i18n.t('Current kubeconfig'), icon: FileCode2 }]
      : []),
    { id: 'file' as const, label: i18n.t('From kubeconfig file'), icon: FolderOpen },
    { id: 'paste' as const, label: i18n.t('Paste kubeconfig'), icon: FileCode2 },
  ];
  return (
    <section className="space-y-3">
      <div className="bg-fg/4 flex flex-wrap gap-0.5 rounded-lg p-0.5">
        {modes.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            disabled={disabled}
            aria-pressed={mode === id}
            onClick={() => changeMode(id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50',
              mode === id
                ? 'bg-surface-raised text-fg font-medium shadow-sm'
                : 'text-fg-dim hover:text-fg',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      {mode === 'file' && (
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label={i18n.t('Kubeconfig file')}>
            <Select
              size="md"
              ariaLabel={i18n.t('Kubeconfig file')}
              value={source?.path ?? ''}
              disabled={disabled}
              placeholder={
                sources === null
                  ? i18n.t('Looking for kubeconfig files…')
                  : i18n.t('No kubeconfig found — browse for a file')
              }
              onChange={(path) => {
                touched.current = true;
                ++generation.current;
                setLoading(false);
                const next = sources?.find((item) => item.path === path);
                if (next) accept(next);
              }}
              options={fileSources.map((item) => ({ value: item.path, label: item.path }))}
            />
          </Field>
          <Button
            size="md"
            disabled={disabled || !isTauri}
            onClick={() => void browse()}
            leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
          >
            {i18n.t('Browse…')}
          </Button>
        </div>
      )}
      {mode === 'current' && editing && (
        <p className="text-fg-dim font-mono text-[11px] break-all">{editing.kubeconfig_path}</p>
      )}
      {mode === 'paste' && (
        <Field label={i18n.t('Kubeconfig YAML')}>
          <textarea
            aria-label={i18n.t('Kubeconfig YAML')}
            value={pasted}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value;
              touched.current = true;
              setPasted(text);
              if (text.trim()) void parse(() => ipc.kubeconfigParseText(text));
              else {
                ++generation.current;
                setSource(null);
                setChoice(EMPTY_CHOICE);
                setError(null);
                setLoading(false);
              }
            }}
            spellCheck={false}
            placeholder={'apiVersion: v1\nkind: Config\nclusters: …'}
            className="border-border bg-surface-raised text-fg focus:border-accent rounded-app-sm h-36 w-full resize-y border px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none"
          />
        </Field>
      )}
      <p className="text-fg-dim text-[11px]">
        {i18n.t(
          'Kubepit imports a private copy of the selected connection. The source file is not changed or needed after import.',
        )}
      </p>
      <p className="text-fg-dim text-[11px]">
        {keychain
          ? i18n.t('Imported kubeconfigs are kept in your OS credential store.')
          : i18n.t('Imported kubeconfigs are stored locally with owner-only permissions.')}
      </p>
      {loading && (
        <p role="status" className="text-fg-dim flex items-center gap-2 text-[12px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t('Reading kubeconfig…')}
        </p>
      )}
      {source && !source.error && (
        <>
          {source.contexts.length === 0 ? (
            <p className="text-fg-muted text-[12px]">
              {i18n.t(
                'This kubeconfig has no contexts. Choose a cluster and user to create a connection.',
              )}
            </p>
          ) : (
            <Field
              label={i18n.t('Context')}
              hint={
                duplicate
                  ? i18n.t('This context is already added as "{name}".', { name: duplicate.name })
                  : undefined
              }
            >
              <Select
                size="md"
                ariaLabel={i18n.t('Context')}
                disabled={disabled}
                value={choice.create ? 'create' : `context:${choice.context}`}
                onChange={(value) =>
                  setChoice((c) =>
                    value === 'create'
                      ? {
                          ...c,
                          create: true,
                          context: c.cluster ? nextContextName(source, c.cluster) : '',
                        }
                      : { ...c, create: false, context: value.slice('context:'.length) },
                  )
                }
                options={[
                  ...source.contexts.map((c) => ({
                    value: `context:${c.name}`,
                    label: c.name,
                    description: [c.server, c.namespace].filter(Boolean).join(' · '),
                  })),
                  { value: 'create', label: i18n.t('Create a new context…') },
                ]}
              />
            </Field>
          )}
          {choice.create && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={i18n.t('Cluster in kubeconfig')}>
                <Select
                  size="md"
                  ariaLabel={i18n.t('Cluster in kubeconfig')}
                  disabled={disabled}
                  value={choice.cluster}
                  onChange={(cluster) =>
                    setChoice((c) => ({
                      ...c,
                      cluster,
                      context:
                        !c.context || c.context === c.cluster
                          ? nextContextName(source, cluster)
                          : c.context,
                    }))
                  }
                  options={source.clusters.map((c) => ({
                    value: c.name,
                    label: c.name,
                    description: c.server ?? undefined,
                  }))}
                />
              </Field>
              <Field label={i18n.t('User in kubeconfig')}>
                <Select
                  size="md"
                  ariaLabel={i18n.t('User in kubeconfig')}
                  disabled={disabled}
                  value={choice.user === null ? 'choose' : `user:${choice.user}`}
                  onChange={(user) =>
                    setChoice((c) => ({ ...c, user: user.slice('user:'.length) }))
                  }
                  options={[
                    { value: 'user:', label: i18n.t('Anonymous (no user)') },
                    ...source.users.map((user) => ({ value: `user:${user}`, label: user })),
                  ]}
                />
              </Field>
              <Field label={i18n.t('New context name')}>
                <Input
                  aria-label={i18n.t('New context name')}
                  disabled={disabled}
                  value={choice.context}
                  onChange={(event) => setChoice((c) => ({ ...c, context: event.target.value }))}
                />
              </Field>
            </div>
          )}
        </>
      )}
      {(error || (source && problem)) && (
        <p role="alert" className="text-status-error text-[12px] whitespace-pre-wrap">
          {error || problem}
        </p>
      )}
    </section>
  );
}
