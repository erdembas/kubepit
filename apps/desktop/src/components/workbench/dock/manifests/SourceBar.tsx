import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Files,
  FolderGit2,
  FolderOpen,
  History,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import type {
  ManifestHelmOptions,
  ManifestRecent,
  ManifestRender,
  ManifestSource,
  ManifestSourceKind,
} from '@/types';
import { BarLabel, EditorBar } from '../editor/EditorChrome';
import { baseName, kindLabel } from './labels';
import { pickManifestFiles, pickManifestFolder, pickValuesFiles } from './pickers';

const KINDS: ManifestSourceKind[] = ['auto', 'plain', 'kustomize', 'helm'];

export function sourceLabel(source: ManifestSource): string {
  const first = source.paths[0] ?? '';
  return source.paths.length > 1
    ? i18n.t('{name} and {count} more', { name: baseName(first), count: source.paths.length - 1 })
    : baseName(first);
}

/** Toolbar of the Manifests tab: what is open, how it renders, reload / watch. */
export function SourceBar({
  source,
  render,
  loading,
  recent,
  watch,
  problemsOpen,
  onOpen,
  onReload,
  onWatch,
  onToggleProblems,
}: {
  source: ManifestSource | null;
  render: ManifestRender | null;
  loading: boolean;
  recent: ManifestRecent[];
  watch: boolean;
  problemsOpen: boolean;
  onOpen: (source: ManifestSource) => void;
  onReload: () => void;
  onWatch: (watch: boolean) => void;
  onToggleProblems: () => void;
}) {
  i18n.useLocale();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const root = render?.root;

  const openFolder = async () => {
    const path = await pickManifestFolder(root);
    if (path) onOpen({ paths: [path], kind: 'auto', helm: null });
  };
  const openFiles = async () => {
    const paths = await pickManifestFiles(root);
    if (paths) onOpen({ paths, kind: 'plain', helm: null });
  };
  const problems = render?.problems.length ?? 0;
  const nested = render?.nested.length ?? 0;

  return (
    <EditorBar>
      <FolderGit2 className="text-accent h-3.5 w-3.5 shrink-0" />
      <Button
        size="xs"
        variant="ghost"
        leftIcon={<FolderOpen className="h-3 w-3" />}
        onClick={() => void openFolder()}
        title={i18n.t('Open a folder: plain manifests, a Kustomize directory or a Helm chart')}
      >
        {i18n.t('Folder')}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        leftIcon={<Files className="h-3 w-3" />}
        onClick={() => void openFiles()}
        title={i18n.t('Open one or more YAML / JSON files')}
      >
        {i18n.t('Files')}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        leftIcon={<History className="h-3 w-3" />}
        disabled={recent.length === 0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        {i18n.t('Recent')}
      </Button>
      {source && (
        <>
          <span aria-hidden className="bg-border/70 mx-1 h-4 w-px shrink-0" />
          <span
            className="text-fg min-w-0 truncate font-mono text-[11.5px]"
            title={source.paths.join('\n')}
          >
            {root ?? sourceLabel(source)}
          </span>
          <Select
            value={source.kind}
            onChange={(kind) => onOpen({ ...source, kind })}
            options={KINDS.map((k) => ({
              value: k,
              label:
                k === 'auto' && render
                  ? i18n.t('Detect ({kind})', { kind: kindLabel(render.kind) })
                  : kindLabel(k),
            }))}
            ariaLabel={i18n.t('Render as')}
            disabled={source.paths.length > 1}
            className="h-6.5 min-w-32 shrink-0"
          />
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {render && (
          <span className="text-fg-dim flex items-center gap-1.5 text-[11px] tabular-nums">
            <span>{i18n.plural('{count} object', '{count} objects', render.documents.length)}</span>
            {render.files > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{i18n.plural('{count} file', '{count} files', render.files)}</span>
              </>
            )}
          </span>
        )}
        {(problems > 0 || nested > 0) && (
          <button
            type="button"
            onClick={onToggleProblems}
            aria-pressed={problemsOpen}
            title={i18n.t('Skipped files and nested sources')}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
              problemsOpen ? 'bg-fg/8 text-fg' : 'text-fg-dim hover:text-fg',
            )}
          >
            <AlertTriangle
              className={cn('h-3 w-3', problems > 0 ? 'text-status-starting' : 'text-fg-dim')}
            />
            <span className="tabular-nums">{problems + nested}</span>
          </button>
        )}
        {source && (
          <>
            <Switch
              checked={watch}
              onChange={onWatch}
              label={<span className="text-fg-muted text-[11px]">{i18n.t('Watch')}</span>}
              className="gap-1.5"
            />
            <IconButton
              size="xs"
              label={i18n.t('Reload from disk')}
              icon={<RefreshCw className={loading ? 'animate-spin' : undefined} />}
              disabled={loading}
              onClick={onReload}
            />
          </>
        )}
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={recent.map((r) => ({
            id: r.source.paths.join('|'),
            label: sourceLabel(r.source),
            hint: r.source.kind === 'auto' ? undefined : kindLabel(r.source.kind),
            title: r.source.paths.join('\n'),
            icon: <FolderGit2 size={12} />,
            onClick: () => onOpen(r.source),
          }))}
        />
      )}
    </EditorBar>
  );
}

