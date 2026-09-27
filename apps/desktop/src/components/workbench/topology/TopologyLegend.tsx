import * as i18n from '@/i18n';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { StatusTone } from '@/lib/kube/pods';
import { EDGE_FAMILIES, type EdgeFamily } from '@/lib/kube/topology';
import { usePersistentBoolean } from '@/lib/usePersistentBoolean';
import { familyLabel, flagLabel, toneLabel } from './labels';
import { FAMILY_DASH, FAMILY_STROKE, TONE_DOT } from './styles';

const TONES: StatusTone[] = ['success', 'warning', 'error', 'info', 'muted'];

function Line({ family }: { family: EdgeFamily }) {
  return (
    <svg width={22} height={8} aria-hidden className="shrink-0">
      <line
        x1={1}
        y1={4}
        x2={21}
        y2={4}
        strokeWidth={1.75}
        strokeDasharray={FAMILY_DASH[family]}
        className={FAMILY_STROKE[family]}
      />
    </svg>
  );
}

/** Collapsible legend in the map's corner: relationship families and status tones. */
export function TopologyLegend({ families }: { families: ReadonlySet<EdgeFamily> }) {
  i18n.useLocale();
  const [open, setOpen] = usePersistentBoolean('kubepit.topology.legend', false);
  const shown = EDGE_FAMILIES.filter((f) => families.has(f));
  return (
    <div className="border-border bg-surface-raised/95 absolute bottom-3 left-3 max-w-[calc(100%-5rem)] rounded-lg border shadow-sm backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-fg-dim hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
      >
        {i18n.t('Legend')}
        {open ? (
          <ChevronDown className="ml-auto h-3 w-3" />
        ) : (
          <ChevronUp className="ml-auto h-3 w-3" />
        )}
      </button>
      {open && (
        <div className="border-border/60 grid grid-cols-[auto_auto] gap-x-5 gap-y-1 border-t px-2.5 py-2 text-[11px]">
          <div className="flex flex-col gap-1">
            {shown.map((f) => (
              <span key={f} className="text-fg-muted flex items-center gap-2 whitespace-nowrap">
                <Line family={f} />
                {familyLabel(f)}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {TONES.map((t) => (
              <span key={t} className="text-fg-muted flex items-center gap-2 whitespace-nowrap">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[t])} />
                {toneLabel(t)}
              </span>
            ))}
            <span className="text-fg-muted flex items-center gap-2 whitespace-nowrap">
              <span className="border-status-error/70 h-2.5 w-3.5 shrink-0 rounded-[3px] border border-dashed" />
              {flagLabel('missing')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
