import * as i18n from '@/i18n';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import type { AiLocale } from '@/types';

export function ResponseLanguageSelect({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: AiLocale | null;
  onChange: (value: AiLocale | null) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  i18n.useLocale();
  return (
    <div className="min-w-0">
      <span className="text-fg-dim mb-1 block text-[11px] font-medium tracking-wider uppercase">
        {i18n.t('Response language')}
      </span>
      <SearchableSelect
        label={i18n.t('Response language')}
        value={value ?? ''}
        onChange={(language) => onChange(language ? (language as AiLocale) : null)}
        disabled={disabled}
        compact={compact}
        className="w-full"
        options={[
          { value: '', label: i18n.t('Follow app language') },
          { value: 'en', label: i18n.t('English') },
          { value: 'tr', label: i18n.t('Turkish') },
          { value: 'de', label: i18n.t('German') },
          { value: 'fr', label: i18n.t('French') },
          { value: 'es', label: i18n.t('Spanish') },
          { value: 'it', label: i18n.t('Italian') },
          { value: 'pt', label: i18n.t('Portuguese') },
          { value: 'ru', label: i18n.t('Russian') },
          { value: 'ar', label: i18n.t('Arabic') },
          { value: 'hi', label: i18n.t('Hindi') },
          { value: 'ja', label: i18n.t('Japanese') },
          { value: 'ko', label: i18n.t('Korean') },
          { value: 'zh', label: i18n.t('Chinese') },
        ]}
      />
    </div>
  );
}
