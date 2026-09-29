import { describe, expect, it } from 'vitest';
import { guardTextField, isTextField, type GuardedElement } from './textInputGuard';

function fakeElement(
  tagName: string,
  attrs: Record<string, string> = {},
  isContentEditable = false,
): GuardedElement & { attrs: Record<string, string> } {
  return {
    tagName,
    isContentEditable,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
    hasAttribute: (name) => name in attrs,
  };
}

describe('isTextField', () => {
  it('accepts free-text inputs, textareas and editable content', () => {
    expect(isTextField(fakeElement('INPUT'))).toBe(true);
    expect(isTextField(fakeElement('input', { type: 'Search' }))).toBe(true);
    expect(isTextField(fakeElement('INPUT', { type: 'password' }))).toBe(true);
    expect(isTextField(fakeElement('TEXTAREA'))).toBe(true);
    expect(isTextField(fakeElement('DIV', {}, true))).toBe(true);
  });
  it('skips controls without free text', () => {
    expect(isTextField(fakeElement('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTextField(fakeElement('INPUT', { type: 'number' }))).toBe(false);
    expect(isTextField(fakeElement('BUTTON'))).toBe(false);
    expect(isTextField(fakeElement('DIV'))).toBe(false);
  });
});

describe('guardTextField', () => {
  it('switches every typing helper off on a bare input', () => {
    const el = fakeElement('INPUT');
    guardTextField(el);
    expect(el.attrs).toEqual({
      spellcheck: 'false',
      writingsuggestions: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
    });
  });
  it('overrides fields that opted back in', () => {
    const el = fakeElement('TEXTAREA', { spellcheck: 'true', autocorrect: 'on' });
    guardTextField(el);
    expect(el.attrs.spellcheck).toBe('false');
    expect(el.attrs.autocorrect).toBe('off');
  });
  it('keeps an explicit autocomplete hint', () => {
    const el = fakeElement('INPUT', { type: 'password', autocomplete: 'new-password' });
    guardTextField(el);
    expect(el.attrs.autocomplete).toBe('new-password');
  });
  it('leaves autocomplete off editable content and ignores other elements', () => {
    const editable = fakeElement('DIV', {}, true);
    guardTextField(editable);
    expect(editable.attrs.autocorrect).toBe('off');
    expect(editable.hasAttribute('autocomplete')).toBe(false);

    const checkbox = fakeElement('INPUT', { type: 'checkbox' });
    guardTextField(checkbox);
    expect(checkbox.attrs).toEqual({ type: 'checkbox' });
  });
});
