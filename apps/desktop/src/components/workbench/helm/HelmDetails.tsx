import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  FileCode2,
  History,
  Info,
  Loader2,
  Package,
  Save,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { ipc } from '@/lib/ipc';
import { phaseTone } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { useAppStore } from '@/store/useAppStore';
import { DETAILS_WIDTH, useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { HelmReleaseDetail } from '@/types';
import { confirmDestructive, runMutation } from '../actions/guard';
import { MonacoView } from '../common/MonacoView';
import { useCluster } from '../data/hooks';
import { refreshPolled, usePolled } from '../data/polled';
import {
  CodeBlock,
  MiniTable,
  MonoText,
  Row,
  Rows,
  Section,
  ToneText,
} from '../details/primitives';
import { usePaneFocused } from '@/components/split/paneFocus';
import { useDragWidth } from '../useDragWidth';
import { isTypingTarget, useNow } from '../util';
import { HelmDeployDialog } from './HelmDeployDialog';
import { HelmRevisionCompare } from './HelmRevisionCompare';

type Tab = 'overview' | 'values' | 'manifest' | 'history';

export function HelmDetails({
  clusterId,
  namespace,
  name,
  isActive,
  listKey,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  isActive: boolean;
  listKey: string;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<Tab>('overview');
  const [upgrading, setUpgrading] = useState(false);
  const { cluster, readOnly } = useCluster(clusterId);
  const key = `${clusterId}|helm-detail|${namespace}/${name}`;
  const detail = usePolled<HelmReleaseDetail>(
    key,
    () => ipc.helmReleaseDetail(clusterId, namespace, name),
    30_000,
    isActive,
  );
  const width = useWorkbenchStore((s) => s.detailsWidth);
  const drag = useDragWidth({
    width,
    setWidth: (w) => useWorkbenchStore.getState().setDetailsWidth(w),
    min: DETAILS_WIDTH.min,
    max: Math.min(DETAILS_WIDTH.max, Math.round(window.innerWidth * 0.7)),
    defaultWidth: DETAILS_WIDTH.default,
    edge: 'left',
  });
  const now = useNow(30_000, isActive);
  const close = () => useWorkbenchStore.getState().select(clusterId, VIEW.helmReleases, null);
  const refresh = () => {
    refreshPolled(key);
    refreshPolled(listKey);
  };

  const paneFocused = usePaneFocused();
  useEffect(() => {
    if (!isActive || !paneFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTypingTarget(e.target) || useAppStore.getState().confirm) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, paneFocused]);

  const uninstall = () =>
    confirmDestructive({
      cluster,
      title: i18n.t('Uninstall release'),
      message: i18n.t(
        'Uninstall Helm release "{name}" from {namespace}? Its resources are deleted.',
        { name, namespace },
      ),
      confirmLabel: i18n.t('Uninstall'),
      typeName: name,
      run: async () => {
        if (
          await runMutation(
            () => ipc.helmUninstall(clusterId, namespace, name),
            i18n.t('Uninstalled {name}', { name }),
          )
        ) {
          close();
          refreshPolled(listKey);
        }
      },
    });

  const release = detail.data?.release;
  const tabs: Array<{ id: Tab; label: string; icon: typeof Info }> = [
    { id: 'overview', label: i18n.t('Overview'), icon: Info },
    { id: 'values', label: i18n.t('Values'), icon: SlidersHorizontal },
    { id: 'manifest', label: i18n.t('Manifest'), icon: FileCode2 },
    { id: 'history', label: i18n.t('History'), icon: History },
  ];

  return (
    <aside
      aria-label={i18n.t('Release details')}
      className="border-border bg-surface animate-slide-in-right relative flex min-h-0 shrink-0 flex-col border-l shadow-[-12px_0_32px_-24px_rgb(0_0_0/0.45)]"
      style={{ width: drag.width, maxWidth: '72%' }}
    >
      <ResizeHandle
        handleProps={drag.handleProps}
        dragging={drag.dragging}
        className="focus-visible:bg-accent/15 absolute inset-y-0 -left-1 w-2 touch-none focus-visible:outline-none"
      />
      <header className="border-border/60 flex min-h-12 shrink-0 items-center gap-2.5 border-b px-3 py-2">
        <span className="bg-accent/10 text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
          <Package className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-fg truncate text-[13px] font-semibold">{name}</h2>
          <p className="text-fg-dim truncate text-[11px]">
            {i18n.t('Helm release')} · {namespace}
            {release && ` · ${release.chart}-${release.chart_version}`}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<ArrowUpCircle className="h-3.5 w-3.5" />}
          disabled={!detail.data}
          title={readOnly ? i18n.t('Read-only cluster: preview only') : undefined}
          onClick={() => setUpgrading(true)}
        >
          {i18n.t('Upgrade…')}
        </Button>
        <IconButton
          label={readOnly ? i18n.t('Read-only cluster: changes are blocked') : i18n.t('Uninstall')}
          icon={<Trash2 />}
          tone="danger"
          disabled={readOnly || !release}
          onClick={uninstall}
        />
        <span className="bg-border/80 mx-0.5 h-5 w-px shrink-0" aria-hidden />
        <button
          type="button"
          onClick={close}
          aria-label={i18n.t('Close details')}
          className="text-fg-dim hover:bg-fg/5 hover:text-fg rounded-md p-1.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <nav
        role="tablist"
        className="border-border/60 flex h-10 shrink-0 items-center gap-1 border-b px-3"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition',
              tab === id
                ? 'bg-fg/7 text-fg font-medium'
                : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>
      {!detail.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
          {detail.error ? (
            <span className="text-status-error px-4 text-center break-words">{detail.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading…')}
            </>
          )}
        </div>
      ) : tab === 'overview' ? (
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
          <Section title={i18n.t('Release')}>
            <Rows>
              <Row label={i18n.t('Status')}>
                <ToneText tone={phaseTone(detail.data.release.status)}>
                  {detail.data.release.status}
                </ToneText>
              </Row>
              <Row label={i18n.t('Chart')}>
                <MonoText>{`${detail.data.release.chart}-${detail.data.release.chart_version}`}</MonoText>
              </Row>
              <Row label={i18n.t('App version')}>{detail.data.release.app_version}</Row>
              <Row label={i18n.t('Revision')}>{detail.data.release.revision}</Row>
              <Row label={i18n.t('Updated')}>
                {detail.data.release.updated &&
                  i18n.t('{age} ago', { age: formatAge(detail.data.release.updated, now) })}
              </Row>
              <Row label={i18n.t('Description')}>{detail.data.release.description}</Row>
            </Rows>
          </Section>
          <Section title={i18n.t('Notes')}>
            {detail.data.notes ? (
              <CodeBlock text={detail.data.notes} maxHeight="max-h-[420px]" />
            ) : (
              <p className="text-fg-dim text-[12px]">{i18n.t('No notes')}</p>
            )}
          </Section>
        </div>
      ) : tab === 'values' ? (
        <ValuesEditor
          key={detail.data.release.revision}
          detail={detail.data}
          readOnly={readOnly}
          onSave={(values) => {
            confirmDestructive({
              cluster,
              title: i18n.t('Upgrade release'),
              message: i18n.t(
                'Run helm upgrade for "{name}" with the edited values? A new revision is created.',
                { name },
              ),
              confirmLabel: i18n.t('Upgrade'),
              typeName: name,
              run: async () => {
                if (
                  await runMutation(
                    () => ipc.helmUpgradeValues(clusterId, namespace, name, values),
                    i18n.t('Upgraded {name}', { name }),
                  )
                )
                  refresh();
              },
            });
          }}
        />
      ) : tab === 'manifest' ? (
        <MonacoView value={detail.data.manifest} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="overlay-scroll max-h-[45%] min-h-24 shrink-0 overflow-auto p-4">
            <MiniTable
              rows={detail.data.history}
              rowKey={(r) => String(r.revision)}
              columns={[
                {
                  label: i18n.t('Revision'),
                  className: 'tabular-nums',
                  cell: (r) => <span className="text-fg">{r.revision}</span>,
                },
                {
                  label: i18n.t('Status'),
                  className: 'whitespace-nowrap',
                  cell: (r) => <ToneText tone={phaseTone(r.status)}>{r.status}</ToneText>,
                },
                {
                  label: i18n.t('Chart'),
                  className: 'whitespace-nowrap font-mono text-[11px]',
                  cell: (r) => r.chart_version,
                },
                {
                  label: i18n.t('App'),
                  className: 'whitespace-nowrap',
                  cell: (r) => r.app_version ?? '—',
                },
                {
                  label: i18n.t('Updated'),
                  className: 'whitespace-nowrap',
                  cell: (r) => formatAge(r.updated, now),
                },
                {
                  label: i18n.t('Description'),
                  className: 'min-w-[140px]',
                  cell: (r) => <span className="line-clamp-2">{r.description}</span>,
                },
                {
                  label: '',
                  className: 'text-right',
                  cell: (r) =>
                    r.revision !== detail.data?.release.revision ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        leftIcon={<Undo2 className="h-3 w-3" />}
                        disabled={readOnly}
                        onClick={() =>
                          confirmDestructive({
                            cluster,
                            title: i18n.t('Roll back release'),
                            message: i18n.t('Roll back "{name}" to revision {revision}?', {
                              name,
                              revision: r.revision,
                            }),
                            confirmLabel: i18n.t('Roll back'),
                            typeName: name,
                            run: async () => {
                              if (
                                await runMutation(
                                  () => ipc.helmRollback(clusterId, namespace, name, r.revision),
                                  i18n.t('Rolled back {name} to revision {revision}', {
                                    name,
                                    revision: r.revision,
                                  }),
                                )
                              )
                                refresh();
                            },
                          })
                        }
                      >
                        {i18n.t('Rollback')}
                      </Button>
                    ) : (
                      <span className="text-fg-dim text-[11px]">{i18n.t('current')}</span>
                    ),
                },
              ]}
            />
          </div>
          <HelmRevisionCompare
            key={detail.data.release.revision}
            clusterId={clusterId}
            namespace={namespace}
            name={name}
            history={detail.data.history}
          />
        </div>
      )}
      {upgrading && detail.data && (
        <HelmDeployDialog
          clusterId={clusterId}
          target={{ mode: 'upgrade', detail: detail.data }}
          onClose={() => setUpgrading(false)}
        />
      )}
    </aside>
  );
}

