import * as i18n from '@/i18n';
import { useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { customActionIcon } from '@/components/workbench/actions/custom/icons';
import { scopeSummary } from '@/lib/customActions';
import type { CustomAction, CustomActionImport, CustomActionImportNote } from '@/types';

/** Translated explanation of an import note; `detail` stays verbatim. */
export function noteText(note: CustomActionImportNote): string {
  const detail = note.detail;
  switch (note.code) {
    case 'invalid-action':
      return i18n.t('Skipped, not a valid action: {detail}', { detail });
    case 'invalid-plugin':
      return i18n.t('Skipped, not a valid plugin: {detail}', { detail });
    case 'unsupported-field':
      return i18n.t('The field {detail} has no equivalent and was ignored.', { detail });
    case 'unsupported-scope':
      return i18n.t('The k9s view {detail} has no Kubernetes kind and was dropped.', { detail });
    case 'guessed-scope':
      return i18n.t('Scope guessed from the resource name: {detail}. Check the kind.', { detail });
    case 'no-scope':
      return i18n.t('Skipped: none of its scopes ({detail}) can be mapped.', { detail });
    case 'unsupported-variable':
      return i18n.t('{detail} has no placeholder; it is left to the shell and is usually empty.', {
        detail,
      });
    case 'invalid-shortcut':
      return i18n.t('The shortcut {detail} could not be mapped and was dropped.', { detail });
    case 'extra-args':
      return i18n.t('Arguments after the script were ignored: {detail}', { detail });
    default:
      return detail;
  }
}

const isWarning = (note: CustomActionImportNote) =>
  ['invalid-action', 'invalid-plugin', 'no-scope', 'unsupported-variable'].includes(note.code);

/** What an import found; the user picks which actions to add. */
export function ImportDialog({
  result,
  source,
  onAdd,
  onClose,
}: {
  result: CustomActionImport;
  /** File name shown in the subtitle. */
  source: string;
  onAdd: (actions: CustomAction[]) => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [picked, setPicked] = useState<ReadonlySet<number>>(
    () => new Set(result.actions.map((_, i) => i)),
  );
  const toggle = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const count = picked.size;
  return (
    <Dialog
      title={
        result.format === 'k9s' ? i18n.t('Import k9s plugins') : i18n.t('Import custom actions')
      }
      subtitle={source}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!count}
            onClick={() => onAdd(result.actions.filter((_, i) => picked.has(i)))}
          >
            {i18n.plural('Add {count} action', 'Add {count} actions', count)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {result.format === 'k9s' && (
          <p className="text-fg-dim text-[12px] leading-relaxed">
            {i18n.t(
              'k9s variables became placeholders and plugins arrive enabled. Review the commands before running them.',
            )}
          </p>
        )}
        {result.actions.length === 0 ? (
          <p className="text-fg-dim text-[12px]">{i18n.t('No action could be imported.')}</p>
        ) : (
          <ul className="space-y-1">
            {result.actions.map((a, i) => {
              const Icon = customActionIcon(a.icon);
              const notes = result.notes.filter((n) => n.action === a.name);
              return (
                <li key={`${a.id}-${i}`}>
                  <label className="hover:bg-fg/4 flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5">
                    <Checkbox checked={picked.has(i)} onChange={() => toggle(i)} />
                    <Icon className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="text-fg block truncate text-[12px] font-medium">
                        {a.name}
                      </span>
                      <span className="text-fg-dim block truncate font-mono text-[11px]" lang="en">
                        {a.command}
                      </span>
                      <span className="text-fg-dim block truncate text-[11px]">
                        {scopeSummary(a.scopes)}
                      </span>
                      {notes.map((n, j) => (
                        <span
                          key={j}
                          className="text-status-starting mt-0.5 flex items-start gap-1 text-[11px]"
                        >
                          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                          {noteText(n)}
                        </span>
                      ))}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {result.notes.some((n) => !result.actions.some((a) => a.name === n.action)) && (
          <section>
            <h4 className="text-fg-dim mb-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {i18n.t('Not imported')}
            </h4>
            <ul className="space-y-1">
              {result.notes
                .filter((n) => !result.actions.some((a) => a.name === n.action))
                .map((n, i) => {
                  const Icon = isWarning(n) ? AlertTriangle : Info;
                  return (
                    <li key={i} className="flex items-start gap-1.5 px-2 text-[11.5px]">
                      <Icon className="text-status-starting mt-0.5 h-3 w-3 shrink-0" />
                      <span className="text-fg-muted min-w-0">
                        <span className="text-fg font-medium">{n.action || '—'}</span>
                        {' — '}
                        {noteText(n)}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
