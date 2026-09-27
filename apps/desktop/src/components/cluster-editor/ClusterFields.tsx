import * as i18n from '@/i18n';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { TagChip } from '@/components/ui/TagChip';
import { CLUSTER_COLORS, ENVIRONMENTS, allTags } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { sectionColor } from '@/lib/sectionColors';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterEnvironment } from '@/types';
import { Field } from './Field';

export interface ClusterFieldValues {
  name: string;
  tags: string[];
  environment: ClusterEnvironment | null;
  color: string | null;
  sectionId: string | null;
  default_namespace: string;
  /** Comma/space separated in the form; split on save. */
  accessible_namespaces: string;
  read_only: boolean;
  notes: string;
}

/** Shared metadata form used by the add/edit dialog and bulk import. */
export function ClusterFields({
  value,
  onChange,
}: {
  value: ClusterFieldValues;
  onChange: (next: ClusterFieldValues | ((prev: ClusterFieldValues) => ClusterFieldValues)) => void;
}) {
  i18n.useLocale();
  const sections = useAppStore((s) => s.sections);
  const clusters = useAppStore((s) => s.clusters);
  const set = <K extends keyof ClusterFieldValues>(key: K, v: ClusterFieldValues[K]) =>
    onChange((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label={i18n.t('Display name')}>
        <Input value={value.name} onChange={(e) => set('name', e.target.value)} autoFocus />
      </Field>
      <Field label={i18n.t('Section')}>
        <Select
          size="md"
          value={value.sectionId ?? ''}
          onChange={(v) => set('sectionId', v || null)}
          options={[
            { value: '', label: i18n.t('Unassigned') },
            ...sections.map((s) => ({
              value: s.id,
              label: s.name,
              color: sectionColor(s.color).solid,
            })),
          ]}
        />
      </Field>
      <Field label={i18n.t('Environment')}>
        <div className="flex flex-wrap gap-1">
          <EnvChip active={value.environment == null} onClick={() => set('environment', null)}>
            {i18n.t('None')}
          </EnvChip>
          {ENVIRONMENTS.map((env) => (
            <EnvChip
              key={env.key}
              active={value.environment === env.key}
              onClick={() => set('environment', env.key)}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', env.dot)} />
              {env.label}
            </EnvChip>
          ))}
        </div>
      </Field>
      <Field label={i18n.t('Color')}>
        <div className="flex h-8 items-center gap-1.5">
          {CLUSTER_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              onClick={() => set('color', value.color === color ? null : color)}
              className="flex h-5 w-5 items-center justify-center rounded-full transition hover:scale-110"
              style={{
                backgroundColor: color,
                boxShadow:
                  value.color === color
                    ? `0 0 0 2px rgb(var(--surface-overlay)), 0 0 0 3.5px ${color}`
                    : undefined,
              }}
            >
              {value.color === color && (
                <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
              )}
            </button>
          ))}
        </div>
      </Field>
      <div className="col-span-2">
        <Field
          label={i18n.t('Tags')}
          hint={i18n.t('Press Enter or comma to add. Used for filtering and grouping.')}
        >
          <TagInput
            value={value.tags}
            suggestions={allTags(clusters)}
            onChange={(tags) => set('tags', tags)}
          />
        </Field>
      </div>
      <Field label={i18n.t('Default namespace')} hint={i18n.t('Empty = all namespaces')}>
        <Input
          mono
          value={value.default_namespace}
          placeholder="default"
          onChange={(e) => set('default_namespace', e.target.value)}
        />
      </Field>
      <Field
        label={i18n.t('Accessible namespaces')}
        hint={i18n.t('For restricted RBAC where listing namespaces is forbidden.')}
      >
        <Input
          mono
          value={value.accessible_namespaces}
          placeholder="team-a, team-b"
          onChange={(e) => set('accessible_namespaces', e.target.value)}
        />
      </Field>
      <div className="col-span-2">
        <Field label={i18n.t('Notes')}>
          <textarea
            value={value.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
            placeholder={i18n.t('Runbooks, owners, VPN reminders…')}
            className="border-border bg-surface-raised text-fg focus:border-accent rounded-app-sm placeholder:text-fg-dim w-full resize-y border px-2.5 py-1.5 text-[12px] outline-none"
          />
        </Field>
      </div>
    </div>
  );
}

function EnvChip({
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

export function TagInput({
  value,
  suggestions,
  onChange,
}: {
  value: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  i18n.useLocale();
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const tag = raw.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
  };
  const open = suggestions.filter(
    (s) => !value.includes(s) && (!draft || s.includes(draft.toLowerCase())),
  );
  return (
    <div>
      <div className="border-border bg-surface-raised focus-within:border-accent rounded-app-sm flex min-h-8 flex-wrap items-center gap-1 border px-1.5 py-1">
        {value.map((tag) => (
          <TagChip key={tag} tag={tag} onRemove={() => onChange(value.filter((t) => t !== tag))} />
        ))}
        <input
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            if (next.endsWith(',')) add(next.slice(0, -1));
            else setDraft(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={value.length ? '' : i18n.t('e.g. aws, eu, payments')}
          className="text-fg placeholder:text-fg-dim min-w-24 flex-1 bg-transparent px-1 text-[12px] outline-none"
        />
      </div>
      {open.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {open.slice(0, 10).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              className="text-fg-dim hover:text-fg hover:bg-fg/5 rounded px-1.5 py-0.5 text-[10.5px]"
            >
              +#{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
