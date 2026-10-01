import * as i18n from '@/i18n';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bookmark, Pencil, Pin, PinOff, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { environmentMeta } from '@/lib/clusterMeta';
import {
  MAX_PINNED_SEARCHES,
  MAX_SAVED_SEARCHES,
  MAX_SEARCH_NAME,
  MAX_SAVED_QUERY,
  sameSavedSearch,
  savedSearchScopeExists,
  searchSnapshot,
  type FleetSearchSnapshot,
  type SavedFleetSearch,
} from '@/lib/fleet/savedSearches';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import { useFleetSearchStore, type SearchScope } from '@/store/useFleetSearchStore';
import { useSavedFleetSearchStore, type SavedSearchError } from '@/store/useSavedFleetSearchStore';
import type { Section } from '@/types';

function scopeLabel(scope: SearchScope, sections: readonly Section[]): string {
  if (scope.kind === 'section')
    return sections.find((section) => section.id === scope.id)?.name ?? i18n.t('Missing section');
  if (scope.kind === 'environment') return environmentMeta(scope.env)?.label ?? scope.env;
  return i18n.t('All clusters');
}

function errorLabel(error: SavedSearchError): string {
  switch (error) {
    case 'duplicate-name':
      return i18n.t('A saved search already uses this name.');
    case 'limit':
      return i18n.t('You can save up to {count} searches. Delete one to make room.', {
        count: MAX_SAVED_SEARCHES,
      });
    case 'pin-limit':
      return i18n.t('You can pin up to {count} searches. Unpin one first.', {
        count: MAX_PINNED_SEARCHES,
      });
    case 'missing':
      return i18n.t('This saved search was removed in another window.');
    case 'storage':
      return i18n.t('Local storage is full or unavailable. Your saved searches were not changed.');
    case 'invalid':
      return i18n.t('Enter a name and a valid query within the saved search limits.');
  }
}

type Modal =
  | { kind: 'manage' }
  | { kind: 'save'; snapshot: FleetSearchSnapshot }
  | { kind: 'rename'; search: SavedFleetSearch }
  | { kind: 'delete'; search: SavedFleetSearch }
  | null;

/** Local named queries. Reopening uses the normal search-as-you-type flow;
 * it does not opt disconnected clusters into a connection. */
