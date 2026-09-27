import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Box,
  Bug,
  Copy,
  Download,
  FolderOpen,
  Inbox,
  Loader2,
  RotateCw,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Select } from '@/components/ui/Select';
import { ipc, isTauri } from '@/lib/ipc';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { formatBytes } from '@/lib/format';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, PodDirListing, PodFsEntry } from '@/types';
import { openPodDebug } from '../../actions/logsDebugActions';
import { useCluster } from '../../data/hooks';
import { TableSkeleton } from '../../table/TableStates';
import { useDragWidth } from '../../useDragWidth';
import { errorText, useNow } from '../../util';
import { copyText, downloadText } from '../shared/platform';
import { pickOpenPath, pickSavePath } from '../shared/saveFile';
import { FilePreview, type PreviewState } from './FilePreview';
import { FileTable } from './FileTable';
import { base64ToBytes, isDirLike, joinPath, parentPath } from './model';
import { PathBar } from './PathBar';

type FilesTab = Extract<DockTab, { kind: 'files' }>;

interface Props {
  clusterId: ClusterId;
  tab: FilesTab;
  active: boolean;
}

type Listing =
  | { state: 'loading'; path: string }
  | { state: 'ready'; data: PodDirListing }
  | { state: 'error'; path: string; message: string };

const PREVIEW_DELAY = 180;

/**
 * Container file browser (`kubectl cp` with a UI): a directory table with a
 * split read-only preview, breadcrumb / typed paths, keyboard navigation,
 * download (files, or folders as .tar) and upload. Everything runs over
 * exec in the selected container; containers without a shell offer a
 * debug container instead.
 */
