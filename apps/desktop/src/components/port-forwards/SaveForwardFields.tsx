import * as i18n from '@/i18n';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';

export interface SaveForwardValues {
  save: boolean;
  label: string;
  startOnConnect: boolean;
}

/** "Save this forward" block of the start-forward dialog. */
export function SaveForwardFields({
  value,
  onChange,
  placeholder,
  alreadySaved,
}: {
  value: SaveForwardValues;
  onChange: (next: SaveForwardValues) => void;
  placeholder: string;
  alreadySaved: boolean;
}) {
  i18n.useLocale();
  return (
    <div className="border-border/60 space-y-3 border-t pt-4">
      <Switch
        checked={value.save}
        onChange={(save) => onChange({ ...value, save })}
        label={i18n.t('Save this forward')}
        description={
          alreadySaved
            ? i18n.t('This target is saved. Turn off to forget it.')
            : i18n.t('Keep it in the port forward list to start it again with one click.')
        }
      />
      {value.save && (
        <div className="space-y-3 pl-0.5">
          <Input
            value={value.label}
            placeholder={placeholder}
            aria-label={i18n.t('Label')}
            onChange={(e) => onChange({ ...value, label: e.target.value })}
          />
          <Switch
            checked={value.startOnConnect}
            onChange={(startOnConnect) => onChange({ ...value, startOnConnect })}
            label={i18n.t('Start when the cluster connects')}
          />
        </div>
      )}
    </div>
  );
}