/** Release, namespace and values files of a Helm chart; applied on Enter / blur. */
export function HelmOptionsBar({
  chartDir,
  options,
  onChange,
}: {
  chartDir: string;
  options: ManifestHelmOptions | null;
  onChange: (options: ManifestHelmOptions) => void;
}) {
  i18n.useLocale();
  const current: ManifestHelmOptions = options ?? {
    release_name: '',
    namespace: null,
    values_files: [],
  };
  const [release, setRelease] = useState(current.release_name);
  const [namespace, setNamespace] = useState(current.namespace ?? '');
  useEffect(() => {
    setRelease(current.release_name);
    setNamespace(current.namespace ?? '');
  }, [current.release_name, current.namespace]);

  const commit = (patch: Partial<ManifestHelmOptions>) => {
    const next = {
      ...current,
      release_name: release.trim(),
      namespace: namespace.trim() || null,
      ...patch,
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) onChange(next);
  };
  const input =
    'border-border bg-surface-raised text-fg placeholder:text-fg-dim focus:border-accent h-6 rounded-app-sm border px-2 font-mono text-[11.5px] outline-none';
  const addValues = async () => {
    const files = await pickValuesFiles(chartDir);
    if (!files) return;
    const rel = files.map((f) => (f.startsWith(`${chartDir}/`) ? f.slice(chartDir.length + 1) : f));
    commit({ values_files: [...new Set([...current.values_files, ...rel])] });
  };

  return (
    <div className="border-border/60 bg-surface flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b px-2">
      <BarLabel>{i18n.t('Release')}</BarLabel>
      <input
        value={release}
        onChange={(e) => setRelease(e.target.value)}
        onBlur={() => commit({})}
        onKeyDown={(e) => e.key === 'Enter' && commit({})}
        placeholder={baseName(chartDir).toLowerCase()}
        aria-label={i18n.t('Release name')}
        spellCheck={false}
        className={cn(input, 'w-36')}
      />
      <BarLabel>{i18n.t('Namespace')}</BarLabel>
      <input
        value={namespace}
        onChange={(e) => setNamespace(e.target.value)}
        onBlur={() => commit({})}
        onKeyDown={(e) => e.key === 'Enter' && commit({})}
        placeholder="default"
        aria-label={i18n.t('Release namespace')}
        spellCheck={false}
        className={cn(input, 'w-32')}
      />
      <BarLabel>{i18n.t('Values')}</BarLabel>
      {current.values_files.map((file) => (
        <span
          key={file}
          className="border-border/70 bg-surface/60 text-fg flex h-6 shrink-0 items-center gap-1 rounded-md border pr-0.5 pl-1.5 font-mono text-[11px]"
          title={file}
        >
          {baseName(file)}
          <button
            type="button"
            onClick={() => commit({ values_files: current.values_files.filter((f) => f !== file) })}
            aria-label={i18n.t('Remove {file}', { file })}
            className="text-fg-dim hover:text-fg hover:bg-fg/8 flex h-4.5 w-4.5 items-center justify-center rounded"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <Button
        size="xs"
        variant="ghost"
        leftIcon={<Plus className="h-3 w-3" />}
        onClick={() => void addValues()}
      >
        {i18n.t('Values file')}
      </Button>
      {current.values_files.length === 0 && (
        <span className="text-fg-dim text-[11px] whitespace-nowrap">
          {i18n.t("The chart's values.yaml is used")}
        </span>
      )}
    </div>
  );
}
