import * as i18n from '@/i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  Info,
  Loader2,
  Plus,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { KeyValue } from '@/lib/kube/wizards/encoding';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, LocalFile } from '@/types';
import { pickLocalFiles, type FilePurpose } from './files';

/** Form building blocks shared by the wizards (RunHQ look, container-query layouts). */

export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-fg-dim text-[11px] font-semibold tracking-[0.14em] uppercase">
          {title}
        </h4>
        {action && <div className="ml-auto flex flex-wrap items-center gap-1">{action}</div>}
      </div>
      {hint && <p className="text-fg-dim -mt-1 text-[11px]">{hint}</p>}
      {children}
    </section>
  );
}

/** Two columns once the form column is wide enough. */
export function FieldGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 @md:grid-cols-2', className)}>{children}</div>;
}

type NoticeTone = 'info' | 'warning' | 'error' | 'success';

const NOTICE: Record<NoticeTone, { className: string; icon: typeof Info }> = {
  info: { className: 'border-border bg-surface-raised/60 text-fg-muted', icon: Info },
  warning: {
    className: 'border-tone-warning/30 bg-tone-warning/10 text-tone-warning-fg',
    icon: AlertTriangle,
  },
  error: {
    className: 'border-tone-critical/30 bg-tone-critical/10 text-tone-critical-fg',
    icon: XCircle,
  },
  success: {
    className: 'border-tone-success/30 bg-tone-success/10 text-tone-success-fg',
    icon: CheckCircle2,
  },
};

export function Notice({
  tone = 'info',
  children,
  className,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  className?: string;
}) {
  const { className: toneClass, icon: Icon } = NOTICE[tone];
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-snug',
        toneClass,
        className,
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-status-error text-[11px]">{children}</p>;
}

/** Editable key/value rows (labels, selectors). */
export function KeyValueRows({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  keyLang = 'en',
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  keyLang?: string;
}) {
  i18n.useLocale();
  const set = (index: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            mono
            lang={keyLang}
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={keyPlaceholder}
            onChange={(e) => set(index, { key: e.target.value })}
            className="min-w-0 flex-1"
          />
          <span className="text-fg-dim text-[12px]">=</span>
          <Input
            mono
            value={row.value}
            placeholder={valuePlaceholder}
            aria-label={valuePlaceholder}
            onChange={(e) => set(index, { value: e.target.value })}
            className="min-w-0 flex-1"
          />
          <IconButton
            label={i18n.t('Remove')}
            icon={<X />}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button
        size="xs"
        variant="ghost"
        leftIcon={<Plus className="h-3 w-3" />}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * A textarea for secret values: masked (bullets) until revealed. The
 * browser never autocompletes or spell-checks it.
 */
export function SecretTextarea({
  value,
  onChange,
  revealed,
  rows = 3,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  revealed: boolean;
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <Textarea
      mono
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      onChange={(e) => onChange(e.target.value)}
      className={cn(!revealed && '[-webkit-text-security:disc]')}
    />
  );
}

/** Single-line secret input (password field until revealed). */
export function SecretField({
  value,
  onChange,
  revealed,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  revealed: boolean;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <Input
      mono
      type={revealed ? 'text' : 'password'}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoComplete="new-password"
      spellCheck={false}
      data-1p-ignore
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function RevealToggle({
  revealed,
  onToggle,
  size = 'xs',
}: {
  revealed: boolean;
  onToggle: () => void;
  size?: 'xs' | 'sm';
}) {
  i18n.useLocale();
  return (
    <IconButton
      size={size}
      label={revealed ? i18n.t('Hide value') : i18n.t('Reveal value')}
      icon={revealed ? <EyeOff /> : <Eye />}
      aria-pressed={revealed}
      onClick={onToggle}
    />
  );
}

/** A loaded file standing in for a value (content never shown). */
export function FileChip({ file, onClear }: { file: LocalFile; onClear?: () => void }) {
  i18n.useLocale();
  return (
    <div className="border-border bg-surface-raised flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px]">
      <FileText className="text-fg-dim h-3.5 w-3.5 shrink-0" />
      <span className="text-fg min-w-0 truncate font-mono" title={file.path}>
        {file.name}
      </span>
      <span className="text-fg-dim shrink-0 text-[11px] tabular-nums">
        {formatBytes(file.size)}
      </span>
      {!file.utf8 && (
        <span className="bg-fg/6 text-fg-muted shrink-0 rounded px-1 py-px text-[10px]">
          {i18n.t('binary')}
        </span>
      )}
      {onClear && (
        <IconButton
          size="xs"
          className="ml-auto"
          label={i18n.t('Remove file')}
          icon={<X />}
          onClick={onClear}
        />
      )}
    </div>
  );
}

/** "Load file…": native picker + bounded backend read. */
export function LoadFileButton({
  purpose,
  multiple = false,
  onFiles,
  label,
}: {
  purpose: FilePurpose;
  multiple?: boolean;
  onFiles: (files: LocalFile[]) => void;
  label?: string;
}) {
  i18n.useLocale();
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    setBusy(true);
    try {
      const files = await pickLocalFiles(purpose, multiple);
      if (files) onFiles(files);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      leftIcon={
        busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />
      }
      onClick={() => void pick()}
    >
      {label ?? (multiple ? i18n.t('Add files…') : i18n.t('Load file…'))}
    </Button>
  );
}

/** Target namespace picker (known names + the cluster's accessible namespaces). */
export function NamespaceSelect({
  clusterId,
  value,
  onChange,
  disabled,
}: {
  clusterId: ClusterId;
  value: string;
  onChange: (namespace: string) => void;
  disabled?: boolean;
}) {
  i18n.useLocale();
  const accessible = useAppStore(
    (s) => s.clusters.find((c) => c.id === clusterId)?.accessible_namespaces,
  );
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    ipc
      .namespaceNames(clusterId)
      .then((list) => alive && setNames(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clusterId]);
  const options = useMemo(() => {
    const all = new Set([value, ...(accessible ?? []), ...names].filter(Boolean));
    return [...all].sort().map((n) => ({ value: n, label: n }));
  }, [value, accessible, names]);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      size="md"
      disabled={disabled}
      ariaLabel={i18n.t('Namespace')}
      className="w-full font-mono"
    />
  );
}

/** "Expires in 12 days (Oct 9, 2026)" in the tone of the expiry state. */
export function ExpiryLine({
  notAfter,
  state,
  days,
}: {
  notAfter: number;
  state: 'expired' | 'expiring' | 'valid' | 'not-yet-valid';
  days: number;
}) {
  i18n.useLocale();
  const date = i18n.date(notAfter, { dateStyle: 'medium' });
  if (state === 'expired')
    return (
      <p className="text-status-error text-[11px]">
        {i18n.plural(
          'Expired {count} day ago ({date})',
          'Expired {count} days ago ({date})',
          Math.abs(days),
          { date },
        )}
      </p>
    );
  if (state === 'not-yet-valid')
    return <p className="text-status-starting text-[11px]">{i18n.t('Not valid yet')}</p>;
  return (
    <p
      className={
        state === 'expiring' ? 'text-status-starting text-[11px]' : 'text-fg-dim text-[11px]'
      }
    >
      {i18n.plural('Expires in {count} day ({date})', 'Expires in {count} days ({date})', days, {
        date,
      })}
    </p>
  );
}
