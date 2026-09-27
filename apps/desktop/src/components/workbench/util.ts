import * as i18n from '@/i18n/core';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function copyText(text: string, what?: string) {
  try {
    await navigator.clipboard.writeText(text);
    useAppStore
      .getState()
      .pushToast(
        'success',
        what ? i18n.t('Copied {what}', { what }) : i18n.t('Copied to clipboard'),
      );
  } catch {
    useAppStore.getState().pushToast('error', i18n.t('Clipboard is not available'));
  }
}

/** A clock for relative ages; ticks only while `enabled`. */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Tracks the `dark` class the shell toggles on <html>. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Stable callback identity that always calls the latest implementation. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useRef((...args: A) => ref.current(...args));
  return stable.current;
}

/** True when a keyboard event comes from a text field or editor that owns its keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return !!target.closest('.monaco-editor, .xterm, [data-dock]');
}