export const FileBrowser = memo(function FileBrowser({ clusterId, tab, active }: Props) {
  i18n.useLocale();
  const { readOnly } = useCluster(clusterId);
  const updateTab = useDockStore((s) => s.updateTab);
  const pushToast = useAppStore((s) => s.pushToast);
  const now = useNow(30_000, active);

  const [listing, setListing] = useState<Listing>({ state: 'loading', path: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editSignal, setEditSignal] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FileContextMenuEntry[] } | null>(
    null,
  );
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Half the body by default; the table always keeps ~320px.
  const bodyWidth = bodyRef.current?.clientWidth ?? 1000;
  const defaultPreview = Math.round(Math.min(760, Math.max(300, bodyWidth * 0.5)));
  const drag = useDragWidth({
    width: previewWidth ?? defaultPreview,
    setWidth: setPreviewWidth,
    min: 260,
    max: Math.max(260, bodyWidth - 320),
    defaultWidth: defaultPreview,
    edge: 'left',
  });
  const requestRef = useRef(0);
  const previewRequest = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const uploadInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const container = tab.container;
  const cwd = listing.state === 'ready' ? listing.data.path : listing.path;
  const entries = listing.state === 'ready' ? listing.data.entries : [];
  const selectedEntry = entries.find((e) => e.name === selected) ?? null;

  const load = useCallback(
    (path: string, keepSelection: string | null = null, refresh = false) => {
      const request = ++requestRef.current;
      setListing({ state: 'loading', path });
      if (!refresh) {
        // A preview belongs to the folder it was opened in.
        previewRequest.current++;
        clearTimeout(previewTimer.current);
        setPreview(null);
      }
      ipc
        .podFsList(clusterId, tab.namespace, tab.pod, container, path)
        .then((data) => {
          if (request !== requestRef.current) return;
          setListing({ state: 'ready', data });
          setSelected(
            keepSelection && data.entries.some((e) => e.name === keepSelection)
              ? keepSelection
              : null,
          );
        })
        .catch((err: unknown) => {
          if (request !== requestRef.current) return;
          setListing({ state: 'error', path, message: errorText(err) });
        });
    },
    [clusterId, tab.namespace, tab.pod, container],
  );

  // Start in the container's working directory; a container switch starts over.
  useEffect(() => {
    setPreview(null);
    setSelected(null);
    load('');
  }, [load]);

  useEffect(() => () => clearTimeout(previewTimer.current), []);

  const showPreview = useCallback(
    (entry: PodFsEntry, dir: string) => {
      clearTimeout(previewTimer.current);
      if (isDirLike(entry) || entry.kind === 'other') return;
      const request = ++previewRequest.current;
      previewTimer.current = setTimeout(() => {
        setPreview({ state: 'loading', name: entry.name });
        ipc
          .podFsRead(clusterId, tab.namespace, tab.pod, container, joinPath(dir, entry.name))
          .then((content) => {
            if (request === previewRequest.current)
              setPreview({ state: 'ready', name: entry.name, content });
          })
          .catch((err: unknown) => {
            if (request === previewRequest.current)
              setPreview({ state: 'error', name: entry.name, message: errorText(err) });
          });
      }, PREVIEW_DELAY);
    },
    [clusterId, tab.namespace, tab.pod, container],
  );

  // Selecting a file previews it (debounced, so arrowing through a folder stays cheap).
  const select = (name: string) => {
    setSelected(name);
    const entry = entries.find((e) => e.name === name);
    if (entry && !isDirLike(entry)) showPreview(entry, cwd);
  };

  const open = (entry: PodFsEntry) => {
    if (isDirLike(entry)) {
      load(joinPath(cwd, entry.name));
      return;
    }
    setSelected(entry.name);
    showPreview(entry, cwd);
  };

  const goUp = () => {
    if (cwd === '/' || !cwd) return;
    const name = cwd.split('/').filter(Boolean).pop() ?? null;
    load(parentPath(cwd), name);
  };

  const download = async (entry: PodFsEntry | null) => {
    if (!entry) return;
    const remote = joinPath(cwd, entry.name);
    const dir = isDirLike(entry);
    if (!isTauri) {
      // Browser previews have no file system: files go through the preview
      // read and a download; folders need the desktop app.
      if (dir) {
        pushToast('info', i18n.t('Downloading folders needs the desktop app.'));
        return;
      }
      try {
        const content = await ipc.podFsRead(
          clusterId,
          tab.namespace,
          tab.pod,
          container,
          remote,
          1024 * 1024,
        );
        if (content.text !== null) downloadText(entry.name, content.text);
        else if (content.base64) {
          const blob = new Blob([base64ToBytes(content.base64) as BlobPart]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = entry.name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1_000);
        }
      } catch (err) {
        pushToast('error', errorText(err));
      }
      return;
    }
    const target = await pickSavePath(dir ? `${entry.name}.tar` : entry.name);
    if (!target) return;
    setBusy(i18n.t('Downloading {name}…', { name: entry.name }));
    try {
      const result = await ipc.podFsDownload(
        clusterId,
        tab.namespace,
        tab.pod,
        container,
        remote,
        target,
      );
      pushToast(
        'success',
        i18n.t('Saved {name} ({size}) to {path}', {
          name: result.archive ? `${entry.name}.tar` : entry.name,
          size: formatBytes(result.bytes),
          path: result.path,
        }),
      );
    } catch (err) {
      pushToast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (localPath: string, name: string) => {
    const dir = cwd;
    const run = async () => {
      setBusy(i18n.t('Uploading {name}…', { name }));
      try {
        const result = await ipc.podFsUpload(
          clusterId,
          tab.namespace,
          tab.pod,
          container,
          localPath,
          dir,
        );
        pushToast(
          'success',
          i18n.t('Uploaded {name} ({size}) to {path}', {
            name,
            size: formatBytes(result.bytes),
            path: result.path,
          }),
        );
        load(dir, name, true);
      } catch (err) {
        pushToast('error', errorText(err));
      } finally {
        setBusy(null);
      }
    };
    if (entries.some((e) => e.name === name)) {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Replace {name}?', { name }),
        message: i18n.t('{path} already exists in the container. Replace it with your file?', {
          path: joinPath(dir, name),
        }),
        confirmLabel: i18n.t('Replace'),
        tone: 'danger',
        onConfirm: run,
      });
    } else await run();
  };

  const pickUpload = async () => {
    if (readOnly) return;
    if (!isTauri) {
      uploadInput.current?.click();
      return;
    }
    const path = await pickOpenPath();
    if (!path) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    await upload(path, name);
  };

  const openDebug = () => {
    void ipc
      .resourceGet(clusterId, toGvk(BUILTIN.Pod), tab.namespace, tab.pod)
      .then((pod) => openPodDebug(clusterId, pod, container))
      .catch((err: unknown) => pushToast('error', errorText(err)));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.closest('.monaco-editor')
    )
      return;
    const index = entries.findIndex((e) => e.name === selected);
    const move = (to: number) => {
      const entry = entries[Math.max(0, Math.min(entries.length - 1, to))];
      if (!entry) return;
      event.preventDefault();
      select(entry.name);
    };
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      setEditSignal((n) => n + 1);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index < 0 ? entries.length - 1 : index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(entries.length - 1);
        break;
      case 'Enter':
        if (selectedEntry) {
          event.preventDefault();
          open(selectedEntry);
        }
        break;
      case 'Backspace':
        event.preventDefault();
        goUp();
        break;
      case ' ':
        if (selectedEntry && !isDirLike(selectedEntry)) {
          event.preventDefault();
          showPreview(selectedEntry, cwd);
        }
        break;
    }
  };

  const onRowMenu = (entry: PodFsEntry, x: number, y: number) => {
    const path = joinPath(cwd, entry.name);
    setMenu({
      x,
      y,
      items: [
        {
          id: 'open',
          label: isDirLike(entry) ? i18n.t('Open') : i18n.t('Preview'),
          icon: <FolderOpen size={12} />,
          disabled: entry.kind === 'other',
          onClick: () => open(entry),
        },
        {
          id: 'download',
          label: isDirLike(entry) ? i18n.t('Download as .tar…') : i18n.t('Download…'),
          icon: <Download size={12} />,
          disabled: entry.kind === 'other',
          onClick: () => void download(entry),
        },
        { id: 'sep', separator: true },
        {
          id: 'copy-path',
          label: i18n.t('Copy path'),
          icon: <Copy size={12} />,
          onClick: () => void copyText(path),
        },
      ],
    });
  };

  const missingShell = listing.state === 'error' && /has no shell/.test(listing.message);

  return (
    <div
      ref={rootRef}
      className="bg-surface-muted flex h-full w-full min-w-0 flex-col"
      onKeyDown={onKeyDown}
    >
      <div className="border-border/60 bg-surface main-tabbar-scroll flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2">
        {tab.containers.length > 1 && tab.container && (
          <Select
            value={tab.container}
            onChange={(c) => updateTab(clusterId, tab.id, { container: c })}
            options={tab.containers.map((c) => ({ value: c, label: c }))}
            ariaLabel={i18n.t('Container')}
            leading={<Box size={12} />}
            className="h-6.5 max-w-48 shrink-0"
          />
        )}
        <IconButton
          size="xs"
          label={i18n.t('Up one folder (Backspace)')}
          icon={<ArrowUp />}
          disabled={!cwd || cwd === '/'}
          onClick={goUp}
        />
        <IconButton
          size="xs"
          label={i18n.t('Refresh')}
          icon={<RotateCw />}
          onClick={() => load(cwd, selected, true)}
        />
        <PathBar path={cwd || '/'} editSignal={editSignal} onNavigate={(p) => load(p)} />
        {busy && (
          <span className="text-fg-dim flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
            <Loader2 className="h-3 w-3 animate-spin" />
            {busy}
          </span>
        )}
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Download className="h-3 w-3" />}
          disabled={!selectedEntry || selectedEntry.kind === 'other' || !!busy}
          onClick={() => void download(selectedEntry)}
        >
          {i18n.t('Download…')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Upload className="h-3 w-3" />}
          disabled={readOnly || listing.state !== 'ready' || !!busy}
          title={readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined}
          onClick={() => void pickUpload()}
        >
          {i18n.t('Upload…')}
        </Button>
        <input
          ref={uploadInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file.name, file.name);
          }}
        />
      </div>
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div
          className="bg-surface flex min-h-0 min-w-64 flex-1 flex-col outline-none focus-visible:outline-none"
          tabIndex={0}
          aria-label={i18n.t('Files')}
        >
          {listing.state === 'loading' ? (
            <TableSkeleton rows={8} />
          ) : listing.state === 'error' ? (
            <BrowserState
              icon={missingShell ? Bug : AlertTriangle}
              tone={missingShell ? 'warning' : 'error'}
              title={
                missingShell
                  ? i18n.t('No shell in this container')
                  : i18n.t('Could not open folder')
              }
              mono={!missingShell}
              message={
                missingShell
                  ? i18n.t(
                      'Browsing files runs sh in the container. Start a debug container that shares its processes, then browse from there.',
                    )
                  : listing.message
              }
              action={
                <>
                  {missingShell && (
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<Bug className="h-3.5 w-3.5" />}
                      disabled={readOnly}
                      title={
                        readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined
                      }
                      onClick={openDebug}
                    >
                      {i18n.t('Debug…')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<RotateCw className="h-3.5 w-3.5" />}
                    onClick={() => load(listing.path)}
                  >
                    {i18n.t('Retry')}
                  </Button>
                  {!missingShell && listing.path && listing.path !== '/' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => load(parentPath(listing.path))}
                    >
                      {i18n.t('Go up')}
                    </Button>
                  )}
                </>
              }
            />
          ) : entries.length === 0 ? (
            <BrowserState
              icon={Inbox}
              tone="muted"
              title={i18n.t('This folder is empty')}
              message={cwd}
              mono
            />
          ) : (
            <>
              <FileTable
                entries={entries}
                selected={selected}
                now={now}
                onSelect={select}
                onOpen={open}
                onContextMenu={onRowMenu}
              />
              {listing.data.truncated && (
                <div className="border-border/60 text-fg-dim shrink-0 border-t px-3 py-1 text-[11px]">
                  {i18n.t('Showing the first {count} entries.', {
                    count: i18n.number(entries.length),
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {preview && (
          <>
            <ResizeHandle handleProps={drag.handleProps} dragging={drag.dragging} />
            <div
              className="border-border/60 bg-surface flex min-h-0 shrink-0 flex-col border-l"
              style={{ width: drag.width }}
            >
              <FilePreview
                preview={preview}
                onDownload={() =>
                  void download(entries.find((e) => e.name === preview.name) ?? null)
                }
                onClose={() => {
                  previewRequest.current++;
                  setPreview(null);
                }}
              />
            </div>
          </>
        )}
      </div>
      {menu && <FileContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
});

function BrowserState({
  icon: Icon,
  tone,
  title,
  message,
  mono,
  action,
}: {
  icon: typeof Inbox;
  tone: 'error' | 'warning' | 'muted';
  title: string;
  message?: string;
  mono?: boolean;
  action?: ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'bg-status-error/12 text-status-error'
      : tone === 'warning'
        ? 'bg-status-starting/12 text-status-starting'
        : 'bg-fg/5 text-fg-dim';
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div
          className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${toneClass}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-fg text-[13px] font-semibold">{title}</h3>
        {message && (
          <p
            className={`text-fg-muted mt-1.5 leading-relaxed break-words whitespace-pre-line ${mono ? 'font-mono text-[11.5px]' : 'text-[12px]'}`}
          >
            {message}
          </p>
        )}
        {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
      </div>
    </div>
  );
}
