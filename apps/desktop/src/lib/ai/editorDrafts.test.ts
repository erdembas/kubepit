import { describe, expect, it, vi } from 'vitest';
import {
  getEditorDraft,
  setEditorDraft,
  clearEditorDraft,
  reviewEditorReplacement,
} from './editorDrafts';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('editor suggestion hand-off', () => {
  it('requires consent for an edit made while schema validation was waiting', async () => {
    const validation = deferred<void>();
    let draft = { text: 'original', dirty: false };
    const confirm = vi.fn(async () => false);
    const replace = vi.fn();
    const result = reviewEditorReplacement({
      validate: () => validation.promise,
      read: () => draft,
      confirm,
      replace,
    });
    draft = { text: 'typed during validation', dirty: true };
    validation.resolve();
    expect(await result).toBe('cancelled');
    expect(confirm).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });
  it('refuses to overwrite edits made while the confirmation was open', async () => {
    const consent = deferred<boolean>();
    let draft = { text: 'reviewed text', dirty: true };
    const replace = vi.fn();
    const confirm = vi.fn(() => consent.promise);
    const result = reviewEditorReplacement({
      validate: async () => {},
      read: () => draft,
      confirm,
      replace,
    });
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledOnce();
    draft = { text: 'newer user edits', dirty: true };
    consent.resolve(true);
    expect(await result).toBe('changed');
    expect(replace).not.toHaveBeenCalled();
  });
  it('rechecks that the original editor exists after confirmation', async () => {
    const consent = deferred<boolean>();
    let open = true;
    const replace = vi.fn();
    const result = reviewEditorReplacement({
      validate: async () => {},
      read: () => (open ? { text: 'draft', dirty: true } : null),
      confirm: () => consent.promise,
      replace,
    });
    await Promise.resolve();
    open = false;
    consent.resolve(true);
    expect(await result).toBe('closed');
    expect(replace).not.toHaveBeenCalled();
  });
  it('replaces only the confirmed draft and keeps per-editor text separate', async () => {
    setEditorDraft('a', 'a draft');
    setEditorDraft('b', 'b draft');
    const replace = vi.fn(() => setEditorDraft('a', 'generated'));
    expect(
      await reviewEditorReplacement({
        validate: async () => {},
        read: () => ({ text: getEditorDraft('a')!, dirty: true }),
        confirm: async () => true,
        replace,
      }),
    ).toBe('replaced');
    expect(getEditorDraft('b')).toBe('b draft');
    expect(getEditorDraft('a')).toBe('generated');
    clearEditorDraft('a');
    clearEditorDraft('b');
    expect(getEditorDraft('a')).toBeUndefined();
  });
});
