import * as i18n from '@/i18n';
import { CircleDollarSign } from 'lucide-react';
import { useCostStatus } from '@/components/workbench/cost/useCost';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { costPlatformLabel, costServiceLabel, costSourceLabel } from '@/lib/cost';
import type { ClusterId, CostConfig, CostPricing, PromScheme } from '@/types';
import { Field } from './Field';

/** Form state of `ClusterDef.cost` (numbers stay text while typing). */
export interface CostDraft {
  mode: CostConfig['source']['mode'];
  namespace: string;
  service: string;
  port: string;
  scheme: PromScheme;
  path_prefix: string;
  custom: boolean;
  currency: string;
  cpu_hour: string;
  memory_gib_hour: string;
  gpu_hour: string;
  storage_gib_month: string;
  discount_percent: string;
}

/** Generic defaults, used until the backend reports the platform's prices. */
const GENERIC: CostPricing = {
  currency: 'USD',
  cpu_hour: 0.024,
  memory_gib_hour: 0.003,
  gpu_hour: 0.6,
  storage_gib_month: 0.05,
  discount_percent: 0,
};

function pricingDraft(p: CostPricing) {
  return {
    currency: p.currency,
    cpu_hour: String(p.cpu_hour),
    memory_gib_hour: String(p.memory_gib_hour),
    gpu_hour: p.gpu_hour == null ? '' : String(p.gpu_hour),
    storage_gib_month: p.storage_gib_month == null ? '' : String(p.storage_gib_month),
    discount_percent: String(p.discount_percent),
  };
}

export function costDraft(config: CostConfig | undefined): CostDraft {
  const source = config?.source ?? { mode: 'auto' as const };
  const service =
    source.mode === 'opencost' || source.mode === 'kubecost'
      ? {
          namespace: source.namespace,
          service: source.service,
          port: String(source.port),
          scheme: source.scheme,
          path_prefix: source.path_prefix,
        }
      : {
          namespace: 'opencost',
          service: 'opencost',
          port: '9003',
          scheme: 'http' as const,
          path_prefix: '',
        };
  return {
    mode: source.mode,
    ...service,
    custom: !!config?.pricing,
    ...pricingDraft(config?.pricing ?? GENERIC),
  };
}

const num = (text: string) => Number(text.trim().replace(',', '.'));

/** The setting to save, or a message explaining what is wrong. */
export function costConfig(draft: CostDraft): { config: CostConfig } | { error: string } {
  let source: CostConfig['source'];
  if (draft.mode === 'opencost' || draft.mode === 'kubecost') {
    const port = Number(draft.port.trim());
    if (!draft.namespace.trim())
      return { error: i18n.t('Enter the namespace of the cost service.') };
    if (!draft.service.trim()) return { error: i18n.t('Enter the name of the cost service.') };
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { error: i18n.t('Enter a port between 1 and 65535.') };
    source = {
      mode: draft.mode,
      namespace: draft.namespace.trim(),
      service: draft.service.trim(),
      port,
      scheme: draft.scheme,
      path_prefix: draft.path_prefix.trim(),
    };
  } else source = { mode: draft.mode };
  if (!draft.custom) return { config: { source, pricing: null } };
  const currency = draft.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    return { error: i18n.t('The currency must be a three-letter code such as USD or EUR.') };
  const price = (text: string) => {
    const n = num(text);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const cpu = price(draft.cpu_hour);
  const memory = price(draft.memory_gib_hour);
  if (cpu == null || memory == null)
    return { error: i18n.t('Enter CPU and memory prices of zero or more.') };
  const optional = (text: string) => (text.trim() ? price(text) : null);
  const gpu = optional(draft.gpu_hour);
  const storage = optional(draft.storage_gib_month);
  if ((draft.gpu_hour.trim() && gpu == null) || (draft.storage_gib_month.trim() && storage == null))
    return { error: i18n.t('GPU and storage prices must be zero or more (or empty).') };
  const discount = draft.discount_percent.trim() ? num(draft.discount_percent) : 0;
  if (!Number.isFinite(discount) || discount < 0 || discount > 100)
    return { error: i18n.t('The discount must be between 0 and 100 percent.') };
  return {
    config: {
      source,
      pricing: {
        currency,
        cpu_hour: cpu,
        memory_gib_hour: memory,
        gpu_hour: gpu,
        storage_gib_month: storage,
        discount_percent: discount,
      },
    },
  };
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-app-sm inline-flex h-7 items-center gap-1.5 border px-2 text-[11.5px] transition',
        active
          ? 'border-accent/40 bg-accent/12 text-fg font-medium'
          : 'border-border text-fg-muted hover:text-fg hover:border-border-strong',
      )}
    >
      {children}
    </button>
  );
}

