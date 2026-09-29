import * as i18n from '@/i18n';
import { Layers } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { agentEffortLevels } from '@/lib/ai/agentEffort';
import { effortLabel } from '@/lib/ai/agentModelOptions';

/** The RunHQ effort bars, backed by the model's advertised levels only. */
function EffortBars({ filled, count }: { filled: number; count: number }) {
  return (
    <span aria-hidden="true" className="inline-flex h-3.5 shrink-0 items-end gap-[2px]">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={`w-[2px] rounded-[1px] ${index < filled ? 'bg-current' : 'bg-fg/15'}`}
          style={{ height: `${4 + (index * 10) / Math.max(1, count - 1)}px` }}
        />
      ))}
    </span>
  );
}

export function AgentEffortPicker({
  efforts,
  value,
  defaultEffort,
  variant,
  label,
  disabled,
  compact,
  onChange,
}: {
  efforts: string[];
  value: string | null;
  defaultEffort: string | null;
  variant: boolean;
  label: string;
  disabled?: boolean;
  compact: boolean;
  onChange: (value: string | null) => void;
}) {
  i18n.useLocale();
  const { ordered, levels } = agentEffortLevels(efforts);
  const current = value ?? '';
  const icon = (level: string) => {
    const effective = level || defaultEffort || '';
    return ordered && !variant ? (
      <EffortBars
        count={levels.length}
        filled={effective === 'none' ? 0 : levels.indexOf(effective) + 1}
      />
    ) : (
      <Layers aria-hidden="true" className="h-3.5 w-3.5" />
    );
  };
  return (
    <SearchableSelect
      label={label}
      value={current}
      onChange={(next) => onChange(next || null)}
      disabled={disabled}
      compact={compact}
      searchable={false}
      className="w-full"
      menuWidth={240}
      leading={icon(current)}
      renderOptionLeading={(option) => icon(option.value)}
      options={[
        {
          value: '',
          label: defaultEffort
            ? i18n.t('Default ({value})', { value: effortLabel(defaultEffort) })
            : i18n.t('Agent default'),
        },
        ...levels.map((level) => ({ value: level, label: effortLabel(level) })),
        ...(current && !levels.includes(current)
          ? [{ value: current, label: current, disabled: true }]
          : []),
      ]}
    />
  );
}
