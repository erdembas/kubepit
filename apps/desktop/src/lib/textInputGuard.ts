/**
 * Keeps the OS typing helpers — autocorrect (the macOS "fir" → "Fir"
 * bubble), auto-capitalisation, spell check, inline predictions and form
 * autofill — out of every text field. Kubepit's fields hold resource names,
 * selectors, YAML and commands, where such a rewrite is always wrong.
 *
 * Partners with `src-tauri/src/text_input.rs`, which switches the same
 * features off inside WebKit on macOS. This half covers what the page can
 * control, and other platforms' webviews:
 *
 *   • `spellcheck` and `writingsuggestions` inherit, so `<html>` carries
 *     them for the whole document.
 *   • `autocorrect` and `autocapitalize` do not, so a capture-phase
 *     `focusin` listener stamps every field as it gains focus, before the
 *     first keystroke. Fields rendered by React, Monaco, xterm or anything
 *     else are covered without each call site opting in.
 *   • `autocomplete` is only filled in when missing, so `new-password` on
 *     secret fields keeps working.
 */

const OFF_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['spellcheck', 'false'],
  ['writingsuggestions', 'false'],
  ['autocorrect', 'off'],
  ['autocapitalize', 'off'],
];

/** `<input>` types that accept free text; the rest have nothing to correct. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'tel']);

/** The slice of `HTMLElement` the guard touches, so it can be tested without a DOM. */
export interface GuardedElement {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
}

export function isTextField(el: GuardedElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return TEXT_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase());
}

/** Switches the OS typing helpers off on one field; other elements are left alone. */
export function guardTextField(el: GuardedElement): void {
  if (!isTextField(el)) return;
  for (const [name, value] of OFF_ATTRIBUTES) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  if (!el.isContentEditable && !el.hasAttribute('autocomplete')) {
    el.setAttribute('autocomplete', 'off');
  }
}

function onFocusIn(event: Event) {
  const target = event.target;
  // eslint-disable-next-line no-undef -- DOM global provided by lib.dom.d.ts.
  if (target instanceof HTMLElement) guardTextField(target);
}

let installed = false;

export function installTextInputGuard(): void {
  if (installed || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('spellcheck', 'false');
  root.setAttribute('writingsuggestions', 'false');
  document.addEventListener('focusin', onFocusIn, { capture: true });
  installed = true;
}
