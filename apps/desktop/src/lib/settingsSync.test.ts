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

describe('rebaseDraft with groups of settings', () => {
  const saved = {
    log_tail_lines: 1000,
    keyboard_mode: false,
    kubeconfig_sync_paths: ['/a'],
    alerts: {
      enabled: true,
      disabled_reasons: [],
      include_namespaces: [],
      exclude_namespaces: [],
      disabled_clusters: [],
      muted_clusters: {},
      snoozed_until: null,
      os_notifications: true,
      background_only: true,
    },
    history: {
      audit: true,
      audit_retention_days: 90,
      persist_clusters: [],
      retention_days: 7,
      max_size_mb: 512,
    },
    recommendations: {
      scan_clusters: ['c-dev'],
      interval_minutes: 60,
      retention_days: 30,
      strategy: null,
      overrides: {},
      alerts: false,
    },
  } as unknown as Settings;
  const edit = <K extends keyof Settings>(s: Settings, key: K, patch: Partial<Settings[K]>) =>
    ({ ...s, [key]: { ...(s[key] as object), ...patch } }) as Settings;

  it('keeps a scan opt-in saved by the Recommendations header while History edits the retention', () => {
    // Settings → History: retention 14, not saved yet.
    const draft = edit(saved, 'recommendations', { retention_days: 14 });
    // The header's switch saves kind-kubepit at once.
    const incoming = edit(saved, 'recommendations', { scan_clusters: ['c-dev', 'c-kind'] });
    const next = rebaseDraft(draft, saved, incoming)!;
    expect(next.recommendations.scan_clusters).toEqual(['c-dev', 'c-kind']);
    expect(next.recommendations.retention_days).toBe(14);
  });

  it('keeps the interval, strategy, overrides and alert opt-in saved meanwhile', () => {
    const draft = edit(saved, 'recommendations', { retention_days: 14 });
    const overrides = {
      'workload-history': { days: 14 },
    } as unknown as Settings['recommendations']['overrides'];
    const incoming = edit(saved, 'recommendations', {
      interval_minutes: 15,
      strategy: 'percentile-headroom',
      overrides,
      alerts: true,
    });
    expect(rebaseDraft(draft, saved, incoming)!.recommendations).toEqual({
      ...incoming.recommendations,
      retention_days: 14,
    });
  });

  it('lets the draft win a field both changed; arrays and nested objects are values', () => {
    const draft = edit(saved, 'recommendations', {
      scan_clusters: ['c-dev', 'c-prod'],
      overrides: { a: { days: 1 } } as unknown as Settings['recommendations']['overrides'],
    });
    const incoming = edit(saved, 'recommendations', {
      scan_clusters: ['c-dev', 'c-kind'],
      overrides: { b: { days: 2 } } as unknown as Settings['recommendations']['overrides'],
      interval_minutes: 30,
    });
    const next = rebaseDraft(draft, saved, incoming)!.recommendations;
    expect(next.scan_clusters).toEqual(['c-dev', 'c-prod']);
    expect(next.overrides).toEqual({ a: { days: 1 } });
    expect(next.interval_minutes).toBe(30);
  });

  it('Notifications: keeps a mute or snooze from the panel while the draft edits filters', () => {
    const draft = edit(saved, 'alerts', { exclude_namespaces: ['kube-*'] });
    const incoming = edit(saved, 'alerts', {
      muted_clusters: { 'c-prod': null },
      snoozed_until: 123,
    });
    expect(rebaseDraft(draft, saved, incoming)!.alerts).toEqual({
      ...incoming.alerts,
      exclude_namespaces: ['kube-*'],
    });
  });

  it('Notifications: the saving-alert row edits two groups and keeps both', () => {
    const draft = edit(edit(saved, 'recommendations', { alerts: true }), 'alerts', {
      os_notifications: false,
    });
    const incoming = edit(saved, 'recommendations', { scan_clusters: [] });
    const next = rebaseDraft(draft, saved, incoming)!;
    expect(next.recommendations).toEqual({
      ...saved.recommendations,
      scan_clusters: [],
      alerts: true,
    });
    expect(next.alerts.os_notifications).toBe(false);
  });

  it('History: keeps persisted clusters saved elsewhere while the draft edits a retention', () => {
    const draft = edit(saved, 'history', { audit_retention_days: 30 });
    const incoming = edit(saved, 'history', { persist_clusters: ['c-dev'] });
    expect(rebaseDraft(draft, saved, incoming)!.history).toEqual({
      ...saved.history,
      audit_retention_days: 30,
      persist_clusters: ['c-dev'],
    });
  });

  it('General and Keyboard: top-level values still rebase as before', () => {
    const draft = { ...saved, keyboard_mode: true, kubeconfig_sync_paths: ['/a', '/b'] };
    const incoming = { ...saved, log_tail_lines: 50, kubeconfig_sync_paths: ['/c'] };
    const next = rebaseDraft(draft, saved, incoming)!;
    expect(next.keyboard_mode).toBe(true);
    expect(next.kubeconfig_sync_paths).toEqual(['/a', '/b']);
    expect(next.log_tail_lines).toBe(50);
    expect(next.recommendations).toBe(incoming.recommendations);
  });

  it('drops a field the draft removed from a group', () => {
    const { snoozed_until: _gone, ...rest } = saved.alerts;
    const draft = { ...saved, alerts: rest as Settings['alerts'] };
    const incoming = edit(saved, 'alerts', { enabled: false });
    const next = rebaseDraft(draft, saved, incoming)!.alerts;
    expect('snoozed_until' in next).toBe(false);
    expect(next.enabled).toBe(false);
  });
});