export function SavedSearches({
  visible,
  pendingFilter,
}: {
  visible: boolean;
  pendingFilter: boolean;
}) {
  i18n.useLocale();
  const searches = useVisibleStore(useSavedFleetSearchStore, (state) => state.searches, visible);
  const sections = useVisibleStore(useAppStore, (state) => state.sections, visible);
  const input = useFleetSearchStore((state) => state.input);
  const kinds = useFleetSearchStore((state) => state.kinds);
  const scope = useFleetSearchStore((state) => state.scope);
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState<string | null>(null);
  const store = useSavedFleetSearchStore.getState;
  const snapshot = { input, kinds, scope };
  const pinned = searches.filter((search) => search.pinned);
  const canSave = !pendingFilter && searchSnapshot(snapshot) !== null;
  useEffect(() => {
    if (!visible) setModal(null);
  }, [visible]);
  if (!visible) return null;

  const reopen = (search: SavedFleetSearch) => {
    const result = useFleetSearchStore.getState().applySavedSearch(search);
    if (result === 'missing-section') {
      setError(
        i18n.t('This search refers to a deleted section. Your current query was not changed.'),
      );
      return;
    }
    if (result === 'invalid') {
      setError(errorLabel('invalid'));
      return;
    }
    setError(null);
    setModal(null);
  };
  const changePin = (search: SavedFleetSearch) => {
    const result = store().setPinned(search.id, !search.pinned);
    setError(result.ok ? null : errorLabel(result.error));
  };
  const errorView = error && (
    <div
      role="alert"
      className="bg-status-starting/8 text-status-starting mt-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-[11px]"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      <IconButton label={i18n.t('Dismiss')} size="xs" icon={<X />} onClick={() => setError(null)} />
    </div>
  );

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          leftIcon={<Save className="h-3 w-3" />}
          disabled={!canSave}
          title={
            !canSave
              ? i18n.t('Complete a query of up to {count} characters to save it.', {
                  count: MAX_SAVED_QUERY,
                })
              : undefined
          }
          onClick={() => {
            setError(null);
            setModal({ kind: 'save', snapshot: { input, kinds: [...kinds], scope: { ...scope } } });
          }}
        >
          {i18n.t('Save search')}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={<Bookmark className="h-3 w-3" />}
          onClick={() => {
            setError(null);
            setModal({ kind: 'manage' });
          }}
        >
          {i18n.t('Saved searches ({count})', { count: searches.length })}
        </Button>
        {pinned.length > 0 && <span className="bg-border mx-1 h-3.5 w-px" aria-hidden />}
        {pinned.map((search) => (
          <button
            key={search.id}
            type="button"
            title={search.input}
            onClick={() => reopen(search)}
            aria-label={i18n.t('Open saved search {name}', { name: search.name })}
            className={cn(
              'flex max-w-[190px] items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition',
              sameSavedSearch(search, snapshot)
                ? 'bg-accent/10 text-accent shadow-[inset_2px_0_0_rgb(var(--accent))]'
                : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
            )}
          >
            <Pin className="h-3 w-3 shrink-0" />
            <span className="truncate">{search.name}</span>
            {!savedSearchScopeExists(search.scope, sections) && (
              <AlertTriangle
                className="text-status-starting h-3 w-3 shrink-0"
                aria-label={i18n.t('Missing section')}
              />
            )}
          </button>
        ))}
      </div>
      {modal?.kind !== 'manage' && errorView}

      {modal?.kind === 'manage' &&
        createPortal(
          <Dialog
            title={i18n.t('Saved Fleet searches')}
            onClose={() => setModal(null)}
            size="lg"
            footer={
              <Button variant="ghost" onClick={() => setModal(null)}>
                {i18n.t('Close')}
              </Button>
            }
          >
            <p className="text-fg-dim mb-3 text-[12px] leading-relaxed">
              {i18n.t(
                'Reopen a query with its kinds and scope. Only connected clusters are searched.',
              )}
            </p>
            {errorView}
            {!searches.length ? (
              <p className="text-fg-muted py-8 text-center text-[12px]">
                {i18n.t('No saved searches yet. Save your current query to find it here.')}
              </p>
            ) : (
              <div className="divide-border/50 divide-y">
                {[...searches]
                  .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
                  .map((search) => (
                    <div key={search.id} className="group flex items-center gap-1 py-2">
                      <button
                        type="button"
                        onClick={() => reopen(search)}
                        className="hover:bg-fg/5 min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                        aria-label={i18n.t('Open saved search {name}', { name: search.name })}
                      >
                        <span className="text-fg flex items-center gap-2 text-[12px] font-medium">
                          <span className="truncate">{search.name}</span>
                          {!savedSearchScopeExists(search.scope, sections) && (
                            <AlertTriangle className="text-status-starting h-3.5 w-3.5 shrink-0" />
                          )}
                        </span>
                        <span
                          className="text-fg-dim mt-1 block truncate font-mono text-[11px]"
                          title={search.input}
                        >
                          {search.input}
                        </span>
                        <span className="text-fg-dim mt-1 block text-[10px]">
                          {i18n.t('{scope} · {count} selected kinds', {
                            scope: scopeLabel(search.scope, sections),
                            count: search.kinds.length,
                          })}
                        </span>
                      </button>
                      <IconButton
                        label={search.pinned ? i18n.t('Unpin search') : i18n.t('Pin search')}
                        icon={search.pinned ? <PinOff /> : <Pin />}
                        tone={search.pinned ? 'accent' : 'default'}
                        onClick={() => changePin(search)}
                      />
                      <IconButton
                        label={i18n.t('Rename search')}
                        icon={<Pencil />}
                        onClick={() => {
                          setError(null);
                          setModal({ kind: 'rename', search });
                        }}
                      />
                      <IconButton
                        label={i18n.t('Delete search')}
                        icon={<Trash2 />}
                        tone="danger"
                        onClick={() => {
                          setError(null);
                          setModal({ kind: 'delete', search });
                        }}
                      />
                    </div>
                  ))}
              </div>
            )}
            <p className="text-fg-dim mt-4 text-[10px]">
              {i18n.t('{saved} of {limit} saved · {pinned} of {pinLimit} pinned', {
                saved: searches.length,
                limit: MAX_SAVED_SEARCHES,
                pinned: pinned.length,
                pinLimit: MAX_PINNED_SEARCHES,
              })}
            </p>
          </Dialog>,
          document.body,
        )}
      {(modal?.kind === 'save' || modal?.kind === 'rename') &&
        createPortal(
          <NameDialog
            key={modal.kind === 'rename' ? modal.search.id : 'save'}
            initialName={
              modal.kind === 'rename'
                ? modal.search.name
                : modal.snapshot.input.trim().slice(0, MAX_SEARCH_NAME)
            }
            pinAvailable={pinned.length < MAX_PINNED_SEARCHES}
            renaming={modal.kind === 'rename'}
            onClose={() => setModal(modal.kind === 'rename' ? { kind: 'manage' } : null)}
            onSave={(name, pin) => {
              const result =
                modal.kind === 'rename'
                  ? store().rename(modal.search.id, name)
                  : store().save(name, modal.snapshot, pin);
              if (!result.ok) return errorLabel(result.error);
              setModal(modal.kind === 'rename' ? { kind: 'manage' } : null);
              return null;
            }}
          />,
          document.body,
        )}
      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title={i18n.t('Delete saved search?')}
          message={i18n.t('Delete “{name}” from your saved searches?', { name: modal.search.name })}
          confirmLabel={i18n.t('Delete')}
          onCancel={() => setModal({ kind: 'manage' })}
          onConfirm={() => {
            const result = store().remove(modal.search.id);
            setError(result.ok ? null : errorLabel(result.error));
            setModal({ kind: 'manage' });
          }}
        />
      )}
    </>
  );
}

