import * as i18n from '@/i18n';
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ArrowUpRight,
  Copy,
  Download,
  History,
  Loader2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import { usePaneFocused } from '@/components/split/paneFocus';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Tabs, type Tab } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';
import { formatMoney, perMonth } from '@/lib/cost';
import { ipc } from '@/lib/ipc';
import { kindIcon } from '@/lib/kube/icons';
import { applyMode, workloadKey } from '@/lib/kube/recommendations/model';
import {
  confidenceLabel,
  coverageLabel,
  verdictLabel,
  workloadGvk,
} from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import { navigateTo } from '@/store/useWorkbenchStore';
import type {
  ClusterId,
  ContainerRecommendation,
  RightsizingReport,
  WorkloadRecommendation,
} from '@/types';
import { useActionDialogs } from '../actions/dialogStore';
import { ContainerChanges } from '../cost/RightsizingDialog';
import { CONFIDENCE_TONE, VERDICT_TONE } from '../cost/tones';
import { usePolled } from '../data/polled';
import { saveExportFile } from '../table/exportStore';
import { copyText, errorText, isTypingTarget, scrollParent } from '../util';
import { RecommendationTrend } from './RecommendationTrend';
import { ChartsNote, UsageHistoryCharts } from './UsageHistoryCharts';
import {
  drawerAction,
  evidenceRows,
  exportFileName,
  hpaTargets,
  hpaText,
  trapTarget,
  yamlKey,
} from './drawerModel';

/**
 * The Recommendations view's detail drawer (spec §9.1): one workload's
 * changes with the evidence and flags behind them, its usage history
 * (live from Prometheus), how its recommendation moved across stored scans
 * and its YAML fragment. `DrawerFrame` docks it beside the list from `@3xl`
 * and lays it over the page below; Escape closes it.
 */

export type DrawerTab = 'changes' | 'usage' | 'history' | 'yaml';

const HpaIcon = kindIcon('horizontalpodautoscalers.autoscaling');

/** A layout effect in the app, a plain (skipped) effect when rendered to a string. */
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface ViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Docked (`display: contents` wrapper) rather than laid over the page. */
const isDocked = (wrapper: HTMLElement) => getComputedStyle(wrapper).display === 'contents';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** The visible elements Tab reaches inside `root`. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * The page's scroll viewport on screen (the overlay covers exactly it, not
 * the window's title bar or navigator; the docked drawer is at most its
 * height) and whether the container query docks the drawer, re-read
 * whenever the viewport resizes.
 */
