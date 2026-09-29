import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Download,
  ExternalLink,
  FileCode2,
  Info,
  Loader2,
  Plus,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { isPrerelease } from '@/lib/semver';
import { useAppStore } from '@/store/useAppStore';
import { DETAILS_WIDTH, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { HelmChartDetail, HelmHubChart, HelmRepo } from '@/types';
import { openExternal } from '../actions/openExternal';
import { Markdown } from '../common/Markdown';
import { MonacoView } from '../common/MonacoView';
import { usePolled } from '../data/polled';
import { ChipList, MiniTable, MonoText, Row, Rows, Section } from '../details/primitives';
import { useDragWidth } from '../useDragWidth';
import { isTypingTarget } from '../util';
import { ChartAvatar } from './ChartBits';
import { CHART_KEYS, hubChartName } from './charts';

type Tab = 'readme' | 'values' | 'chart';

/** Resizable right-hand panel shell shared by chart and hub details. */
function DetailsShell({
  label,
  header,
  children,
  onClose,
  isActive,
}: {
  label: string;
  header: ReactNode;
  children: ReactNode;
  onClose: () => void;
  isActive: boolean;
}) {
  i18n.useLocale();
  const width = useWorkbenchStore((s) => s.detailsWidth);
  const drag = useDragWidth({
    width,
    setWidth: (w) => useWorkbenchStore.getState().setDetailsWidth(w),
    min: DETAILS_WIDTH.min,
    max: Math.min(DETAILS_WIDTH.max, Math.round(window.innerWidth * 0.7)),
    defaultWidth: DETAILS_WIDTH.default,
    edge: 'left',
  });
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTypingTarget(e.target) || useAppStore.getState().confirm) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, onClose]);
  return (
    <aside
      aria-label={label}
      className="border-border bg-surface animate-slide-in-right relative flex min-h-0 shrink-0 flex-col border-l shadow-[-12px_0_32px_-24px_rgb(0_0_0/0.45)]"
      style={{ width: drag.width, maxWidth: '72%' }}
    >
      <ResizeHandle
        handleProps={drag.handleProps}
        dragging={drag.dragging}
        className="focus-visible:bg-accent/15 absolute inset-y-0 -left-1 w-2 touch-none focus-visible:outline-none"
      />
      <header className="border-border/60 flex min-h-12 shrink-0 items-center gap-2.5 border-b px-3 py-2">
        {header}
        <span className="bg-border/80 mx-0.5 h-5 w-px shrink-0" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          aria-label={i18n.t('Close details')}
          className="text-fg-dim hover:bg-fg/5 hover:text-fg rounded-md p-1.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {children}
    </aside>
  );
}

function Loading({ error }: { error?: string | null }) {
  i18n.useLocale();
  return (
    <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-6 text-[12px]">
      {error ? (
        <span className="text-status-error max-w-md text-center font-mono text-[11.5px] break-words whitespace-pre-wrap">
          {error}
        </span>
      ) : (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Loading…')}
        </>
      )}
    </div>
  );
}

