import { describe, expect, it } from 'vitest';
import type { Settings } from '@/types';
import { remoteSettings } from './settingsSync';

const settings = { change_journal: true } as unknown as Settings;
describe('remoteSettings', () => {
  it('applies settings saved by another window', () => {
    expect(remoteSettings({ source: 'win-2', settings }, 'main')).toBe(settings);
  });
  it('ignores the event from the saving window', () => {
    expect(remoteSettings({ source: 'main', settings }, 'main')).toBeNull();
  });
});