/** "Cost" of the cluster editor: cost source and the price model of estimates. */
export function CostFields({
  clusterId,
  value,
  onChange,
}: {
  /** `null` while adding: no status lookup runs before the cluster exists. */
  clusterId: ClusterId | null;
  value: CostDraft;
  onChange: (next: CostDraft) => void;
}) {
  i18n.useLocale();
  const status = useCostStatus(clusterId).data;
  const set = <K extends keyof CostDraft>(key: K, v: CostDraft[K]) =>
    onChange({ ...value, [key]: v });
  const serviceMode = value.mode === 'opencost' || value.mode === 'kubecost';
  const toggleCustom = (custom: boolean) =>
    onChange({
      ...value,
      custom,
      ...(custom && !value.custom && status ? pricingDraft(status.pricing) : {}),
    });

  return (
    <div className="space-y-3">
      <Field label={i18n.t('Cost source')}>
        <div className="flex flex-wrap items-center gap-1">
          <Chip active={value.mode === 'auto'} onClick={() => set('mode', 'auto')}>
            {i18n.t('Detect automatically')}
          </Chip>
          <Chip active={value.mode === 'opencost'} onClick={() => set('mode', 'opencost')}>
            {i18n.t('OpenCost service')}
          </Chip>
          <Chip
            active={value.mode === 'kubecost'}
            onClick={() =>
              onChange({
                ...value,
                mode: 'kubecost',
                ...(value.mode !== 'kubecost' && value.service === 'opencost'
                  ? { namespace: 'kubecost', service: 'kubecost-cost-analyzer', port: '9090' }
                  : {}),
              })
            }
          >
            {i18n.t('Kubecost service')}
          </Chip>
          <Chip active={value.mode === 'estimate'} onClick={() => set('mode', 'estimate')}>
            {i18n.t('Estimate only')}
          </Chip>
          {value.mode === 'auto' && status && (
            <span className="text-fg-dim ml-2 flex items-center gap-1 text-[11px]">
              <CircleDollarSign className="text-accent/80 h-3 w-3" aria-hidden />
              {status.source !== 'estimate' && status.service
                ? i18n.t('Found {service}', { service: costServiceLabel(status.service) })
                : costSourceLabel(status.source)}
            </span>
          )}
        </div>
      </Field>
      <p className="text-fg-dim -mt-1.5 text-[11px]">
        {value.mode === 'estimate'
          ? i18n.t(
              'Costs are estimated from requests (and usage when known) with the price model below.',
            )
          : value.mode === 'auto'
            ? i18n.t(
                'Uses OpenCost or Kubecost when one is found in the cluster, otherwise an estimate from requests.',
              )
            : i18n.t(
                'Queried through the API server’s service proxy with this cluster’s credentials (needs get on services/proxy).',
              )}
      </p>
      {serviceMode && (
        <div className="grid grid-cols-[1fr_1.4fr_0.6fr] gap-3">
          <Field label={i18n.t('Namespace')}>
            <Input
              mono
              value={value.namespace}
              onChange={(e) => set('namespace', e.target.value)}
            />
          </Field>
          <Field label={i18n.t('Service')}>
            <Input mono value={value.service} onChange={(e) => set('service', e.target.value)} />
          </Field>
          <Field label={i18n.t('Port')}>
            <Input
              mono
              inputMode="numeric"
              value={value.port}
              onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
        </div>
      )}
      <Switch
        checked={value.custom}
        onChange={toggleCustom}
        label={i18n.t('Custom price model')}
        description={
          status
            ? i18n.t('Off: list prices for {platform} (an estimate).', {
                platform: costPlatformLabel(status.platform),
              })
            : i18n.t('Off: list prices of the detected platform (an estimate).')
        }
      />
      {value.custom && (
        <div className="grid grid-cols-3 gap-3">
          <Field label={i18n.t('Currency')}>
            <Input
              mono
              lang="en"
              value={value.currency}
              maxLength={3}
              onChange={(e) => set('currency', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label={i18n.t('Per vCPU-hour')}>
            <Input
              mono
              inputMode="decimal"
              value={value.cpu_hour}
              onChange={(e) => set('cpu_hour', e.target.value)}
            />
          </Field>
          <Field label={i18n.t('Per GiB-hour')}>
            <Input
              mono
              inputMode="decimal"
              value={value.memory_gib_hour}
              onChange={(e) => set('memory_gib_hour', e.target.value)}
            />
          </Field>
          <Field label={i18n.t('Per GPU-hour')} hint={i18n.t('Empty: not priced')}>
            <Input
              mono
              inputMode="decimal"
              value={value.gpu_hour}
              onChange={(e) => set('gpu_hour', e.target.value)}
            />
          </Field>
          <Field label={i18n.t('Volumes per GiB-month')} hint={i18n.t('Empty: not priced')}>
            <Input
              mono
              inputMode="decimal"
              value={value.storage_gib_month}
              onChange={(e) => set('storage_gib_month', e.target.value)}
            />
          </Field>
          <Field label={i18n.t('Discount %')}>
            <Input
              mono
              inputMode="decimal"
              value={value.discount_percent}
              onChange={(e) => set('discount_percent', e.target.value)}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