function NameDialog({
  initialName,
  pinAvailable,
  renaming,
  onClose,
  onSave,
}: {
  initialName: string;
  pinAvailable: boolean;
  renaming: boolean;
  onClose: () => void;
  onSave: (name: string, pinned: boolean) => string | null;
}) {
  i18n.useLocale();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [pinned, setPinned] = useState(pinAvailable);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (name.trim()) setError(onSave(name, pinned));
  };
  return (
    <Dialog
      title={renaming ? i18n.t('Rename search') : i18n.t('Save Fleet search')}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button disabled={!name.trim()} onClick={submit}>
            {renaming ? i18n.t('Rename') : i18n.t('Save')}
          </Button>
        </>
      }
    >
      <label
        htmlFor={id}
        className="text-fg-dim mb-1.5 block text-[10px] font-semibold tracking-[0.12em] uppercase"
      >
        {i18n.t('Name')}
      </label>
      <Input
        id={id}
        autoFocus
        value={name}
        maxLength={MAX_SEARCH_NAME}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
        }}
      />
      {!renaming && (
        <label className="text-fg-muted mt-4 flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={pinned}
            disabled={!pinAvailable}
            onChange={(event) => setPinned(event.target.checked)}
            className="accent-accent"
          />
          {i18n.t('Pin for quick access')}
        </label>
      )}
      {!renaming && !pinAvailable && (
        <p className="text-fg-dim mt-1 text-[11px]">
          {i18n.t('Unpin an existing search to add another quick shortcut.')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-status-error mt-3 text-[11px]">
          {error}
        </p>
      )}
    </Dialog>
  );
}
