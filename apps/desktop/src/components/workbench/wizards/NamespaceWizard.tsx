import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import {
  buildNamespace,
  LIMIT_PRESETS,
  namespaceBlocked,
  namespaceDefaults,
  PSS_LEVELS,
  PSS_MODES,
  QUOTA_PRESETS,
  SIZE_PRESETS,
  validateNamespace,
  type NamespaceInput,
  type PssLevel,
  type PssMode,
  type SizePreset,
} from '@/lib/kube/wizards/namespace';
import { GVK, useLiveList } from './data';
import { FieldError, KeyValueRows, Notice, Section } from './fields';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

function modeLabel(mode: PssMode): string {
  if (mode === 'enforce') return i18n.t('Enforce');
  if (mode === 'audit') return i18n.t('Audit');
  return i18n.t('Warn');
}

function modeHint(mode: PssMode): string {
  if (mode === 'enforce') return i18n.t('Violating pods are rejected.');
  if (mode === 'audit') return i18n.t('Violations are recorded in the audit log.');
  return i18n.t('Users see a warning; pods are admitted.');
}

function presetLabel(preset: SizePreset): string {
  switch (preset) {
    case 'none':
      return i18n.t('None');
    case 'small':
      return i18n.t('Small');
    case 'medium':
      return i18n.t('Medium');
    case 'large':
      return i18n.t('Large');
  }
}

/** `kubectl create namespace` + Pod Security Standards labels + quota / limit presets. */
export function NamespaceWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'namespace' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [input, setInput] = useState<NamespaceInput>(namespaceDefaults);
  const patch = (p: Partial<NamespaceInput>) => setInput((s) => ({ ...s, ...p }));
  const live = useLiveList(request.clusterId, GVK.namespace, null);
  const existing = useMemo(() => live.items.map((n) => n.metadata.name), [live.items]);
  const errors = useMemo(() => validateNamespace(input, existing), [input, existing]);
  const objects = useMemo(() => buildNamespace(input), [input]);
  const yaml = useMemo(() => manifestYaml(objects), [objects]);
  const levelOptions = [
    { value: '', label: i18n.t('Not set') },
    ...PSS_LEVELS.map((l) => ({ value: l, label: l })),
  ];
  const presetOptions = SIZE_PRESETS.map((p) => ({ value: p, label: presetLabel(p) }));
  const creates = [
    { gvk: GVK.namespace, namespace: null },
    ...(input.quota !== 'none' ? [{ gvk: GVK.resourceQuota, namespace: input.name || null }] : []),
    ...(input.limits !== 'none' ? [{ gvk: GVK.limitRange, namespace: input.name || null }] : []),
  ];

  return (
    <WizardShell
      request={request}
      title={i18n.t('Create Namespace')}
      subtitle="kubectl create namespace"
      yaml={yaml}
      namespace={null}
      blocked={namespaceBlocked(errors)}
      errors={errors}
      creates={creates}
      onClose={onClose}
    >
      <Field label={i18n.t('Name')} error={input.name ? (errors.name ?? errors.exists) : null}>
        <Input
          mono
          autoFocus
          value={input.name}
          placeholder="team-payments"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      <Section
        title={i18n.t('Pod Security Standards')}
        hint={i18n.t(
          'Admission levels for pods in this namespace; "restricted" follows current hardening best practices.',
        )}
      >
        <div className="grid gap-3 @md:grid-cols-3">
          {PSS_MODES.map((mode) => (
            <Field key={mode} label={modeLabel(mode)} hint={modeHint(mode)}>
              <Select<string>
                value={input.pss[mode]}
                onChange={(level) => patch({ pss: { ...input.pss, [mode]: level as PssLevel } })}
                options={levelOptions}
                size="md"
                ariaLabel={modeLabel(mode)}
                className="w-full"
              />
            </Field>
          ))}
        </div>
      </Section>

      <Section title={i18n.t('Resource limits')}>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field
            label={<span lang="en">ResourceQuota</span>}
            hint={i18n.t('Caps the total requests, limits and object counts.')}
          >
            <Select<string>
              value={input.quota}
              onChange={(quota) => patch({ quota: quota as SizePreset })}
              options={presetOptions}
              size="md"
              ariaLabel="ResourceQuota"
              className="w-full"
            />
          </Field>
          <Field
            label={<span lang="en">LimitRange</span>}
            hint={i18n.t('Default requests and limits for containers that set none.')}
          >
            <Select<string>
              value={input.limits}
              onChange={(limits) => patch({ limits: limits as SizePreset })}
              options={presetOptions}
              size="md"
              ariaLabel="LimitRange"
              className="w-full"
            />
          </Field>
        </div>
        {input.quota !== 'none' && (
          <PresetTable
            title={i18n.t('Quota')}
            rows={Object.entries(QUOTA_PRESETS[input.quota])}
            identifierKeys
          />
        )}
        {input.limits !== 'none' && (
          <PresetTable
            title={i18n.rich('{kind} defaults', { kind: <span lang="en">Container</span> })}
            rows={[
              [
                i18n.t('Default request'),
                `cpu ${LIMIT_PRESETS[input.limits].defaultRequest.cpu}, memory ${LIMIT_PRESETS[input.limits].defaultRequest.memory}`,
              ],
              [
                i18n.t('Default limit'),
                `cpu ${LIMIT_PRESETS[input.limits].default.cpu}, memory ${LIMIT_PRESETS[input.limits].default.memory}`,
              ],
              [
                i18n.t('Maximum'),
                `cpu ${LIMIT_PRESETS[input.limits].max.cpu}, memory ${LIMIT_PRESETS[input.limits].max.memory}`,
              ],
            ]}
          />
        )}
        {(input.quota !== 'none' || input.limits !== 'none') && (
          <Notice>
            {i18n.t(
              'The namespace is created first; the review shows the other objects as new because their namespace does not exist yet.',
            )}
          </Notice>
        )}
      </Section>

      <Section title={i18n.t('Labels')}>
        <KeyValueRows
          rows={input.labels}
          onChange={(labels) => patch({ labels })}
          keyPlaceholder={i18n.t('Label key')}
          valuePlaceholder={i18n.t('Value')}
          addLabel={i18n.t('Add label')}
        />
        <FieldError>{errors.labels}</FieldError>
      </Section>
    </WizardShell>
  );
}

function PresetTable({
  title,
  rows,
  identifierKeys = false,
}: {
  title: ReactNode;
  rows: Array<[string, string]>;
  /** Keys are Kubernetes identifiers (untranslated, monospace). */
  identifierKeys?: boolean;
}) {
  return (
    <div className="border-border/70 rounded-lg border px-3 py-2">
      <p className="text-fg-dim mb-1 text-[10.5px] font-semibold tracking-[0.14em] uppercase">
        {title}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[11.5px]">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt
              className={identifierKeys ? 'text-fg-muted font-mono' : 'text-fg-muted'}
              lang={identifierKeys ? 'en' : undefined}
            >
              {key}
            </dt>
            <dd className="text-fg truncate font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