function ValuesEditor({
  detail,
  readOnly,
  onSave,
}: {
  detail: HelmReleaseDetail;
  readOnly: boolean;
  onSave: (values: string) => void;
}) {
  i18n.useLocale();
  const [draft, setDraft] = useState(detail.values_yaml);
  const [showComputed, setShowComputed] = useState(false);
  const dirty = draft !== detail.values_yaml;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
        <label className="text-fg-dim flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showComputed}
            onChange={(e) => setShowComputed(e.target.checked)}
            className="accent-accent"
          />
          {i18n.t('Show computed values')}
        </label>
        {dirty && <span className="text-status-starting">{i18n.t('Unsaved changes')}</span>}
        <div className="ml-auto flex items-center gap-1">
          {dirty && (
            <Button size="xs" variant="ghost" onClick={() => setDraft(detail.values_yaml)}>
              {i18n.t('Discard')}
            </Button>
          )}
          <Button
            size="xs"
            variant="primary"
            leftIcon={<Save className="h-3 w-3" />}
            disabled={readOnly || !dirty || showComputed}
            title={readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined}
            onClick={() => onSave(draft)}
          >
            {i18n.t('Save')}
          </Button>
        </div>
      </div>
      {showComputed ? (
        <MonacoView value={detail.computed_values_yaml} />
      ) : (
        <MonacoView value={draft} readOnly={readOnly} onChange={setDraft} />
      )}
    </div>
  );
}
