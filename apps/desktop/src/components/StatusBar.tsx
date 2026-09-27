import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import {
  Activity,
  Cpu,
  Languages,
  MemoryStick,
  Network,
  Settings as SettingsIcon,
} from 'lucide-react';
import { ThemeMenu } from '@/components/ThemeMenu';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu, formatPercent } from '@/lib/format';
import { usageToneClass } from '@/lib/resourceTone';

export function StatusBar() {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const overviews = useAppStore((s) => s.overviews);
  const forwards = useAppStore((s) => s.portForwards);
  const appVersion = useAppStore((s) => s.appInfo?.version);
  const rightPanel = useAppStore((s) => s.rightPanel);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const openMainTab = useAppStore((s) => s.openMainTab);
  const openSettings = useAppStore((s) => s.openSettings);

  const stats = useMemo(() => {
    let connected = 0;
    let connecting = 0;
    let failed = 0;
    let idle = 0;
    for (const cluster of clusters) {
      const state = statuses[cluster.id]?.state ?? 'disconnected';
      if (state === 'connected') connected++;
      else if (state === 'connecting') connecting++;
      else if (state === 'error') failed++;
      else idle++;
    }
    return { connected, connecting, failed, idle };
  }, [clusters, statuses]);

  // Fleet-wide usage across connected clusters that report metrics.
  const totals = useMemo(() => {
    let cpu = 0;
    let cpuCap = 0;
    let mem = 0;
    let memCap = 0;
    let samples = 0;
    for (const [id, overview] of Object.entries(overviews)) {
      if (statuses[id]?.state !== 'connected' || !overview.usage) continue;
      cpu += overview.usage.cpu_millicores;
      mem += overview.usage.memory_bytes;
      cpuCap += overview.allocatable.cpu_millicores;
      memCap += overview.allocatable.memory_bytes;
      samples++;
    }
    return {
      cpu,
      mem,
      cpuPct: cpuCap ? (cpu / cpuCap) * 100 : 0,
      memPct: memCap ? (mem / memCap) * 100 : 0,
      samples,
    };
  }, [overviews, statuses]);

  const chip =
    'hover:bg-surface-overlay hover:text-fg rounded-app-sm flex items-center gap-1.5 px-1.5 py-1 transition';

  return (
    <div className="border-border/70 bg-surface-raised text-fg-muted flex h-8 shrink-0 items-center justify-between border-t px-4 text-[11px] leading-none">
      <div className="flex items-center gap-4">
        <Stat dot="bg-status-running" label={i18n.t('connected')} value={stats.connected} />
        {stats.connecting > 0 && (
          <Stat dot="bg-status-starting" label={i18n.t('connecting')} value={stats.connecting} />
        )}
        {stats.failed > 0 && (
          <Stat dot="bg-status-error" label={i18n.t('failing')} value={stats.failed} />
        )}
        <Stat dot="bg-status-stopped/60" label={i18n.t('idle')} value={stats.idle} />
      </div>
      <div className="flex items-center gap-0.5">
        {totals.samples > 0 && (
          <div
            className="mr-2 flex items-center gap-2 font-mono tabular-nums"
            title={i18n.plural(
              'Usage across {count} connected cluster',
              'Usage across {count} connected clusters',
              totals.samples,
            )}
          >
            <span className={cn('inline-flex items-center gap-1', usageToneClass(totals.cpuPct))}>
              <Cpu className="h-3 w-3" />
              {formatCpu(totals.cpu)} · {formatPercent(totals.cpuPct)}
            </span>
            <span className={cn('inline-flex items-center gap-1', usageToneClass(totals.memPct))}>
              <MemoryStick className="h-3 w-3" />
              {formatBytes(totals.mem)} · {formatPercent(totals.memPct)}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={() => openMainTab({ kind: 'port-forwards' })}
          className={chip}
          title={i18n.t('Active port forwards')}
        >
          <Network className="h-3 w-3" />
          <span className="tabular-nums">{forwards.length}</span>
          <span className="text-fg-dim">{i18n.t('forwards')}</span>
        </button>
        <button
          type="button"
          onClick={() => toggleRightPanel('events')}
          className={cn(chip, rightPanel === 'events' && 'text-fg')}
          title={i18n.t('Warning events across clusters')}
        >
          <Activity className="text-accent h-3 w-3" />
          <span className="text-fg-dim">{i18n.t('Events')}</span>
        </button>
        <button
          type="button"
          onClick={() => openSettings('general')}
          className={chip}
          title={i18n.t('Language')}
        >
          <Languages className="h-3 w-3" />
          <span className="text-fg-dim uppercase">{i18n.getLocale()}</span>
        </button>
        <button
          type="button"
          onClick={() => openSettings()}
          className={chip}
          title={i18n.t('Open Settings')}
        >
          <SettingsIcon className="h-3 w-3" />
          <span className="text-fg-dim">{i18n.t('Settings')}</span>
        </button>
        <ThemeMenu />
        {appVersion && (
          <button
            type="button"
            onClick={() => openSettings('about')}
            title={i18n.t('About Kubepit')}
            className="bg-accent/10 text-fg ring-accent/25 hover:bg-accent/20 hover:ring-accent/45 ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ring-1 transition-colors"
          >
            <KubepitMark className="text-accent h-3 w-3" />
            <span className="tabular-nums">v{appVersion}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ dot, label, value }: { dot: string; label: string; value: number }) {
  i18n.useLocale();
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="text-fg tabular-nums">{value}</span>
      <span className="text-fg-dim">{label}</span>
    </div>
  );
}
