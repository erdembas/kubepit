import { describe, expect, it } from 'vitest';
import type { Alert, Settings } from '@/types';
import { ALERT_REASONS, DEFAULT_ALERT_SETTINGS, savingAlertsOn, withSavingAlerts } from './policy';
import { alertBody, alertTitle, reasonDescription } from './text';

const settings = (alerts: boolean, disabled: Settings['alerts']['disabled_reasons'] = []) =>
  ({
    alerts: { ...DEFAULT_ALERT_SETTINGS, disabled_reasons: disabled },
    recommendations: {
      scan_clusters: [],
      interval_minutes: 60,
      retention_days: 30,
      strategy: null,
      overrides: {},
      alerts,
    },
  }) as unknown as Settings;

const alert = (extra: Partial<Alert> = {}): Alert => ({
  id: 'a1',
  cluster_id: 'c1',
  severity: 'warning',
  reason: 'RightsizingSaving',
  object: { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'shop', name: 'web' },
  container: null,
  condition: null,
  message: 'Requests could shrink by 75%',
  first_seen: 1,
  last_seen: 1,
  count: 1,
  read: false,
  group: null,
  ...extra,
});

describe('alerts for new high-confidence savings', () => {
  it('are on only with the opt-in and the reason enabled', () => {
    expect(savingAlertsOn(settings(false))).toBe(false);
    expect(savingAlertsOn(settings(true))).toBe(true);
    expect(savingAlertsOn(settings(true, ['RightsizingSaving']))).toBe(false);
    expect(savingAlertsOn(null)).toBe(false);
  });

  it('turn on together with their reason and off through the opt-in only', () => {
    const on = withSavingAlerts(settings(false, ['RightsizingSaving', 'JobFailed']), true);
    expect(on.recommendations.alerts).toBe(true);
    expect(on.alerts.disabled_reasons).toEqual(['JobFailed']);
    expect(savingAlertsOn(on)).toBe(true);
    const off = withSavingAlerts(on, false);
    expect(off.recommendations.alerts).toBe(false);
    expect(off.alerts.disabled_reasons).toEqual(['JobFailed']);
  });

  it('read as a sentence with the kind and name as data', () => {
    expect(ALERT_REASONS).toContain('RightsizingSaving');
    expect(alertTitle(alert())).toBe('Deployment web requests far more than it uses');
    expect(
      alertTitle(
        alert({
          object: { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'shop', name: '' },
          group: { total: 4, names: ['a', 'b', 'c', 'd'] },
        }),
      ),
    ).toBe('4 workloads request far more than they use in shop');
    expect(alertBody(alert(), 'prod')).toBe(
      'prod · shop/deployment/web · Requests could shrink by 75%',
    );
    for (const reason of ALERT_REASONS) expect(reasonDescription(reason)).not.toBe('');
  });
});
