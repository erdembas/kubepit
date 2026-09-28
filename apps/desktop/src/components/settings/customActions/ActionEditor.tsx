import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Play, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { CUSTOM_ACTION_ICON } from '@/components/workbench/actions/custom/icons';
import { conflictText } from '@/components/workbench/keyboard/KeymapTables';
import { cn } from '@/lib/cn';
import {
  CUSTOM_ACTION_ICONS,
  MAX_TIMEOUT_SECS,
  PLACEHOLDERS,
  SCOPE_ANY,
  SCOPE_CLUSTER,
  sampleTarget,
  splitList,
} from '@/lib/customActions';
import { ipc } from '@/lib/ipc';
import { shortcutConflicts } from '@/lib/keymap';
import { useAppStore } from '@/store/useAppStore';
import type { CustomAction, CustomActionMode, ResolvedCustomAction } from '@/types';
import { ShortcutRecorder } from './ShortcutRecorder';

/** Scope chips offered next to the free-text scope list. */
const COMMON_SCOPES = [
  SCOPE_ANY,
  SCOPE_CLUSTER,
  'core/Pod',
  'apps/Deployment',
  'apps/StatefulSet',
  'apps/DaemonSet',
  'batch/Job',
  'batch/CronJob',
  'core/Service',
  'core/ConfigMap',
  'core/Node',
  'core/Namespace',
];

function scopeChipLabel(scope: string) {
  if (scope === SCOPE_ANY) return i18n.t('Every object');
  if (scope === SCOPE_CLUSTER) return i18n.t('Cluster');
  return scope.split('/').pop() ?? scope;
}

const MODES: Array<{
  id: CustomActionMode;
  icon: typeof Play;
  label: () => string;
  hint: () => string;
}> = [
  {
    id: 'terminal',
    icon: SquareTerminal,
    label: () => i18n.t('Terminal'),
    hint: () => i18n.t('Opens a dock terminal that runs the command through your login shell.'),
  },
  {
    id: 'background',
    icon: Play,
    label: () => i18n.t('Background'),
    hint: () => i18n.t('Runs without a terminal and shows the output when it finishes.'),
  },
  {
    id: 'open-url',
    icon: ExternalLink,
    label: () => i18n.t('Open URL'),
    hint: () => i18n.t('Opens the resolved address in your browser.'),
  },
];

