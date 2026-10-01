import * as i18n from '@/i18n';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  Lock,
  Pencil,
  PencilOff,
  Plus,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { asObject, asString, field } from '@/lib/kube/accessors';
import {
  DATA_FORMATS,
  dataFormat,
  decodeBase64Text,
  detectDataFormat,
  encodeBase64,
  formatDataPreview,
  isValidDataKey,
  validateData,
  type DataFormat,
  type DataFormatId,
} from '@/lib/kube/dataFormat';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { modChord } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import type { Gvk, KubeObject } from '@/types';
import { InlineCodeEditor, PlainTextEditor } from '../../common/InlineCodeEditor';
import { scrollParent } from '../../util';
import { CodeBlock, CopyButton, Section } from '../primitives';
import { applyReviewedConfig } from '../../config-impact/actions';
import {
  ConfigImpactDialog,
  type ConfigImpactRequest,
} from '../../config-impact/ConfigImpactDialog';

/**
 * Editable `data` of a ConfigMap or Secret (Lens-style): short values are
 * inputs (masked for Secrets), files open in an editor picked from the key
 * name / content. Edits collect into one draft saved as a merge patch of the
 * changed keys only.
 */

interface Entry {
  key: string;
  /** As stored in the object (base64 for Secret data). */
  raw: string;
  /** Editable text; null for binary values. */
  text: string | null;
  bytes: number;
  /** ConfigMap `binaryData`. */
  binaryField: boolean;
}

interface Edit {
  /** `raw` when editing started, to spot changes made in the cluster meanwhile. */
  base: string;
  value: string;
}

interface NewEntry {
  id: string;
  key: string;
  value: string;
}

interface Draft {
  edits: Record<string, Edit>;
  /** Key → `raw` when removal was requested. */
  removed: Record<string, string>;
  added: NewEntry[];
}

const EMPTY: Draft = { edits: {}, removed: {}, added: [] };

/** Single-line values up to this length are plain inputs in ConfigMaps. */
const INLINE_MAX = 160;

