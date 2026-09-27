import * as i18n from '@/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { Anchor, RotateCcw, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { chartInitials, chartTone } from './charts';

/** Small pieces shared by the chart screens. */

/** Deterministic monogram (chart icons are remote images, which the CSP blocks). */
export function ChartAvatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight',
        chartTone(name),
        size === 'lg'
          ? 'h-10 w-10 rounded-xl text-[13px]'
          : size === 'md'
            ? 'h-7 w-7 rounded-lg text-[10.5px]'
            : 'h-6 w-6 rounded-md text-[9.5px]',
      )}
    >
      {chartInitials(name)}
    </span>
  );
}

/** Centered empty / error state in the chart screens' visual language. */
export function ChartsState({
  icon,
  tone = 'bg-fg/5 text-fg-dim',
  title,
  message,
  children,
}: {
  icon: ReactNode;
  tone?: string;
  title: string;
  message?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div
          className={cn(
            'mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5',
            tone,
          )}
        >
          {icon}
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">{title}</h3>
        {message && (
          <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed break-words whitespace-pre-line">
            {message}
          </p>
        )}
        {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

/** Shown when the helm CLI is not installed or not found. */
export function HelmMissing({ onRetry }: { onRetry?: () => void }) {
  i18n.useLocale();
  const [checking, setChecking] = useState(false);
  return (
    <ChartsState
      icon={<Anchor />}
      tone="bg-status-starting/12 text-status-starting"
      title={i18n.t('Helm is needed for charts')}
      message={i18n.t(
        'Kubepit uses the helm CLI to browse repositories and install or upgrade charts, so everything stays in sync with your terminal. Install helm, or tell Kubepit where it is.',
      )}
    >
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Wrench className="h-3.5 w-3.5" />}
        onClick={() => useAppStore.getState().openSettings('tools')}
      >
        {i18n.t('Open Settings → Tools')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={checking}
        leftIcon={<RotateCcw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />}
        onClick={() => {
          setChecking(true);
          void refreshAppInfo().finally(() => {
            setChecking(false);
            onRetry?.();
          });
        }}
      >
        {i18n.t('Check again')}
      </Button>
    </ChartsState>
  );
}

/** Re-detect kubectl / helm (app info is otherwise only read at startup). */
export async function refreshAppInfo() {
  try {
    useAppStore.setState({ appInfo: await ipc.appInfo() });
  } catch {
    /* Keep the previous detection. */
  }
}

/**
 * True when helm is known to be missing — chart commands would fail. The
 * detection is refreshed whenever the configured helm path changes.
 */
export function useHelmMissing(): boolean {
  const helmPath = useAppStore((s) => s.settings?.helm_path ?? null);
  const [seen, setSeen] = useState(helmPath);
  useEffect(() => {
    if (helmPath === seen) return;
    setSeen(helmPath);
    void refreshAppInfo();
  }, [helmPath, seen]);
  return useAppStore((s) => !!s.appInfo && !s.appInfo.helm.path);
}