/** Details of one chart of a configured repository (`repo/chart`). */
export function HelmChartDetails({
  chartRef,
  latest,
  isActive,
  onClose,
  onInstall,
}: {
  chartRef: string;
  /** Newest stable version from the catalog, if known. */
  latest: string | null;
  isActive: boolean;
  onClose: () => void;
  onInstall: (version: string | null) => void;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<Tab>('readme');
  const [version, setVersion] = useState<string | null>(latest);
  const versions = usePolled(
    CHART_KEYS.versions(chartRef),
    () => ipc.helmChartVersions(chartRef),
    null,
  );
  const newestStable = useMemo(
    () =>
      versions.data?.find((v) => !isPrerelease(v.version))?.version ??
      versions.data?.[0]?.version ??
      null,
    [versions.data],
  );
  const shown = version ?? newestStable;
  const detail = usePolled<HelmChartDetail>(
    CHART_KEYS.show(chartRef, shown),
    () => ipc.helmChartShow(chartRef, shown),
    null,
  );
  const [repo, chart] = chartRef.split('/');
  const options = useMemo(
    () =>
      (versions.data ?? []).map((v) => ({
        value: v.version,
        label: v.version,
        description: v.app_version
          ? i18n.t('App {version}', { version: v.app_version })
          : undefined,
        badge:
          v.version === newestStable
            ? i18n.t('latest')
            : isPrerelease(v.version)
              ? i18n.t('pre-release')
              : undefined,
      })),
    [versions.data, newestStable],
  );
  const meta = detail.data?.metadata;
  const tabs: Array<{ id: Tab; label: string; icon: typeof Info }> = [
    { id: 'readme', label: i18n.t('README'), icon: BookOpen },
    { id: 'values', label: i18n.t('Values'), icon: SlidersHorizontal },
    { id: 'chart', label: i18n.t('Chart'), icon: FileCode2 },
  ];

  return (
    <DetailsShell
      label={i18n.t('Chart details')}
      isActive={isActive}
      onClose={onClose}
      header={
        <>
          <ChartAvatar name={chart ?? chartRef} size="md" />
          <div className="min-w-0 flex-1">
            <h2 className="text-fg flex items-center gap-2 truncate text-[13px] font-semibold">
              <span className="truncate">{chart}</span>
              {meta?.deprecated && (
                <Badge tone="warning" size="xs">
                  {i18n.t('Deprecated')}
                </Badge>
              )}
            </h2>
            <p className="text-fg-dim truncate text-[11px]">
              {meta?.app_version
                ? i18n.t('{repo} · app {version}', { repo: repo ?? '', version: meta.app_version })
                : repo}
            </p>
          </div>
          <SearchableSelect
            compact
            label={i18n.t('Chart version')}
            value={shown ?? ''}
            onChange={setVersion}
            options={options}
            placeholder={versions.data ? i18n.t('Version') : i18n.t('Loading…')}
            searchPlaceholder={i18n.t('Filter versions…')}
            disabled={!options.length}
            menuWidth={260}
            className="max-w-[150px] font-mono"
          />
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            disabled={!shown}
            onClick={() => onInstall(shown)}
          >
            {i18n.t('Install')}
          </Button>
        </>
      }
    >
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
        <Loading error={detail.error} />
      ) : tab === 'readme' ? (
        detail.data.readme.trim() ? (
          <div className="overlay-scroll min-h-0 flex-1 overflow-auto px-5 py-4">
            <Markdown source={detail.data.readme} />
          </div>
        ) : (
          <p className="text-fg-dim flex flex-1 items-center justify-center text-[12px]">
            {i18n.t('This chart has no README.')}
          </p>
        )
      ) : tab === 'values' ? (
        <MonacoView value={detail.data.values_yaml} />
      ) : (
        <ChartMetadata detail={detail.data} />
      )}
    </DetailsShell>
  );
}

