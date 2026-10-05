import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Check, CopyPlus, Loader2, Search } from 'lucide-react';
import { stringify } from 'yaml';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { useNamespaceNames } from '../data/hooks';
import type { ActionDialog } from './dialogStore';

/**
 * "Copy to namespaces…": duplicate a Secret into other namespaces. The
 * object is re-created as-is (data, type, labels, annotations) under its
 * own name; a Secret that already exists in a target is left untouched.
 */
export function CopySecretDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'copy-secret' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { obj, gvk, clusterId } = dialog;
  const name = obj.metadata.name;
  const sourceNs = obj.metadata.namespace ?? null;
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const accessible = cluster?.accessible_namespaces ?? [];
  const names = useNamespaceNames(clusterId, true);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const set = new Set<string>([...(names.data ?? []), ...(accessible.length ? accessible : [])]);
    set.delete(sourceNs ?? '');
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [names.data, accessible, sourceNs]);
  const filtered = options.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()));

  const toggle = (ns: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  const allVisibleOn = filtered.length > 0 && filtered.every((n) => checked.has(n));
  const toggleAllVisible = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allVisibleOn) filtered.forEach((n) => next.delete(n));
      else filtered.forEach((n) => next.add(n));
      return next;
    });

  const copy = async () => {
    setBusy(true);
    const targets = [...checked].sort();
    const errors: string[] = [];
    let next = 0;
    for (const ns of targets) {
      try {
        const live = await ipc.resourceGet(clusterId, gvk, sourceNs, name);
        const doc = {
          apiVersion: live.apiVersion,
          kind: live.kind,
          metadata: {
            name: live.metadata.name,
            namespace: ns,
            labels: live.metadata.labels,
            annotations: live.metadata.annotations,
          },
          type: live.type,
          data: live.data,
        };
        await ipc.resourceApplyYaml(clusterId, stringify(doc), 'create', ns);
        next += 1;
      } catch (error) {
        errors.push(`${ns}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setBusy(false);
    const push = useAppStore.getState().pushToast;
    if (errors.length)
      push(
        'error',
        i18n.t('{failed} of {total} copies failed:\n{errors}', {
          failed: errors.length,
          total: targets.length,
          errors: errors.join('\n'),
        }),
      );
    else
      push(
        'success',
        i18n.plural(
          'Copied {name} to {count} namespace',
          'Copied {name} to {count} namespaces',
          next,
          { name },
        ),
      );
    if (next > 0) onClose();
  };
  const submit = () => {
    if (!checked.size || busy) return;
    if (cluster?.environment === 'production') {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Copy Secret'),
        message: i18n.plural(
          'Copy {name} to {count} namespace on a production cluster?',
          'Copy {name} to {count} namespaces on a production cluster?',
          checked.size,
          { name },
        ),
        confirmLabel: i18n.t('Copy'),
        tone: 'danger',
        typeToConfirm: name,
        onConfirm: copy,
      });
    } else void copy();
  };

  return (
    <Dialog
      title={i18n.t('Copy Secret to namespaces')}
      subtitle={`${sourceNs ? `${sourceNs}/` : ''}${name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="text-fg-dim mr-auto text-[11px]">
            {checked.size > 0
              ? i18n.plural('{count} namespace selected', '{count} namespaces selected', checked.size)
              : i18n.t('Pick the namespaces to copy into.')}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!checked.size || busy}
            onClick={submit}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CopyPlus />}
          >
            {i18n.t('Copy')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3">
        <p className="text-fg-muted text-[12px]">
          {i18n.t(
            'Creates the same Secret under its own name in each picked namespace. An existing Secret is never overwritten.',
          )}
        </p>
        <div className="border-border/70 focus-within:border-accent/50 flex h-8 items-center gap-2 rounded-lg border px-2.5 transition-colors">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={i18n.t('Filter namespaces…')}
            aria-label={i18n.t('Filter namespaces')}
            className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          />
        </div>
        <div className="overlay-scroll border-border/60 flex max-h-72 min-h-0 flex-col overflow-auto rounded-lg border p-1">
          {filtered.length > 0 && (
            <label className="hover:bg-fg/4 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
              <Checkbox checked={allVisibleOn} onChange={toggleAllVisible} className="mt-0" />
              <span className="text-fg-muted min-w-0 flex-1 font-medium">
                {i18n.t('Select all {count}', { count: filtered.length })}
              </span>
            </label>
          )}
          {filtered.map((ns) => {
            const on = checked.has(ns);
            return (
              <label
                key={ns}
                className={cn(
                  'hover:bg-fg/4 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px]',
                  on && 'bg-fg/4',
                )}
              >
                <Checkbox checked={on} onChange={() => toggle(ns)} aria-label={ns} className="mt-0" />
                <span className={cn('min-w-0 flex-1 truncate font-mono', on ? 'text-fg' : 'text-fg-muted')}>
                  {ns}
                </span>
                {on && <Check className="text-accent h-3.5 w-3.5 shrink-0" />}
              </label>
            );
          })}
          {!filtered.length && (
            <p className="text-fg-dim px-3 py-6 text-center text-[12px]">
              {i18n.t('No matching namespaces')}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