/** Create / edit one custom action with a live preview of the resolved command. */
export function ActionEditor({
  initial,
  isNew,
  others,
  onSave,
  onClose,
}: {
  initial: CustomAction;
  isNew: boolean;
  /** The other actions (shortcut conflicts). */
  others: readonly CustomAction[];
  /** Resolves to an error message, or null once saved. */
  onSave: (action: CustomAction) => Promise<string | null>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [draft, setDraft] = useState<CustomAction>(initial);
  const [scopesText, setScopesText] = useState(initial.scopes.join(', '));
  const [namespacesText, setNamespacesText] = useState(initial.namespaces.join(', '));
  const [tagsText, setTagsText] = useState(initial.cluster_tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResolvedCustomAction | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const clusters = useAppStore((s) => s.clusters);
  const selectedClusterId = useAppStore((s) => s.selectedClusterId);
  const previewCluster = clusters.find((c) => c.id === selectedClusterId) ?? null;
  const allTags = useMemo(() => [...new Set(clusters.flatMap((c) => c.tags))].sort(), [clusters]);

  const set = <K extends keyof CustomAction>(key: K, value: CustomAction[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const scopes = splitList(scopesText);
  const current: CustomAction = {
    ...draft,
    scopes,
    namespaces: splitList(namespacesText),
    cluster_tags: splitList(tagsText),
  };
  const target = useMemo(
    () => sampleTarget({ scopes, command: draft.command }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopesText, draft.command],
  );

  // Live preview, debounced; the backend resolves exactly what it would run.
  const previewKey = JSON.stringify([draft.command, draft.mode, target, previewCluster?.id]);
  useEffect(() => {
    if (!draft.command.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      ipc
        .customActionResolve(current, previewCluster?.id ?? null, target)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setPreview(null);
          setPreviewError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const conflicts = shortcutConflicts([
    ...others.filter((o) => o.id !== draft.id),
    { ...current, enabled: true },
  ]).filter((c) => c.actionId === draft.id);

  const insert = (token: string) => {
    const el = commandRef.current;
    const text = draft.command;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    set('command', next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const toggleScope = (scope: string) => {
    const list = splitList(scopesText);
    const next = list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope];
    setScopesText(next.join(', '));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const message = await onSave(current);
    setSaving(false);
    if (message) setError(message);
  };

  const Icon = CUSTOM_ACTION_ICON[draft.icon as keyof typeof CUSTOM_ACTION_ICON] ?? SquareTerminal;
  const sampleLabel = target.name
    ? `${target.kind}${target.namespace ? ` ${target.namespace}/` : ' '}${target.name}`
    : i18n.t('cluster level');

  return (
    <Dialog
      title={isNew ? i18n.t('New custom action') : i18n.t('Edit custom action')}
      subtitle={draft.name || undefined}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && (
            <span
              className="text-status-error mr-auto min-w-0 truncate text-[11.5px]"
              title={error}
            >
              {error}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !draft.name.trim() || !draft.command.trim() || !scopes.length}
            onClick={() => void save()}
            leftIcon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Save')}
          </Button>
        </>
      }
    >
      <div className="@container space-y-4">
        <div className="grid gap-3 @xl:grid-cols-[1fr_auto]">
          <Field label={i18n.t('Name')}>
            <Input
              autoFocus
              value={draft.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
              placeholder={i18n.t('e.g. Tail logs with stern')}
            />
          </Field>
          <Field label={i18n.t('Enabled')}>
            <div className="flex h-8 items-center">
              <Switch bare checked={draft.enabled} onChange={(v) => set('enabled', v)} />
            </div>
          </Field>
        </div>
        <Field label={i18n.t('Description')}>
          <Input
            value={draft.description}
            maxLength={500}
            onChange={(e) => set('description', e.target.value)}
            placeholder={i18n.t('Optional; shown when asking for confirmation')}
          />
        </Field>
        <Field label={i18n.t('Icon')}>
          <div className="flex flex-wrap gap-1" role="radiogroup">
            {CUSTOM_ACTION_ICONS.map((name) => {
              const I = CUSTOM_ACTION_ICON[name];
              const active = draft.icon === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={name}
                  title={name}
                  onClick={() => set('icon', name)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md transition',
                    active ? 'bg-accent/15 text-accent' : 'text-fg-dim hover:bg-fg/8 hover:text-fg',
                  )}
                >
                  <I className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={i18n.t('Run mode')}>
          <div className="grid gap-1.5 @xl:grid-cols-3">
            {MODES.map((m) => {
              const active = draft.mode === m.id;
              const MI = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => set('mode', m.id)}
                  className={cn(
                    'rounded-app-sm flex items-start gap-2 border px-2.5 py-2 text-left transition',
                    active ? 'border-accent/60 bg-accent/8' : 'border-border hover:bg-fg/4',
                  )}
                >
                  <MI
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      active ? 'text-accent' : 'text-fg-dim',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="text-fg block text-[12px] font-medium">{m.label()}</span>
                    <span className="text-fg-dim block text-[11px] leading-snug">{m.hint()}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
        <Field
          label={draft.mode === 'open-url' ? i18n.t('URL') : i18n.t('Command')}
          hint={
            draft.mode === 'open-url'
              ? i18n.t('Values are URL-encoded.')
              : i18n.t(
                  'POSIX sh syntax, run with KUBECONFIG set to the cluster. Values are quoted for you: write placeholders without quotes.',
                )
          }
        >
          <Textarea
            ref={commandRef}
            mono
            rows={3}
            value={draft.command}
            onChange={(e) => set('command', e.target.value)}
            spellCheck={false}
            placeholder={
              draft.mode === 'open-url'
                ? 'https://grafana.example.com/d/abc?var-namespace={namespace}'
                : 'kubectl describe {resource} {name} -n {namespace}'
            }
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {PLACEHOLDERS.map((p) => (
              <button
                key={p.token}
                type="button"
                title={p.label()}
                onClick={() => insert(p.token)}
                className="border-border text-fg-muted hover:text-fg hover:bg-fg/6 rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition"
              >
                {p.token}
              </button>
            ))}
          </div>
        </Field>
        <Field
          label={i18n.t('Applies to')}
          hint={i18n.t(
            'Kinds separated by commas: Pod, apps/Deployment, argoproj.io/*, * or cluster.',
          )}
        >
          <Input mono value={scopesText} onChange={(e) => setScopesText(e.target.value)} />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {COMMON_SCOPES.map((scope) => {
              const on = scopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  onClick={() => toggleScope(scope)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] transition',
                    on ? 'bg-accent/15 text-accent' : 'text-fg-dim hover:bg-fg/8 hover:text-fg',
                  )}
                  lang={scope === SCOPE_ANY || scope === SCOPE_CLUSTER ? undefined : 'en'}
                >
                  {scopeChipLabel(scope)}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-3 @xl:grid-cols-2">
          <Field
            label={i18n.t('Namespaces')}
            hint={i18n.t('Globs such as team-*; empty = every namespace.')}
          >
            <Input
              mono
              value={namespacesText}
              onChange={(e) => setNamespacesText(e.target.value)}
            />
          </Field>
          <Field
            label={i18n.t('Cluster tags')}
            hint={
              allTags.length
                ? i18n.t('Only clusters with one of these tags ({tags}); empty = all.', {
                    tags: allTags.slice(0, 6).join(', '),
                  })
                : i18n.t('Only clusters with one of these tags; empty = all.')
            }
          >
            <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 @xl:grid-cols-2">
          <Switch
            checked={draft.confirm}
            onChange={(v) => set('confirm', v)}
            label={i18n.t('Ask before running')}
            description={i18n.t('Shows the resolved command first.')}
          />
          <Switch
            checked={draft.mutating}
            onChange={(v) => set('mutating', v)}
            label={i18n.t('Changes the cluster')}
            description={i18n.t(
              'Blocked on read-only clusters; production clusters ask to type the name.',
            )}
          />
        </div>
        <div className="grid gap-3 @xl:grid-cols-2">
          <Field label={i18n.t('Shortcut')}>
            <ShortcutRecorder value={draft.shortcut} onChange={(v) => set('shortcut', v)} />
            {conflicts.map((c) => (
              <p
                key={c.kind}
                className="text-status-starting mt-1 flex items-start gap-1 text-[11px]"
              >
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {conflictText(c)}
              </p>
            ))}
          </Field>
          {draft.mode === 'background' && (
            <Field label={i18n.t('Timeout (seconds)')}>
              <Input
                type="number"
                min={1}
                max={MAX_TIMEOUT_SECS}
                value={draft.timeout_secs}
                onChange={(e) =>
                  set(
                    'timeout_secs',
                    Math.max(
                      1,
                      Math.min(MAX_TIMEOUT_SECS, Math.floor(Number(e.target.value) || 0)),
                    ),
                  )
                }
                className="w-32 tabular-nums"
              />
            </Field>
          )}
        </div>
        <section className="border-border bg-surface-raised/40 rounded-app-sm border p-3">
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Icon className="text-accent h-3.5 w-3.5 shrink-0" />
            <h4 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {i18n.t('Preview')}
            </h4>
            <span
              className="text-fg-dim ml-auto min-w-0 truncate font-mono text-[10.5px]"
              lang="en"
            >
              {sampleLabel}
            </span>
          </div>
          {previewError ? (
            <p className="text-status-error text-[12px] break-words">{previewError}</p>
          ) : preview ? (
            <>
              <pre className="text-fg font-mono text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap">
                {preview.command}
              </pre>
              {preview.missing.length > 0 && (
                <p className="text-fg-dim mt-2 text-[11px]">
                  {i18n.t('No value on the sample: {placeholders}', {
                    placeholders: preview.missing.join(', '),
                  })}
                </p>
              )}
              {preview.unknown.length > 0 && (
                <p className="text-status-starting mt-1 text-[11px]">
                  {i18n.t('Not placeholders, kept as written: {tokens}', {
                    tokens: preview.unknown.join(', '),
                  })}
                </p>
              )}
            </>
          ) : (
            <p className="text-fg-dim text-[12px]">
              {i18n.t('Type a command to see it resolved.')}
            </p>
          )}
          <p className="text-fg-dim mt-2 text-[10.5px]">
            {previewCluster
              ? i18n.t('Sample object on {cluster}.', { cluster: previewCluster.name })
              : i18n.t('Sample object with sample cluster values.')}
          </p>
        </section>
      </div>
    </Dialog>
  );
}
