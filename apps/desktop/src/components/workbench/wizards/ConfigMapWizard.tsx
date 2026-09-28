import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { formatBytes } from '@/lib/format';
import {
  buildConfigMap,
  configMapBlocked,
  configMapDefaults,
  entrySize,
  keyForFile,
  parseEnvFile,
  validateConfigMap,
  type ConfigEntry,
  type ConfigMapInput,
} from '@/lib/kube/wizards/configmap';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import { useAppStore } from '@/store/useAppStore';
import type { LocalFile } from '@/types';
import { GVK } from './data';
import {
  FieldError,
  FieldGrid,
  FileChip,
  KeyValueRows,
  LoadFileButton,
  NamespaceSelect,
  Notice,
  Section,
} from './fields';
import { localFileText } from './files';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

/** `kubectl create configmap --from-literal | --from-file | --from-env-file`. */
export function ConfigMapWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'configmap' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const pushToast = useAppStore((s) => s.pushToast);
  const [input, setInput] = useState<ConfigMapInput>(() => configMapDefaults(request.namespace));
  const patch = (p: Partial<ConfigMapInput>) => setInput((s) => ({ ...s, ...p }));
  const errors = useMemo(() => validateConfigMap(input), [input]);
  const yaml = useMemo(() => manifestYaml([buildConfigMap(input)]), [input]);
  const entries = input.entries;
  const set = (index: number, next: Partial<ConfigEntry>) =>
    patch({ entries: entries.map((e, i) => (i === index ? { ...e, ...next } : e)) });
  const kept = () => entries.filter((e) => e.key.trim() || e.value.kind === 'file' || e.value.text);

  // Text files become editable values; binary files stay files (binaryData).
  const addFiles = (files: LocalFile[]) =>
    patch({
      entries: [
        ...kept(),
        ...files.map((file): ConfigEntry => {
          const text = localFileText(file);
          return {
            key: keyForFile(file.name),
            value: text === null ? { kind: 'file', file } : { kind: 'text', text },
          };
        }),
      ],
    });
  const importEnv = (files: LocalFile[]) => {
    const file = files[0];
    const text = file ? localFileText(file) : null;
    if (!file || text === null) {
      pushToast('error', i18n.t('The .env file is not UTF-8 text.'));
      return;
    }
    const parsed = parseEnvFile(text);
    const keys = new Set(parsed.entries.map((e) => e.key));
    patch({
      entries: [
        ...kept().filter((e) => !keys.has(e.key.trim())),
        ...parsed.entries.map((e): ConfigEntry => ({
          key: e.key,
          value: { kind: 'text', text: e.value },
        })),
      ],
    });
    pushToast(
      parsed.invalid.length ? 'info' : 'success',
      parsed.invalid.length
        ? i18n.plural(
            'Imported {count} key; skipped lines {lines}',
            'Imported {count} keys; skipped lines {lines}',
            parsed.entries.length,
            { lines: parsed.invalid.join(', ') },
          )
        : i18n.plural('Imported {count} key', 'Imported {count} keys', parsed.entries.length),
    );
  };

  return (
    <WizardShell
      request={request}
      title={i18n.t('Create ConfigMap')}
      subtitle="kubectl create configmap"
      yaml={yaml}
      namespace={input.namespace}
      blocked={configMapBlocked(errors)}
      errors={errors}
      creates={[{ gvk: GVK.configMap, namespace: input.namespace }]}
      onClose={onClose}
    >
      <FieldGrid>
        <Field label={i18n.t('Name')} error={input.name ? errors.name : null}>
          <Input
            mono
            autoFocus
            value={input.name}
            placeholder="app-config"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            onChange={(namespace) => patch({ namespace })}
          />
        </Field>
      </FieldGrid>

      <Section
        title={i18n.t('Data')}
        hint={i18n.t('Each file becomes one key; files that are not UTF-8 text go to binaryData.')}
        action={
          <>
            <LoadFileButton purpose="any" multiple onFiles={addFiles} />
            <LoadFileButton purpose="env" onFiles={importEnv} label={i18n.t('Import .env…')} />
          </>
        }
      >
        <div className="space-y-2.5">
          {entries.map((entry, index) => (
            <div key={index} className="border-border/70 space-y-1.5 rounded-lg border p-2.5">
              <div className="flex items-center gap-1.5">
                <Input
                  mono
                  lang="en"
                  value={entry.key}
                  placeholder={i18n.t('Key')}
                  aria-label={i18n.t('Key')}
                  onChange={(e) => set(index, { key: e.target.value })}
                  className="min-w-0 flex-1"
                />
                <LoadFileButton
                  purpose="any"
                  label={i18n.t('File…')}
                  onFiles={([file]) => {
                    if (!file) return;
                    const text = localFileText(file);
                    set(index, {
                      key: entry.key.trim() ? entry.key : keyForFile(file.name),
                      value: text === null ? { kind: 'file', file } : { kind: 'text', text },
                    });
                  }}
                />
                <IconButton
                  label={i18n.t('Remove key')}
                  icon={<X />}
                  onClick={() => patch({ entries: entries.filter((_, i) => i !== index) })}
                />
              </div>
              {entry.value.kind === 'file' ? (
                <FileChip
                  file={entry.value.file}
                  onClear={() => set(index, { value: { kind: 'text', text: '' } })}
                />
              ) : (
                <Textarea
                  mono
                  rows={entry.value.text.includes('\n') ? 5 : 2}
                  value={entry.value.text}
                  placeholder={i18n.t('Value')}
                  aria-label={i18n.t('Value of {key}', { key: entry.key || '…' })}
                  spellCheck={false}
                  onChange={(e) => set(index, { value: { kind: 'text', text: e.target.value } })}
                />
              )}
              <div className="flex items-center justify-between gap-2">
                <FieldError>
                  {entry.key || entries.length > 1 ? errors.entries[index] : null}
                </FieldError>
                <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
                  {formatBytes(entrySize(entry.value))}
                </span>
              </div>
            </div>
          ))}
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Plus className="h-3 w-3" />}
            onClick={() =>
              patch({ entries: [...entries, { key: '', value: { kind: 'text', text: '' } }] })
            }
          >
            {i18n.t('Add key')}
          </Button>
        </div>
      </Section>
      {errors.general && <Notice tone="error">{errors.general}</Notice>}

      <Section title={i18n.t('Options')}>
        <KeyValueRows
          rows={input.labels}
          onChange={(labels) => patch({ labels })}
          keyPlaceholder={i18n.t('Label key')}
          valuePlaceholder={i18n.t('Value')}
          addLabel={i18n.t('Add label')}
        />
        <FieldError>{errors.labels}</FieldError>
        <Switch
          checked={input.immutable}
          onChange={(immutable) => patch({ immutable })}
          label={i18n.t('Immutable')}
          description={i18n.t('Values cannot be changed later; replace the ConfigMap instead.')}
        />
      </Section>
    </WizardShell>
  );
}
