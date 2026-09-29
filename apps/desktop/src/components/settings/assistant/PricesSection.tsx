import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PRICE_FIELDS, type SettingsIssue } from '@/lib/ai/settingsIssues';
import type { AiPrice } from '@/types';
import { SettingsSection } from '../SettingsView';
import { Field } from './Fields';

export function PricesSection({
  prices,
  issues,
  onChange,
}: {
  prices: AiPrice[];
  issues: SettingsIssue[];
  onChange: (prices: AiPrice[]) => void;
}) {
  i18n.useLocale();
  const names = {
    input_per_mtok: i18n.t('Input per million tokens'),
    output_per_mtok: i18n.t('Output per million tokens'),
    cache_write_per_mtok: i18n.t('Cache write per million tokens'),
    cache_read_per_mtok: i18n.t('Cache read per million tokens'),
  };
  const update = (index: number, patch: Partial<AiPrice>) =>
    onChange(prices.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <SettingsSection
      title={i18n.t('Model prices')}
      description={i18n.t(
        'Prices are not built in and may change. Enter USD per million tokens. Without a price, only usage is shown. Empty cache prices use the input price.',
      )}
      trailing={
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange([
              ...prices,
              {
                model: '',
                input_per_mtok: 0,
                output_per_mtok: 0,
                cache_write_per_mtok: null,
                cache_read_per_mtok: null,
              },
            ])
          }
        >
          {i18n.t('Add price')}
        </Button>
      }
    >
      <div className="space-y-3">
        {prices.map((price, index) => (
          <div key={index} className="border-border/70 rounded-md border p-3">
            <div className="mb-3 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Field label={i18n.t('Model')} issues={issues} field={`prices.${index}.model`}>
                  <Input
                    value={price.model}
                    aria-label={i18n.t('Model price id')}
                    onChange={(e) => update(index, { model: e.target.value })}
                  />
                </Field>
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onChange(prices.filter((_, i) => i !== index))}
              >
                {i18n.t('Remove')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 @min-[460px]:grid-cols-2">
              {PRICE_FIELDS.map((field) => (
                <Field
                  key={field}
                  label={names[field]}
                  issues={issues}
                  field={`prices.${index}.${field}`}
                >
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={Number.isNaN(price[field]) ? '' : (price[field] ?? '')}
                    aria-label={names[field]}
                    onChange={(e) =>
                      update(index, {
                        [field]:
                          e.target.value === ''
                            ? field === 'cache_write_per_mtok' || field === 'cache_read_per_mtok'
                              ? null
                              : Number.NaN
                            : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
        ))}
        {prices.length === 0 && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('No prices configured. Usage is shown in tokens.')}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