function base64Bytes(raw: string): number {
  const pad = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - pad);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readEntries(obj: KubeObject, secret: boolean): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const [key, v] of Object.entries(asObject(field(obj, 'data')))) {
    const raw = asString(v);
    out.set(
      key,
      secret
        ? { key, raw, text: decodeBase64Text(raw), bytes: base64Bytes(raw), binaryField: false }
        : { key, raw, text: raw, bytes: utf8Bytes(raw), binaryField: false },
    );
  }
  if (!secret)
    for (const [key, v] of Object.entries(asObject(field(obj, 'binaryData')))) {
      const raw = asString(v);
      out.set(key, { key, raw, text: null, bytes: base64Bytes(raw), binaryField: true });
    }
  // Byte order, like the API server's YAML.
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function DataEditor({
  obj,
  gvk,
  clusterId,
  readOnly,
  secret = false,
  isActive = true,
}: {
  obj: KubeObject;
  gvk: Gvk;
  clusterId: string;
  readOnly: boolean;
  secret?: boolean;
  isActive?: boolean;
}) {
  i18n.useLocale();
  const [draft, setDraftState] = useState<Draft>(EMPTY);
  // Cmd+S can fire before React re-renders after the last keystroke.
  const draftRef = useRef(draft);
  const setDraft = (update: (d: Draft) => Draft) => {
    draftRef.current = update(draftRef.current);
    setDraftState(draftRef.current);
  };
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [syntax, setSyntax] = useState<Record<string, DataFormatId>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<ConfigImpactRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKeyErrors, setShowKeyErrors] = useState(false);
  // The patch response, shown until the watch delivers a newer version.
  const [latest, setLatest] = useState<{ obj: KubeObject; from: string | undefined } | null>(null);
  const savingRef = useRef(false);

  const source = latest && latest.from === obj.metadata.resourceVersion ? latest.obj : obj;
  const entries = useMemo(() => readEntries(source, secret), [source, secret]);
  const immutable = field(source, 'immutable') === true;
  const editable = !readOnly && !immutable;
  const name = obj.metadata.name;

  const changedKeys = Object.keys(draft.edits).filter((k) => {
    const e = entries.get(k);
    return !!e && !draft.removed[k] && draft.edits[k]!.value !== e.text;
  });
  const removedKeys = Object.keys(draft.removed).filter((k) => entries.has(k));
  const dirtyCount = changedKeys.length + removedKeys.length + draft.added.length;
  /** A pending change whose key also changed in the cluster meanwhile. */
  const conflictOf = (key: string) => {
    const base =
      draft.removed[key] ?? (changedKeys.includes(key) ? draft.edits[key]!.base : undefined);
    const e = entries.get(key);
    return base !== undefined && !!e && base !== e.raw;
  };

  const keyProblem = (item: NewEntry): string | null => {
    if (!item.key) return i18n.t('Key is required');
    if (!isValidDataKey(item.key))
      return i18n.t('Keys may only contain letters, digits, "-", "_" and "."');
    const taken =
      (entries.has(item.key) && !draft.removed[item.key]) ||
      draft.added.some((a) => a.id !== item.id && a.key === item.key);
    return taken ? i18n.t('Key "{key}" already exists', { key: item.key }) : null;
  };

  const setValue = (key: string, value: string) => {
    const e = entries.get(key);
    if (!e) return;
    setDraft((d) => {
      const base = d.edits[key]?.base ?? e.raw;
      const edits = { ...d.edits };
      if (value === e.text && base === e.raw) delete edits[key];
      else edits[key] = { base, value };
      return { ...d, edits };
    });
  };
  const dropEdit = (key: string) =>
    setDraft((d) => {
      const edits = { ...d.edits };
      delete edits[key];
      return { ...d, edits };
    });
  const remove = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    setDraft((d) => ({ ...d, removed: { ...d.removed, [key]: d.edits[key]?.base ?? e.raw } }));
    setOpen((o) => ({ ...o, [key]: false }));
  };
  const unremove = (key: string) =>
    setDraft((d) => {
      const removed = { ...d.removed };
      delete removed[key];
      return { ...d, removed };
    });
  const addEntry = () => {
    setDraft((d) => ({
      ...d,
      added: [...d.added, { id: crypto.randomUUID(), key: '', value: '' }],
    }));
    setShowKeyErrors(false);
  };
  const updateNew = (id: string, patch: Partial<NewEntry>) =>
    setDraft((d) => ({
      ...d,
      added: d.added.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  const dropNew = (id: string) =>
    setDraft((d) => ({ ...d, added: d.added.filter((a) => a.id !== id) }));
  const discard = () => {
    setDraft(() => EMPTY);
    setOpen({});
    setError(null);
    setShowKeyErrors(false);
  };

  const save = async () => {
    const d = draftRef.current;
    if (!editable || savingRef.current || impact) return;
    const changed = Object.keys(d.edits).filter((k) => {
      const e = entries.get(k);
      return !!e && !d.removed[k] && d.edits[k]!.value !== e.text;
    });
    const gone = Object.keys(d.removed).filter((k) => entries.has(k));
    if (!changed.length && !gone.length && !d.added.length) return;
    if (d.added.some((a) => keyProblem(a))) {
      setShowKeyErrors(true);
      setError(i18n.t('Fix the highlighted keys before saving.'));
      return;
    }
    const encode = (text: string) => (secret ? encodeBase64(text) : text);
    const data: Record<string, string | null> = Object.create(null);
    const binaryData: Record<string, null> = Object.create(null);
    for (const k of gone) {
      if (entries.get(k)!.binaryField) binaryData[k] = null;
      else data[k] = null;
    }
    for (const k of changed) data[k] = encode(d.edits[k]!.value);
    for (const a of d.added) data[a.key] = encode(a.value);
    const patch: Record<string, unknown> = { data };
    if (Object.keys(binaryData).length) patch.binaryData = binaryData;

    // Freeze the reviewed identity, version and draft. Watch updates during the
    // review must not silently become the base of a stale overwrite.
    const reviewed = source;
    const run = () => {
      setImpact({
        obj: reviewed,
        changes: [
          ...changed.map((key) => ({ key, operation: 'changed' as const })),
          ...gone
            .filter((key) => !d.added.some((item) => item.key === key))
            .map((key) => ({ key, operation: 'removed' as const })),
          ...d.added.map(({ key }) => ({
            key,
            operation: entries.has(key) ? ('changed' as const) : ('added' as const),
          })),
        ],
        apply: async () => {
          savingRef.current = true;
          setSaving(true);
          setError(null);
          try {
            const next = await applyReviewedConfig(clusterId, gvk, reviewed, patch);
            setLatest({ obj: next, from: reviewed.metadata.resourceVersion });
            setDraft(() => EMPTY);
            setShowKeyErrors(false);
            useAppStore.getState().pushToast('success', i18n.t('Saved {name}', { name }));
            return next;
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        },
      });
    };

    const conflicts = [...changed, ...gone].filter((k) => {
      const base = d.removed[k] ?? d.edits[k]?.base;
      return base !== undefined && base !== entries.get(k)!.raw;
    });
    if (!conflicts.length) return void run();
    useAppStore.getState().requestConfirm({
      title: i18n.t('Overwrite changes from the cluster?'),
      message: i18n.plural(
        '{keys} changed in the cluster since you started editing. Saving replaces it with your version.',
        '{keys} changed in the cluster since you started editing. Saving replaces them with your version.',
        conflicts.length,
        { keys: conflicts.join(', ') },
      ),
      confirmLabel: i18n.t('Overwrite'),
      tone: 'danger',
      onConfirm: run,
    });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSave = () => void saveRef.current();

  // The sticky save bar appears on the first keystroke. Reserve its height as
  // scroll padding (caret / editor reveal honour it) and lift the field being
  // edited above it.
  const barRef = useRef<HTMLDivElement>(null);
  const showBar = dirtyCount > 0 || !!error;
  useLayoutEffect(() => {
    const bar = barRef.current;
    const scroller = bar && scrollParent(bar);
    if (!showBar || !bar || !scroller) return;
    const previous = scroller.style.scrollPaddingBottom;
    scroller.style.scrollPaddingBottom = `${bar.offsetHeight + 8}px`;
    const active = document.activeElement;
    if (active instanceof HTMLElement && bar.parentElement?.contains(active)) {
      const overlap = active.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8;
      if (overlap > 0) scroller.scrollBy({ top: overlap });
    }
    return () => {
      scroller.style.scrollPaddingBottom = previous;
    };
  }, [showBar]);

  const revealable = [...entries.values()].filter((e) => e.text !== null).map((e) => e.key);
  const allRevealed = revealable.length > 0 && revealable.every((k) => revealed[k]);

  return (
    <Section
      title={i18n.t('Data')}
      actions={
        <>
          <button
            type="button"
            onClick={() =>
              setImpact({
                obj: source,
                changes: [...entries.keys()].map((key) => ({ key, operation: 'changed' })),
              })
            }
            disabled={!isActive || saving || !!impact}
            className="text-fg-dim hover:text-fg flex items-center gap-1 px-1 text-[11px] transition disabled:opacity-50"
          >
            <GitBranch className="h-3 w-3" />
            {i18n.t('View consumers')}
          </button>
          {secret && revealable.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setRevealed(allRevealed ? {} : Object.fromEntries(revealable.map((k) => [k, true])))
              }
              className="text-fg-dim hover:text-fg flex items-center gap-1 px-1 text-[11px] transition"
            >
              {allRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {allRevealed ? i18n.t('Hide all') : i18n.t('Reveal all')}
            </button>
          )}
          {editable && (
            <button
              type="button"
              onClick={addEntry}
              className="text-accent flex items-center gap-1 px-1 text-[11px] hover:underline"
            >
              <Plus className="h-3 w-3" />
              {i18n.t('Add key')}
            </button>
          )}
        </>
      }
    >
      {immutable && (
        <p className="text-fg-dim mb-3 flex items-center gap-1.5 text-[11px]">
          <Lock className="h-3 w-3 shrink-0" />
          {i18n.t('This {kind} is immutable; its data cannot be edited.', { kind: gvk.kind })}
        </p>
      )}
      {!entries.size && !draft.added.length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('No data')}</p>
      ) : (
        <div className="space-y-4">
          {[...entries.values()].map((e) => (
            <EntryView
              key={e.key}
              entry={e}
              secret={secret}
              editable={editable}
              edit={draft.edits[e.key]}
              removed={!!draft.removed[e.key]}
              conflict={conflictOf(e.key)}
              open={!!open[e.key]}
              revealed={!!revealed[e.key]}
              syntax={syntax[e.key]}
              onChange={(v) => setValue(e.key, v)}
              onToggleOpen={() => {
                setOpen((o) => ({ ...o, [e.key]: !o[e.key] }));
                if (secret) setRevealed((r) => ({ ...r, [e.key]: true }));
              }}
              onToggleReveal={() => setRevealed((r) => ({ ...r, [e.key]: !r[e.key] }))}
              onSyntax={(id) => setSyntax((s) => ({ ...s, [e.key]: id }))}
              onRemove={() => remove(e.key)}
              onUnremove={() => unremove(e.key)}
              onUseCluster={() => dropEdit(e.key)}
              onSave={onSave}
            />
          ))}
          {draft.added.map((a, i) => (
            <NewEntryView
              key={a.id}
              item={a}
              autoFocus={i === draft.added.length - 1}
              problem={showKeyErrors || a.key ? keyProblem(a) : null}
              syntax={syntax[`new:${a.id}`]}
              onChange={(patch) => updateNew(a.id, patch)}
              onSyntax={(id) => setSyntax((s) => ({ ...s, [`new:${a.id}`]: id }))}
              onRemove={() => dropNew(a.id)}
              onSave={onSave}
            />
          ))}
        </div>
      )}
      {showBar && (
        <div
          ref={barRef}
          className="border-border/60 bg-surface/95 sticky bottom-0 z-10 -mx-4 mt-4 -mb-4 border-t px-4 py-2 backdrop-blur"
        >
          {error && (
            <p className="text-status-error mb-2 text-[11.5px] break-words whitespace-pre-wrap">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-tone-warning-fg text-[11px]">
              {dirtyCount > 0 &&
                i18n.plural('{count} unsaved change', '{count} unsaved changes', dirtyCount)}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="xs" variant="ghost" onClick={discard} disabled={saving}>
                {i18n.t('Discard')}
              </Button>
              <Button
                size="xs"
                variant="primary"
                leftIcon={
                  saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )
                }
                onClick={onSave}
                disabled={saving || dirtyCount === 0}
                title={i18n.t('Save ({shortcut})', { shortcut: modChord('S') })}
              >
                {saving ? i18n.t('Saving…') : i18n.t('Save')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {impact && (
        <ConfigImpactDialog
          clusterId={clusterId}
          request={impact}
          onClose={() => setImpact(null)}
        />
      )}
    </Section>
  );
}

function EntryAction({
  label,
  onClick,
  active,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md transition',
        active ? 'bg-fg/8 text-fg' : 'text-fg-dim hover:text-fg hover:bg-fg/8',
        tone === 'danger' && 'hover:text-status-error hover:bg-status-error/10',
      )}
    >
      {children}
    </button>
  );
}

function FormatBadge({ format }: { format: DataFormat }) {
  i18n.useLocale();
  return (
    <span className="bg-fg/5 text-fg-dim ring-border/60 shrink-0 rounded px-1 font-mono text-[9.5px] leading-4 tracking-[0.06em] uppercase ring-1">
      {format.id === 'text' ? i18n.t('Plain text') : format.label}
    </span>
  );
}

/** Editor for one value: Monaco for code formats, a textarea for plain text. */
function ValueEditor({
  keyName,
  value,
  format,
  autoFocus,
  onChange,
  onSyntax,
  onSave,
}: {
  keyName: string;
  value: string;
  format: DataFormat;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSyntax: (id: DataFormatId) => void;
  onSave: () => void;
}) {
  i18n.useLocale();
  const problem = validateData(format.id, value);
  const label = i18n.t('Value of {key}', { key: keyName || '…' });
  const options = DATA_FORMATS.map((f) => ({
    value: f.id,
    label: f.id === 'text' ? i18n.t('Plain text') : f.label,
  }));
  let pretty: string | null = null;
  if (format.id === 'json' && !problem && value.trim())
    try {
      const next = `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
      if (next !== value) pretty = next;
    } catch {
      pretty = null;
    }
  return (
    <div>
      {format.code ? (
        <InlineCodeEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          language={format.language}
          ariaLabel={label}
          autoFocus={autoFocus}
        />
      ) : (
        <PlainTextEditor
          value={value}
          onChange={onChange}
          onSave={onSave}
          ariaLabel={label}
          autoFocus={autoFocus}
        />
      )}
      <div className="mt-1 flex min-h-6 items-center gap-2 text-[11px]">
        {problem ? (
          <span
            className="text-status-error flex min-w-0 items-center gap-1 truncate"
            title={problem}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {i18n.t('Invalid {format}: {problem}', { format: format.label, problem })}
            </span>
          </span>
        ) : format.id === 'json' || format.id === 'yaml' ? (
          value.trim() && (
            <span className="text-fg-dim flex items-center gap-1">
              <Check className="text-status-running h-3 w-3" />
              {i18n.t('Valid {format}', { format: format.label })}
            </span>
          )
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {pretty !== null && (
            <button
              type="button"
              onClick={() => onChange(pretty!)}
              className="text-fg-dim hover:text-fg hover:bg-fg/8 rounded-md px-1.5 py-0.5 transition"
            >
              {i18n.t('Format')}
            </button>
          )}
          <Select
            value={format.id}
            onChange={onSyntax}
            options={options}
            ariaLabel={i18n.t('Syntax')}
            className="min-w-[104px]"
          />
        </div>
      </div>
    </div>
  );
}

function EntryView({
  entry,
  secret,
  editable,
  edit,
  removed,
  conflict,
  open,
  revealed,
  syntax,
  onChange,
  onToggleOpen,
  onToggleReveal,
  onSyntax,
  onRemove,
  onUnremove,
  onUseCluster,
  onSave,
}: {
  entry: Entry;
  secret: boolean;
  editable: boolean;
  edit: Edit | undefined;
  removed: boolean;
  conflict: boolean;
  open: boolean;
  revealed: boolean;
  syntax: DataFormatId | undefined;
  onChange: (value: string) => void;
  onToggleOpen: () => void;
  onToggleReveal: () => void;
  onSyntax: (id: DataFormatId) => void;
  onRemove: () => void;
  onUnremove: () => void;
  onUseCluster: () => void;
  onSave: () => void;
}) {
  i18n.useLocale();
  const { key } = entry;
  const binary = entry.text === null;
  const text = edit?.value ?? entry.text ?? '';
  const modified = !!edit && edit.value !== entry.text;
  const detected = useMemo(() => detectDataFormat(key, entry.text ?? ''), [key, entry.text]);
  const format = syntax ? dataFormat(syntax) : detected;
  const inline =
    !binary &&
    !open &&
    format.id === 'text' &&
    !text.includes('\n') &&
    (secret || text.length <= INLINE_MAX);
  const canEdit = editable && !binary && !removed;
  const bytes = modified ? utf8Bytes(text) : entry.bytes;

  return (
    <div className="relative">
      {(modified || removed) && (
        <span
          aria-hidden
          className={cn(
            'absolute top-0 bottom-0 -left-4 w-[2px]',
            removed ? 'bg-status-error/70' : 'bg-accent',
          )}
        />
      )}
      <div className="mb-1 flex min-h-6 items-center gap-2">
        <span
          className={cn(
            'truncate font-mono text-[11.5px] font-medium',
            removed ? 'text-fg-dim line-through' : 'text-fg',
          )}
          title={key}
        >
          {key}
        </span>
        <span className="text-fg-dim shrink-0 text-[10.5px]">
          {binary ? i18n.t('binary, {size}', { size: formatBytes(bytes) }) : formatBytes(bytes)}
        </span>
        {!binary && !removed && !inline && <FormatBadge format={format} />}
        {modified && !removed && (
          <span className="text-accent shrink-0 text-[10.5px]">{i18n.t('Modified')}</span>
        )}
        {removed && (
          <span className="text-status-error shrink-0 text-[10.5px]">
            {i18n.t('Removed on save')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {removed ? (
            <EntryAction label={i18n.t('Undo remove')} onClick={onUnremove}>
              <Undo2 className="h-3 w-3" />
            </EntryAction>
          ) : (
            <>
              {secret && !binary && !inline && !open && (
                <EntryAction
                  label={
                    revealed
                      ? i18n.t('Hide value of {key}', { key })
                      : i18n.t('Reveal value of {key}', { key })
                  }
                  onClick={onToggleReveal}
                >
                  {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </EntryAction>
              )}
              {!binary && (
                <CopyButton
                  text={text}
                  label={secret ? i18n.t('Copy decoded value') : i18n.t('Copy')}
                />
              )}
              {canEdit && (
                <EntryAction
                  label={open ? i18n.t('Close editor') : i18n.t('Edit value of {key}', { key })}
                  onClick={onToggleOpen}
                  active={open}
                >
                  {open ? <PencilOff className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                </EntryAction>
              )}
              {editable && (
                <EntryAction
                  label={i18n.t('Remove {key}', { key })}
                  onClick={onRemove}
                  tone="danger"
                >
                  <Trash2 className="h-3 w-3" />
                </EntryAction>
              )}
            </>
          )}
        </div>
      </div>
      {conflict && !removed && (
        <p className="text-tone-warning-fg mb-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px]">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {i18n.t('Changed in the cluster while you were editing.')}
          <button type="button" onClick={onUseCluster} className="text-accent hover:underline">
            {i18n.t('Use cluster value')}
          </button>
        </p>
      )}
      {removed || binary ? null : open && canEdit ? (
        <ValueEditor
          keyName={key}
          value={text}
          format={format}
          autoFocus
          onChange={onChange}
          onSyntax={onSyntax}
          onSave={onSave}
        />
      ) : inline ? (
        <InlineValue
          keyName={key}
          value={text}
          secret={secret}
          revealed={revealed}
          editable={canEdit}
          onChange={onChange}
          onToggleReveal={onToggleReveal}
          onSave={onSave}
        />
      ) : secret && !revealed ? (
        <button
          type="button"
          onClick={onToggleReveal}
          title={i18n.t('Reveal value of {key}', { key })}
          className="bg-fg/[0.035] border-border/60 text-fg-dim hover:text-fg-muted w-full rounded-md border px-2.5 py-1.5 text-left font-mono text-[11px] tracking-[0.2em]"
        >
          {'•'.repeat(Math.min(24, Math.max(8, text.length)))}
        </button>
      ) : format.code ? (
        <ValuePreview keyName={key} value={text} format={format} />
      ) : (
        <div
          onDoubleClick={canEdit ? onToggleOpen : undefined}
          title={canEdit ? i18n.t('Double-click to edit') : undefined}
        >
          <CodeBlock text={text} />
        </div>
      )}
    </div>
  );
}

/** Mounted only for visible values; formatting never changes the editable/copyable source. */
function ValuePreview({
  keyName,
  value,
  format,
}: {
  keyName: string;
  value: string;
  format: DataFormat;
}) {
  i18n.useLocale();
  const preview = useMemo(() => formatDataPreview(format.id, value), [format.id, value]);
  return (
    <InlineCodeEditor
      value={preview}
      language={format.language}
      ariaLabel={i18n.t('Value of {key}', { key: keyName })}
      readOnly
      minLines={3}
      maxHeight={288}
    />
  );
}

/** Lens-style single-line value: an input, masked for Secrets until revealed. */
function InlineValue({
  keyName,
  value,
  secret,
  revealed,
  editable,
  onChange,
  onToggleReveal,
  onSave,
}: {
  keyName: string;
  value: string;
  secret: boolean;
  revealed: boolean;
  editable: boolean;
  onChange: (value: string) => void;
  onToggleReveal: () => void;
  onSave: () => void;
}) {
  i18n.useLocale();
  const masked = secret && !revealed;
  return (
    <div className="relative">
      <input
        type={masked ? 'password' : 'text'}
        value={value}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            onSave();
          }
        }}
        spellCheck={false}
        autoComplete={secret ? 'new-password' : 'off'}
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={i18n.t('Value of {key}', { key: keyName })}
        data-1p-ignore
        data-lpignore="true"
        className={cn(
          'bg-fg/[0.035] border-border/60 text-fg focus:border-accent/70 block h-7 w-full rounded-md border px-2.5 font-mono text-[11px] transition-colors outline-none',
          secret && 'pr-8',
          !editable && 'text-fg-muted',
        )}
      />
      {secret && (
        <button
          type="button"
          onClick={onToggleReveal}
          aria-label={
            revealed
              ? i18n.t('Hide value of {key}', { key: keyName })
              : i18n.t('Reveal value of {key}', { key: keyName })
          }
          title={revealed ? i18n.t('Hide') : i18n.t('Reveal')}
          className="text-fg-dim hover:text-fg hover:bg-fg/8 absolute top-0.5 right-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md transition"
        >
          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

function NewEntryView({
  item,
  autoFocus,
  problem,
  syntax,
  onChange,
  onSyntax,
  onRemove,
  onSave,
}: {
  item: NewEntry;
  autoFocus: boolean;
  problem: string | null;
  syntax: DataFormatId | undefined;
  onChange: (patch: Partial<NewEntry>) => void;
  onSyntax: (id: DataFormatId) => void;
  onRemove: () => void;
  onSave: () => void;
}) {
  i18n.useLocale();
  // Name only: sniffing the value would swap editors mid-typing.
  const format = syntax ? dataFormat(syntax) : detectDataFormat(item.key, '');
  return (
    <div className="relative">
      <span aria-hidden className="bg-accent absolute top-0 bottom-0 -left-4 w-[2px]" />
      <div className="mb-1 flex items-center gap-2">
        <input
          value={item.key}
          onChange={(e) => onChange({ key: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              onSave();
            }
          }}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={i18n.t('Key name')}
          aria-label={i18n.t('Key name')}
          aria-invalid={!!problem}
          className={cn(
            'bg-fg/[0.035] text-fg placeholder:text-fg-dim h-6 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11.5px] font-medium transition-colors outline-none',
            problem ? 'border-status-error/60' : 'border-border/60 focus:border-accent/70',
          )}
        />
        <span className="text-accent shrink-0 text-[10.5px]">{i18n.t('New')}</span>
        <EntryAction label={i18n.t('Remove new key')} onClick={onRemove} tone="danger">
          <Trash2 className="h-3 w-3" />
        </EntryAction>
      </div>
      {problem && <p className="text-status-error mb-1 text-[11px]">{problem}</p>}
      <ValueEditor
        keyName={item.key}
        value={item.value}
        format={format}
        onChange={(value) => onChange({ value })}
        onSyntax={onSyntax}
        onSave={onSave}
      />
    </div>
  );
}
