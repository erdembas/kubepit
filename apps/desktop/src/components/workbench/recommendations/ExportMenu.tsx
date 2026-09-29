import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Braces, Download, FileCode2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useClickOutsideClose } from '@/lib/hooks';
import { useAppStore } from '@/store/useAppStore';
import type {
  ClusterId,
  RecommendationExportFormat,
  RightsizingReport,
  WorkloadRecommendation,
} from '@/types';
import { exportRecommendations, exportSelection } from './exportRecommendations';

export interface ExportMenuProps {
  clusterId: ClusterId;
  /** The picked past run (null = the latest). */
  runId: number | null;
  /** The scan shown; null = nothing to export yet. */
  report: RightsizingReport | null;
  /** The rows in scope (see `SectionProps.rows`). */
  rows: WorkloadRecommendation[];
}

const FORMATS: {
  format: RecommendationExportFormat;
  label: string;
  icon: typeof Braces;
  hint: () => string;
}[] = [
  {
    format: 'json',
    label: 'JSON',
    icon: Braces,
    hint: () => i18n.t('Every workload with its usage evidence'),
  },
  {
    format: 'yaml',
    label: 'YAML',
    icon: FileCode2,
    hint: () => i18n.t('Resource fragments of the changed containers'),
  },
];

/** The display name of a cluster (the id when it is gone). */
export function useClusterName(clusterId: ClusterId): string {
  return useAppStore((s) => s.clusters.find((c) => c.id === clusterId)?.name ?? clusterId);
}

/**
 * A button opening a JSON / YAML menu; picking a format runs `onPick`
 * (a spinner shows until it settles). `header` is the page header's ghost
 * button, its label hidden in narrow panes; `bar` a selection bar action.
 */
export function ExportFormatMenu({
  label,
  variant,
  disabled = false,
  disabledReason,
  onPick,
}: {
  label: string;
  variant: 'header' | 'bar';
  disabled?: boolean;
  /** Tooltip while disabled. */
  disabledReason?: string;
  onPick: (format: RecommendationExportFormat) => Promise<void>;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  useClickOutsideClose(open, [trigger, panel], () => setOpen(false));

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const right = Math.max(8, window.innerWidth - r.right);
    // Open upwards from a bar at the bottom of the pane.
    setPos(
      r.bottom + 140 > window.innerHeight
        ? { right, bottom: window.innerHeight - r.top + 4 }
        : { right, top: r.bottom + 4 },
    );
  }, [open]);
  // Keyboard users land on the first format (Escape closes the menu).
  useEffect(() => {
    if (open && pos) panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pos]);

  const pick = async (format: RecommendationExportFormat) => {
    setOpen(false);
    setBusy(true);
    try {
      await onPick(format);
    } finally {
      setBusy(false);
    }
  };

  const icon = busy ? (
    <Loader2
      className={cn('shrink-0 animate-spin', variant === 'bar' ? 'h-3.5 w-3.5' : 'h-3 w-3')}
    />
  ) : (
    <Download className={cn('shrink-0', variant === 'bar' ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
  );
  const common = {
    ref: trigger,
    type: 'button' as const,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-label': label,
    disabled: disabled || busy,
    onClick: () => setOpen((v) => !v),
  };

  return (
    <>
      {variant === 'header' ? (
        // Disabled buttons show no tooltip: the wrapper carries it.
        <span title={disabled ? disabledReason : undefined}>
          <Button {...common} size="xs" variant={open ? 'secondary' : 'ghost'} leftIcon={icon}>
            <span className="hidden @md:inline">{label}</span>
          </Button>
        </span>
      ) : (
        <button
          {...common}
          title={label}
          className="text-fg-muted enabled:hover:bg-fg/8 enabled:hover:text-fg flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          {icon}
          <span className="hidden @lg:inline">{label}</span>
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            aria-label={label}
            className="border-border bg-surface-overlay animate-fade-in fixed z-[200] w-[260px] max-w-[calc(100vw-16px)] rounded-lg border py-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={pos}
          >
            {FORMATS.map(({ format, label: name, icon: Icon, hint }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => void pick(format)}
                className="hover:bg-fg/5 focus-visible:bg-fg/5 flex w-full items-start gap-2.5 px-3 py-1.5 text-left outline-none"
              >
                <Icon className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">
                  <span className="text-fg block text-[12px] font-medium">{name}</span>
                  <span className="text-fg-dim block text-[11px]">{hint()}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The header's Export slot (spec §9.1): the scan shown, for the namespaces
 * in scope, as JSON (every workload with its evidence) or YAML (resource
 * fragments of the changed containers), through `exportRecommendations`.
 * The list's selection bar exports checked rows the same way.
 */
export function ExportMenu({ clusterId, runId, report, rows }: ExportMenuProps) {
  i18n.useLocale();
  const clusterName = useClusterName(clusterId);
  return (
    <ExportFormatMenu
      variant="header"
      label={i18n.t('Export')}
      disabled={!report || !rows.length}
      disabledReason={
        report
          ? i18n.t('No workload in scope to export.')
          : i18n.t('Exports are available after the first scan.')
      }
      onPick={(format) =>
        report
          ? exportRecommendations(
              clusterId,
              runId,
              exportSelection(rows, report.workloads.length),
              format,
              clusterName,
            )
          : Promise.resolve()
      }
    />
  );
}
