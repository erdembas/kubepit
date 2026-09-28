import { describe, expect, it } from 'vitest';
import type { Settings } from '@/types';
import { rebaseDraft, remoteSettings } from './settingsSync';

const settings = { change_journal: true } as unknown as Settings;
describe('remoteSettings', () => {
  it('applies settings saved by another window', () => {
    expect(remoteSettings({ source: 'win-2', settings }, 'main')).toBe(settings);
  });
  it('ignores the event from the saving window', () => {
    expect(remoteSettings({ source: 'main', settings }, 'main')).toBeNull();
  });
});

describe('rebaseDraft', () => {
  const base = {
    log_tail_lines: 1000,
    change_journal: true,
    keychain_kubeconfigs: false,
  } as unknown as Settings;

  it('adopts the new settings while the draft is unchanged', () => {
    const incoming = { ...base, change_journal: false };
    expect(rebaseDraft({ ...base }, base, incoming)).toBe(incoming);
  });
  it('keeps a dirty draft and takes only the fields it did not edit', () => {
    const draft = { ...base, log_tail_lines: 50 };
    const incoming = { ...base, log_tail_lines: 2000, keychain_kubeconfigs: true };
    expect(rebaseDraft(draft, base, incoming)).toEqual({
      ...base,
      log_tail_lines: 50,
      keychain_kubeconfigs: true,
    });
  });
  it('adopts the settings once they arrive', () => {
    expect(rebaseDraft(null, null, base)).toBe(base);
  });
});