function useViewportRect(ref: RefObject<HTMLElement | null>): {
  rect: ViewportRect | null;
  docked: boolean;
} {
  const [rect, setRect] = useState<ViewportRect | null>(null);
  const [docked, setDocked] = useState(true);
  useClientLayoutEffect(() => {
    const el = ref.current;
    const viewport = el ? scrollParent(el) : null;
    if (!el || !viewport) return;
    const measure = () => {
      setDocked(isDocked(el));
      const r = viewport.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.top === r.top &&
        prev.left === r.left &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return { rect, docked };
}

/**
 * The drawer's chrome. From `@3xl` of the page it is a sticky panel in the
 * list's flex row; below, an overlay over the page's scroll viewport with a
 * backdrop, a modal dialog that keeps Tab inside. Escape closes it (unless
 * another dialog, a menu or a text field has the key); the overlay takes
 * focus when it opens and gives it back on close.
 * `openKey` is the open row, so a row opened from above the list scrolls
 * the docked panel into view.
 */
export function DrawerFrame({
  label,
  openKey,
  onClose,
  children,
}: {
  label: string;
  openKey: string;
  onClose: () => void;
  children: ReactNode;
}) {
  i18n.useLocale();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const { rect, docked } = useViewportRect(wrapperRef);
  const paneFocused = usePaneFocused();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!paneFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const panel = panelRef.current;
      // A hidden view tab keeps its drawer mounted.
      if (!panel || !panel.getClientRects().length) return;
      const inside = e.target instanceof Node && panel.contains(e.target);
      if (isTypingTarget(e.target) && !inside) return;
      if (useAppStore.getState().confirm || useActionDialogs.getState().dialog) return;
      const others = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      );
      if ([...others].some((el) => !panel.contains(el))) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneFocused]);

  // Layout effect: its cleanup runs before the panel leaves the DOM, while
  // it can still tell whether it had the focus.
  useClientLayoutEffect(() => {
    const panel = panelRef.current;
    const wrapper = wrapperRef.current;
    if (!panel || !wrapper) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!isDocked(wrapper)) panel.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected && panel.contains(document.activeElement))
        previous.focus({ preventScroll: true });
    };
  }, []);

  // Narrowed into the overlay while open: the modal takes the focus.
  useEffect(() => {
    const panel = panelRef.current;
    if (!docked && panel && !panel.contains(document.activeElement))
      panel.focus({ preventScroll: true });
  }, [docked]);

  const trapTab = (e: ReactKeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (docked || e.key !== 'Tab' || !panel) return;
    const items = focusablesIn(panel);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = trapTarget(items, active, e.shiftKey);
    if (target || !items.length) e.preventDefault();
    target?.focus();
  };

  useEffect(() => {
    const panel = panelRef.current;
    const wrapper = wrapperRef.current;
    if (!panel || !wrapper || !isDocked(wrapper)) return;
    const viewport = scrollParent(panel);
    if (!viewport) return;
    const r = panel.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    if (r.bottom <= v.top || r.top >= v.bottom) panel.scrollIntoView({ block: 'nearest' });
  }, [openKey]);

  const overlayStyle: CSSProperties = rect
    ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    : { inset: 0 };
  const panelStyle = {
    '--rd-max': rect ? `${Math.max(240, rect.height - 24)}px` : '80vh',
  } as CSSProperties;

  return (
    <div ref={wrapperRef} className="fixed z-40 @3xl:static @3xl:contents" style={overlayStyle}>
      <div
        aria-hidden
        onClick={onClose}
        className="motion-safe:animate-in motion-safe:fade-in absolute inset-0 bg-black/30 motion-safe:duration-150 @3xl:hidden"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role={docked ? undefined : 'dialog'}
        aria-modal={docked ? undefined : true}
        aria-label={label}
        style={panelStyle}
        onKeyDown={trapTab}
        className={cn(
          'bg-surface border-border @container absolute inset-y-0 right-0 flex w-full max-w-[26rem] flex-col overflow-hidden border-l shadow-2xl outline-none',
          'motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200',
          '@3xl:bg-surface-raised/40 @3xl:rounded-app @3xl:sticky @3xl:top-3 @3xl:right-auto @3xl:bottom-auto @3xl:max-h-[var(--rd-max)] @3xl:w-[22rem] @3xl:max-w-none @3xl:shrink-0 @3xl:border @3xl:shadow-none @3xl:motion-safe:animate-none @5xl:w-[26rem]',
        )}
      >
        {children}
      </aside>
    </div>
  );
}

/** The header row of a drawer: the workload (or key) and Close. */
function DrawerTitle({
  kind,
  name,
  namespace,
  onOpen,
  onClose,
}: {
  kind: string;
  name: string;
  namespace: string;
  onOpen?: () => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p lang="en" className="text-fg-dim text-[10.5px] font-semibold tracking-[0.1em] uppercase">
          {kind}
        </p>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            title={i18n.t('Open {kind} {name}', { kind, name })}
            className="group text-fg hover:text-accent flex max-w-full min-w-0 items-center gap-1 text-left text-[13.5px] font-semibold"
          >
            <span className="truncate">{name}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-50 transition group-hover:opacity-100" />
          </button>
        ) : (
          <p className="text-fg truncate text-[13.5px] font-semibold">{name}</p>
        )}
        <p className="text-fg-dim truncate text-[11px]">{namespace}</p>
      </div>
      <IconButton size="xs" label={i18n.t('Close')} icon={<X />} onClick={onClose} />
    </div>
  );
}

/** Drawer content for an open key the scan shown does not have. */
export function MissingRecommendation({
  openKey,
  onClose,
}: {
  openKey: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [kind = '', namespace = '', ...rest] = openKey.split('/');
  return (
    <>
      <header className="border-border/60 border-b px-4 py-3">
        <DrawerTitle kind={kind} name={rest.join('/')} namespace={namespace} onClose={onClose} />
      </header>
      <p className="text-fg-muted px-4 py-8 text-center text-[12px]">
        {i18n.t('This workload is not in the scan shown.')}
      </p>
    </>
  );
}

function Delta({ rec, currency }: { rec: WorkloadRecommendation; currency: string }) {
  i18n.useLocale();
  if (!rec.changed) return <span className="text-fg-dim text-[11.5px]">{i18n.t('No change')}</span>;
  const delta = rec.monthly_delta;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11.5px] font-medium whitespace-nowrap tabular-nums',
        delta < 0 ? 'text-status-running' : 'text-status-starting',
      )}
    >
      {delta < 0 ? (
        <TrendingDown className="h-3.5 w-3.5" />
      ) : (
        <TrendingUp className="h-3.5 w-3.5" />
      )}
      {i18n.t('{amount} / month', { amount: formatMoney(delta, currency, { signed: true }) })}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-fg-dim text-[10px] leading-tight font-semibold tracking-[0.1em] break-words uppercase">
        {label}
      </p>
      <p className="text-fg mt-0.5 truncate text-[12.5px] font-medium tabular-nums" title={value}>
        {value}
      </p>
    </div>
  );
}