function Link({ href, children }: { href: string; children?: ReactNode }) {
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <MonoText>{href}</MonoText>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
      className="text-accent inline-flex max-w-full items-center gap-1 break-all hover:underline"
    >
      <span className="min-w-0 break-all">{children ?? href}</span>
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

function ChartMetadata({ detail }: { detail: HelmChartDetail }) {
  i18n.useLocale();
  const m = detail.metadata;
  return (
    <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
      <Section title={i18n.t('Chart')}>
        <Rows>
          <Row label={i18n.t('Name')}>
            <MonoText>{m.name}</MonoText>
          </Row>
          <Row label={i18n.t('Version')}>
            <MonoText>{m.version}</MonoText>
          </Row>
          <Row label={i18n.t('App version')}>
            {m.app_version && <MonoText>{m.app_version}</MonoText>}
          </Row>
          <Row label={i18n.t('Type')}>{m.chart_type}</Row>
          <Row label={i18n.t('Kubernetes')}>
            {m.kube_version && <MonoText>{m.kube_version}</MonoText>}
          </Row>
          <Row label={i18n.t('Deprecated')}>{m.deprecated ? i18n.t('Yes') : null}</Row>
          <Row label={i18n.t('Description')}>{m.description}</Row>
          <Row label={i18n.t('Home')}>{m.home && <Link href={m.home} />}</Row>
        </Rows>
      </Section>
      {m.sources.length > 0 && (
        <Section title={i18n.t('Sources')}>
          <ul className="space-y-1 text-[12px]">
            {m.sources.map((s) => (
              <li key={s}>
                <Link href={s} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {m.keywords.length > 0 && (
        <Section title={i18n.t('Keywords')}>
          <ChipList entries={m.keywords} limit={16} />
        </Section>
      )}
      <Section title={i18n.t('Maintainers')}>
        <MiniTable
          rows={m.maintainers}
          rowKey={(r, i) => `${r.name}-${i}`}
          empty={i18n.t('No maintainers listed')}
          columns={[
            { label: i18n.t('Name'), cell: (r) => <span className="text-fg">{r.name}</span> },
            {
              label: i18n.t('Email'),
              cell: (r) => (r.email ? <Link href={`mailto:${r.email}`}>{r.email}</Link> : '—'),
            },
            {
              label: i18n.t('URL'),
              lang: 'en',
              cell: (r) => (r.url ? <Link href={r.url} /> : '—'),
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('Dependencies')}>
        <MiniTable
          rows={m.dependencies}
          rowKey={(r, i) => `${r.name}-${i}`}
          empty={i18n.t('No dependencies')}
          columns={[
            { label: i18n.t('Name'), cell: (r) => <span className="text-fg">{r.name}</span> },
            {
              label: i18n.t('Version'),
              className: 'whitespace-nowrap font-mono text-[11px]',
              cell: (r) => r.version ?? '—',
            },
            {
              label: i18n.t('Repository'),
              lang: 'en',
              className: 'font-mono text-[11px] break-all',
              cell: (r) => r.repository ?? '—',
            },
            {
              label: i18n.t('Condition'),
              className: 'font-mono text-[11px]',
              cell: (r) => r.condition ?? '—',
            },
          ]}
        />
      </Section>
    </div>
  );
}

/** Details of an Artifact Hub result, with an "add repository" shortcut. */
export function HubChartDetails({
  chart,
  repos,
  isActive,
  onClose,
  onAddRepo,
  onOpenChart,
}: {
  chart: HelmHubChart;
  repos: HelmRepo[];
  isActive: boolean;
  onClose: () => void;
  onAddRepo: (repo: HelmRepo) => void;
  onOpenChart: (chartRef: string) => void;
}) {
  i18n.useLocale();
  const name = hubChartName(chart.url);
  const configured = repos.find(
    (r) => r.url.replace(/\/+$/, '') === chart.repository_url.replace(/\/+$/, ''),
  );
  return (
    <DetailsShell
      label={i18n.t('Chart details')}
      isActive={isActive}
      onClose={onClose}
      header={
        <>
          <ChartAvatar name={name} size="md" />
          <div className="min-w-0 flex-1">
            <h2 className="text-fg truncate text-[13px] font-semibold">{name}</h2>
            <p className="text-fg-dim truncate text-[11px]">
              {i18n.t('Artifact Hub · {repo}', { repo: chart.repository_name })}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => void openExternal(chart.url)}
          >
            {i18n.t('Artifact Hub')}
          </Button>
        </>
      }
    >
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <Section title={i18n.t('Package')}>
          <Rows>
            <Row label={i18n.t('Latest version')}>
              <MonoText>{chart.version}</MonoText>
            </Row>
            <Row label={i18n.t('App version')}>
              {chart.app_version && <MonoText>{chart.app_version}</MonoText>}
            </Row>
            <Row label={i18n.t('Description')}>{chart.description}</Row>
            <Row label={i18n.t('Repository')}>{chart.repository_name}</Row>
            <Row label={i18n.t('Repository URL')}>
              {chart.repository_url && <MonoText>{chart.repository_url}</MonoText>}
            </Row>
          </Rows>
        </Section>
        <Section title={i18n.t('Install')}>
          {configured ? (
            <div className="space-y-2.5">
              <p className="text-fg-muted text-[12px]">
                {i18n.t('This repository is configured as "{name}".', { name: configured.name })}
              </p>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<BookOpen className="h-3.5 w-3.5" />}
                onClick={() => onOpenChart(`${configured.name}/${name}`)}
              >
                {i18n.t('Open chart')}
              </Button>
            </div>
          ) : chart.repository_url ? (
            <div className="space-y-2.5">
              <p className="text-fg-muted text-[12px]">
                {i18n.t(
                  'Add the "{name}" repository to read the README and values and to install this chart.',
                  { name: chart.repository_name },
                )}
              </p>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() =>
                  onAddRepo({ name: chart.repository_name, url: chart.repository_url })
                }
              >
                {i18n.t('Add repository')}
              </Button>
            </div>
          ) : (
            <p className="text-fg-dim text-[12px]">
              {i18n.t('Artifact Hub did not report a repository URL for this chart.')}
            </p>
          )}
        </Section>
      </div>
    </DetailsShell>
  );
}
