import * as i18n from '@/i18n';
import { useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { MiB, strategyLabel } from '@/lib/kube/rightsizing/model';
import type { RightsizingSettings, RightsizingStrategyInfo } from '@/types';
import { Card } from '../overview/charts';

/** How one setting is edited: label, unit and range in display units. */
interface FieldSpec {
  label: () => string;
  suffix: () => string;
  min: number;
  max: (settings: RightsizingSettings) => number;
  integer?: boolean;
  /** Stored value → shown value. */
  show?: (v: number) => number;
  /** Shown value → stored value. */
  store?: (v: number) => number;
}

const percent: Pick<FieldSpec, 'suffix'> = { suffix: () => '%' };

/** The settings the strategies read (`settings_keys`), with the backend's ranges (spec §7). */
const FIELDS: Record<string, FieldSpec> = {
  cpu_headroom_percent: { label: () => i18n.t('CPU headroom'), ...percent, min: 0, max: () => 300 },
  memory_headroom_percent: {
    label: () => i18n.t('Memory headroom'),
    ...percent,
    min: 0,
    max: () => 300,
  },
  memory_limit_headroom_percent: {
    label: () => i18n.t('Memory limit headroom'),
    ...percent,
    min: 0,
    max: () => 300,
  },
  min_cpu_millicores: {
    label: () => i18n.t('Minimum CPU request'),
    suffix: () => 'm',
    min: 0,
    max: () => 64_000,
    integer: true,
  },
  min_memory_bytes: {
    label: () => i18n.t('Minimum memory request'),
    suffix: () => 'MiB',
    min: 0,
    max: () => 65_536,
    integer: true,
    show: (v) => Math.round(v / MiB),
    store: (v) => v * MiB,
  },
  days: {
    label: () => i18n.t('History'),
    suffix: () => i18n.t('days'),
    min: 1,
    max: () => 30,
    integer: true,
  },
  min_hours: {
    label: () => i18n.t('Minimum history'),
    suffix: () => i18n.t('hours'),
    min: 1,
    max: (s) => Math.min(720, s.days * 24),
    integer: true,
  },
  min_coverage: {
    label: () => i18n.t('Minimum coverage'),
    ...percent,
    min: 10,
    max: () => 100,
    show: (v) => Math.round(v * 100),
    store: (v) => v / 100,
  },
  throttle_threshold_percent: {
    label: () => i18n.t('Throttling threshold'),
    ...percent,
    min: 1,
    max: () => 50,
  },
};

function NumberField({
  label,
  rawKey,
  value,
  suffix,
  min,
  max,
  integer,
  onChange,
}: {
  label: string;
  /** Unknown settings show their raw key (an identifier, never translated). */
  rawKey?: boolean;
  value: number;
  suffix: string;
  min: number;
  max: number;
  integer?: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    let next = Number.isFinite(n) && text.trim() !== '' ? Math.min(max, Math.max(min, n)) : value;
    if (integer) next = Math.round(next);
    setText(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1">
      {rawKey ? (
        <span lang="en" className="text-fg-dim font-mono text-[10.5px]">
          {label}
        </span>
      ) : (
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.1em] uppercase">
          {label}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <Input
          inputMode="decimal"
          value={text}
          className="h-7 w-20 py-1 text-[12px] tabular-nums"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        {suffix && <span className="text-fg-dim text-[11px]">{suffix}</span>}
      </span>
    </label>
  );
}

function strategyNote(id: string): string | null {
  if (id === 'workload-history')
    return i18n.t(
      'CPU requests follow the p95 of usage plus headroom, memory requests the peak plus headroom; values round up to whole millicores and MiB. Short history, low coverage, throttling and OOM kills lower the confidence.',
    );
  if (id === 'percentile-headroom')
    return i18n.t(
      'CPU requests follow the p95 of usage, memory requests and limits the peak; values round up and never go below what was observed.',
    );
  return null;
}

const AUTOMATIC = '';

/**
 * Settings of the strategy that produced the recommendations: only the
 * fields it reads (`settings_keys`), unknown ones by their raw key. Saved
 * as `Settings.recommendations.overrides[strategy.id]`; "Defaults" drops
 * the override. With `strategies`, the header picks the strategy
 * (automatic = `Settings.recommendations.strategy` null).
 */
export function SettingsCard({
  strategy,
  settings,
  onChange,
  onReset,
  strategies,
  selectedStrategy = null,
  onStrategy,
}: {
  strategy: RightsizingStrategyInfo;
  settings: RightsizingSettings;
  onChange: (settings: RightsizingSettings) => void;
  onReset: () => void;
  strategies?: RightsizingStrategyInfo[];
  /** The saved strategy id (null = automatic). */
  selectedStrategy?: string | null;
  onStrategy?: (id: string | null) => void;
}) {
  i18n.useLocale();
  const values = settings as unknown as Record<string, unknown>;
  const note = strategyNote(strategy.id);
  return (
    <Card
      title={i18n.t('Recommendation settings')}
      icon={<SlidersHorizontal />}
      actions={
        <>
          {strategies && strategies.length > 1 && onStrategy && (
            <Select
              value={selectedStrategy ?? AUTOMATIC}
              onChange={(v) => onStrategy(v === AUTOMATIC ? null : v)}
              ariaLabel={i18n.t('Strategy')}
              options={[
                { value: AUTOMATIC, label: i18n.t('Automatic') },
                ...strategies.map((s) => ({ value: s.id, label: strategyLabel(s) })),
              ]}
            />
          )}
          <button
            type="button"
            onClick={onReset}
            className="text-fg-dim hover:text-fg inline-flex items-center gap-1 text-[11px]"
          >
            <RotateCcw className="h-3 w-3" />
            {i18n.t('Defaults')}
          </button>
        </>
      }
    >
      <div key={JSON.stringify(settings)} className="flex flex-wrap gap-x-5 gap-y-3 px-4 py-3">
        {strategy.settings_keys.map((key) => {
          const spec = FIELDS[key];
          const raw = values[key];
          const stored = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
          if (!spec)
            return (
              <NumberField
                key={key}
                label={key}
                rawKey
                value={stored}
                suffix=""
                min={0}
                max={Number.MAX_SAFE_INTEGER}
                onChange={(v) => onChange({ ...settings, [key]: v })}
              />
            );
          return (
            <NumberField
              key={key}
              label={spec.label()}
              value={spec.show ? spec.show(stored) : stored}
              suffix={spec.suffix()}
              min={spec.min}
              max={spec.max(settings)}
              integer={spec.integer}
              onChange={(v) => onChange({ ...settings, [key]: spec.store ? spec.store(v) : v })}
            />
          );
        })}
      </div>
      {note && (
        <p className="text-fg-dim border-border/60 border-t px-4 py-2 text-[11px]">{note}</p>
      )}
    </Card>
  );
}