function Evidence({
  container,
  throttleThreshold,
}: {
  container: ContainerRecommendation;
  throttleThreshold: number;
}) {
  i18n.useLocale();
  const e = container.evidence;
  if (!e) return null;
  return (
    <div className="border-border/50 mt-2 border-t pt-2">
      <p className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.1em] uppercase">
        {i18n.t('Evidence')}
      </p>
      <dl className="grid grid-cols-[minmax(92px,128px)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11.5px]">
        {evidenceRows(e, throttleThreshold).map((row) => (
          <Fragment key={row.key}>
            <dt className="text-fg-dim truncate">{row.label}</dt>
            <dd
              className={cn(
                'min-w-0 tabular-nums',
                row.warn ? 'text-status-starting font-medium' : 'text-fg-muted',
              )}
            >
              {row.value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function ChangesTab({ rec, report }: { rec: WorkloadRecommendation; report: RightsizingReport }) {
  i18n.useLocale();
  const currency = report.currency;
  const cronJob = rec.kind === 'CronJob';
  const noEvidence = rec.containers.every((c) => !c.evidence);
  const targets = rec.hpa ? hpaTargets(rec.hpa) : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 @xs:grid-cols-3">
        <Stat
          label={cronJob ? i18n.t('Running on average') : i18n.t('Replicas')}
          value={i18n.number(cronJob ? rec.cost_replicas : rec.replicas, {
            maximumFractionDigits: 2,
          })}
        />
        <Stat
          label={i18n.t('History')}
          value={rec.coverage_hours > 0 ? coverageLabel(rec.coverage_hours) : '—'}
        />
        <Stat label={i18n.t('Requests cost')} value={perMonth(rec.monthly_current, currency)} />
      </div>
      {rec.hpa && (
        <div className="border-border/60 bg-fg/[0.02] rounded-lg border px-3 py-2 text-[11.5px]">
          <p className="text-fg-muted flex items-start gap-1.5">
            <HpaIcon className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{hpaText(rec.hpa)}</span>
          </p>
          {targets.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
              {targets.map((t) => (
                <span
                  key={t}
                  className="bg-fg/5 text-fg-muted rounded px-1.5 py-px text-[10.5px] tabular-nums"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <ContainerChanges
        containers={rec.containers}
        includeLimits
        detail={(c) => (
          <Evidence container={c} throttleThreshold={report.settings.throttle_threshold_percent} />
        )}
      />
      {noEvidence && (
        <p className="text-fg-dim text-[11px]">
          {i18n.t(
            'This scan collected no evidence per container (metrics-server, or a scan of an older build).',
          )}
        </p>
      )}
    </div>
  );
}

function YamlTab({
  clusterId,
  rec,
  report,
  runId,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  report: RightsizingReport;
  runId: number | null;
}) {
  i18n.useLocale();
  const yaml = usePolled<string>(
    yamlKey(clusterId, rec, runId, report),
    () =>
      ipc.recommendationsExport(
        clusterId,
        runId,
        [{ kind: rec.kind, namespace: rec.namespace, name: rec.name }],
        'yaml',
      ),
    null,
  );
  const text = yaml.data;
  if (yaml.error && text === undefined)
    return (
      <ChartsNote
        icon={<TriangleAlert />}
        tone="error"
        title={i18n.t('The YAML could not be exported')}
        action={
          <Button size="xs" variant="secondary" onClick={() => void yaml.refresh()}>
            {i18n.t('Try again')}
          </Button>
        }
      >
        {yaml.error}
      </ChartsNote>
    );
  if (text === undefined)
    return (
      <div className="text-fg-dim flex items-center justify-center gap-2 py-10 text-[11.5px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {i18n.t('Loading…')}
      </div>
    );
  const save = () =>
    void saveExportFile(exportFileName(rec), text, 'yaml')
      .then((path) => {
        if (path) useAppStore.getState().pushToast('success', i18n.t('Saved {path}', { path }));
      })
      .catch((e: unknown) => useAppStore.getState().pushToast('error', errorText(e)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-fg-dim min-w-0 flex-1 text-[11px]">
          {i18n.t('The values to set, as the YAML export writes them.')}
        </p>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Copy className="h-3 w-3" />}
          onClick={() => void copyText(text, 'YAML')}
        >
          {i18n.t('Copy')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Download className="h-3 w-3" />}
          onClick={save}
        >
          {i18n.t('Save…')}
        </Button>
      </div>
      <pre className="border-border/60 bg-fg/[0.03] text-fg-muted overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed whitespace-pre">
        {text}
      </pre>
    </div>
  );
}

export function RecommendationDrawer({
  clusterId,
  rec,
  report,
  runId,
  past = false,
  connected,
  onClose,
  onApply,
  onReview,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  report: RightsizingReport;
  /** The picked past run (null = the latest). */
  runId: number | null;
  /** A past run is shown: stored data, read-only. */
  past?: boolean;
  connected: boolean;
  onClose: () => void;
  /** One-click apply of an eligible row (Task 26 adds the silent dry run; until then the review). */
  onApply: (rec: WorkloadRecommendation) => void;
  /** The review dialog (`RightsizingDialog`). */
  onReview: (rec: WorkloadRecommendation) => void;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<DrawerTab>('changes');
  const [container, setContainer] = useState<string | null>(null);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const key = workloadKey(rec);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsId = `rec-drawer${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const action = drawerAction(applyMode(rec, cluster ?? { read_only: false, environment: null }), {
    past,
    connected,
  });

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [key]);

  const tabs: Tab<DrawerTab>[] = [
    { key: 'changes', label: i18n.t('Changes') },
    { key: 'usage', label: i18n.t('Usage') },
    { key: 'history', label: i18n.t('History') },
    { key: 'yaml', label: 'YAML' },
  ];

  return (
    <DrawerFrame
      label={i18n.t('Recommendation for {name}', { name: rec.name })}
      openKey={key}
      onClose={onClose}
    >
      <header className="border-border/60 space-y-2 border-b px-4 pt-3 pb-2.5">
        <DrawerTitle
          kind={rec.kind}
          name={rec.name}
          namespace={rec.namespace}
          onOpen={() => navigateTo(clusterId, workloadGvk(rec.kind), rec.namespace, rec.name)}
          onClose={onClose}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5">
          <Badge tone={VERDICT_TONE[rec.verdict]} size="xs">
            {verdictLabel(rec.verdict)}
          </Badge>
          {rec.verdict !== 'no-data' && (
            <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
              {confidenceLabel(rec.confidence)}
            </Badge>
          )}
          <Delta rec={rec} currency={report.currency} />
          {action.kind !== 'none' && (
            <span className="ml-auto shrink-0" title={action.disabled ?? undefined}>
              <Button
                size="xs"
                variant={action.kind === 'apply' ? 'primary' : 'secondary'}
                disabled={!!action.disabled}
                onClick={() => (action.kind === 'apply' ? onApply(rec) : onReview(rec))}
              >
                {action.label}
              </Button>
            </span>
          )}
        </div>
        {past && (
          <p className="text-fg-dim flex min-w-0 items-center gap-1.5 text-[11px]">
            <History className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {i18n.t('Past scan of {time}: read-only', {
                time: i18n.date(report.computed_at, { dateStyle: 'medium', timeStyle: 'short' }),
              })}
            </span>
          </p>
        )}
      </header>
      <div className="border-border/60 border-b px-3 py-2">
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          idBase={tabsId}
          className="max-w-full overflow-x-auto"
        />
      </div>
      <div
        ref={bodyRef}
        role="tabpanel"
        id={`${tabsId}-panel-${tab}`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
        tabIndex={0}
        className="overlay-scroll min-h-0 flex-1 overflow-auto px-4 py-3 outline-none"
      >
        {tab === 'changes' ? (
          <ChangesTab rec={rec} report={report} />
        ) : tab === 'usage' ? (
          <UsageHistoryCharts
            clusterId={clusterId}
            rec={rec}
            report={report}
            runId={runId}
            past={past}
            connected={connected}
            container={container}
            onContainerChange={setContainer}
          />
        ) : tab === 'history' ? (
          <RecommendationTrend
            clusterId={clusterId}
            rec={rec}
            runId={runId}
            container={container}
            onContainerChange={setContainer}
          />
        ) : (
          <YamlTab clusterId={clusterId} rec={rec} report={report} runId={runId} />
        )}
      </div>
    </DrawerFrame>
  );
}
