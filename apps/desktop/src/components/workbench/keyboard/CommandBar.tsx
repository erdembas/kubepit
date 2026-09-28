import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { execute, suggestions, useKeyboardUi, type BarContext } from './commandBarModel';

/** k9s-style `:` command bar (keyboard mode). */
export function CommandBar() {
  i18n.useLocale();
  const close = () => useKeyboardUi.getState().closeCommand();
  const clusterId = useAppStore((s) => s.selectedClusterId);
  const clusters = useAppStore((s) => s.clusters);
  const connected = useAppStore((s) =>
    clusterId ? s.statuses[clusterId]?.state === 'connected' : false,
  );
  const apiResources = useWorkbenchStore((s) =>
    clusterId ? (s.apiResources[clusterId] ?? null) : null,
  );
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!clusterId || !connected) return;
    let alive = true;
    ipc
      .namespaceNames(clusterId)
      .then((names) => alive && setNamespaces(names))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clusterId, connected]);

  const ctx: BarContext = useMemo(
    () => ({ clusterId, apiResources, namespaces, clusters }),
    [clusterId, apiResources, namespaces, clusters],
  );
  const items = useMemo(() => suggestions(input, ctx), [input, ctx]);
  useEffect(() => setCursor(0), [items]);

  const run = (text: string) => {
    const message = execute(text, ctx);
    if (message) setError(message);
    else close();
  };
  const take = (index: number) => {
    const item = items[index];
    if (item) {
      setInput(`${item.value} `);
      setError(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      take(cursor);
    } else if (e.key === 'ArrowRight' && inputRef.current?.selectionStart === input.length) {
      if (items[cursor]) {
        e.preventDefault();
        take(cursor);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = input.trim();
      // A partial word runs the highlighted suggestion (`:dep` → deployments).
      const item = items[cursor];
      const exact = !typed || items.some((s) => s.value === typed);
      run(item && !exact && !/\s/.test(typed) ? item.value : typed);
    } else if (e.key === 'Backspace' && !input) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[14vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label={i18n.t('Command bar')}
        className="quick-action-panel animate-fade-in flex w-[520px] max-w-[92vw] flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          <span className="text-accent font-mono text-[15px] font-semibold" aria-hidden>
            :
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value.replace(/^:+/, ''));
              setError(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={i18n.t('pods, deploy kube-system, ns default, ctx staging, q…')}
            aria-label={i18n.t('Command')}
            className="text-fg placeholder:text-fg-dim/80 h-7 w-full bg-transparent font-mono text-[14px]"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <CornerDownLeft className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        </div>
        {error && (
          <p
            role="alert"
            className="text-status-error border-border/40 border-t px-4 py-2 text-[12px]"
          >
            {error}
          </p>
        )}
        {items.length > 0 && (
          <div className="qa-list border-border/40 max-h-[320px] overflow-y-auto border-t py-1">
            {items.map((item, index) => (
              <button
                type="button"
                key={item.value}
                onMouseEnter={() => setCursor(index)}
                onClick={() => {
                  take(index);
                  inputRef.current?.focus();
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-1.5 text-left transition',
                  index === cursor ? 'bg-accent/10' : 'hover:bg-surface-muted/50',
                )}
              >
                <span className="text-fg min-w-0 truncate font-mono text-[12.5px]" lang="en">
                  {item.label}
                </span>
                <span className="text-fg-dim ml-auto truncate text-[11px]">{item.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div className="border-border/30 bg-surface-muted/30 text-fg-dim flex items-center gap-3 border-t px-4 py-1.5 text-[10px]">
          <span>{i18n.t('↹ complete')}</span>
          <span>{i18n.t('⏎ run')}</span>
          <span>{i18n.t('esc close')}</span>
          <span className="ml-auto">{i18n.t('? for every key')}</span>
        </div>
      </div>
    </div>
  );
}
