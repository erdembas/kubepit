import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TLS_KEY, STOREFRONT_LEAF, restamp } from '@/lib/ipc/mock/fixtures/certs';
import type { KubeObject } from '@/types';
import type { WatchSnapshot } from '../data/watchCache';
import { TlsSummaryCard } from './TlsSummaryCard';

const mocked = vi.hoisted(() => ({
  watch: vi.fn<() => WatchSnapshot>(),
  now: vi.fn(() => Date.UTC(2026, 8, 29, 12)),
}));

// No watch is started: all rows and timestamps come from fixtures.
vi.mock('../data/watchCache', () => ({
  useWatch: mocked.watch,
  restartWatch: vi.fn(),
}));
vi.mock('../util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util')>()),
  useNow: mocked.now,
}));

const NOW = Date.UTC(2026, 8, 29, 12);
const DAY = 86_400_000;
const BROKEN_CERT = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----';

function secret(name: string, expiresInDays: number, namespace = 'checkout'): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: { name, namespace, uid: `${namespace}/${name}` },
    data: {
      'tls.crt': btoa(restamp(STOREFRONT_LEAF, NOW - 90 * DAY, NOW + expiresInDays * DAY)),
      'tls.key': btoa(DEMO_TLS_KEY),
      password: btoa('do-not-render-this-secret'),
    },
  };
}

function snapshot(items: KubeObject[] = [], overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    items,
    byUid: new Map(items.map((obj) => [obj.metadata.uid, obj])),
    status: 'ready',
    error: null,
    forbidden: false,
    synced: true,
    version: 1,
    ...overrides,
  };
}

function render(state: WatchSnapshot, isActive = true): string {
  mocked.watch.mockReturnValue(state);
  return renderToStaticMarkup(<TlsSummaryCard clusterId="c-tls-test" isActive={isActive} />);
}

function counts(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
}

function rows(html: string): string[] {
  return [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)].map((match) => match[1]!);
}

function namespaceButtons(html: string): Array<{ title: string; namespace: string }> {
  return [...html.matchAll(/<button\b[^>]*title="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map(
    (match) => ({ title: match[1]!, namespace: match[2]! }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TlsSummaryCard', () => {
  it.each(['idle', 'loading'] as const)(
    'does not turn an empty %s watch into a healthy or empty result',
    (status) => {
      const html = render(snapshot([], { status, synced: false }));
      expect(html).toContain('Reading TLS certificates…');
      expect(html).not.toContain('No TLS Secrets found.');
      expect(html).not.toContain('expires after 30 days');
      expect(counts(html)).toEqual({});
    },
  );

  it.each([
    { status: 'error' as const, synced: false },
    { status: 'ready' as const, synced: true },
  ])('keeps an empty unreadable list distinct from no TLS Secrets (%j)', (state) => {
    const html = render(
      snapshot([], { ...state, error: 'Secrets are forbidden', forbidden: true }),
    );
    expect(html).toContain('TLS Secrets could not be read.');
    expect(html).toContain('role="status"');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No TLS Secrets found.');
    expect(counts(html)).toEqual({});
  });

  it('reports no TLS Secrets only after a complete list arrives', () => {
    const html = render(snapshot());
    expect(html).toContain('No TLS Secrets found.');
    expect(html).not.toContain('Reading TLS certificates');
    expect(html).not.toContain('could not be read');
    expect(counts(html)).toEqual({});
  });

  it('shows observed counts alongside the incomplete warning for a partially readable list', () => {
    const html = render(
      snapshot([secret('expired', -2.5), secret('renew-soon', 3), secret('renew-later', 12)], {
        error: 'Cannot list Secrets in restricted namespace',
        forbidden: true,
      }),
    );
    expect(html).toContain('Some Secrets could not be read. This TLS summary is incomplete.');
    expect(counts(html)).toEqual({
      'TLS Secrets': '3',
      Expired: '1',
      'Within 7 days': '1',
      'In 8–30 days': '1',
    });
    expect(html).toContain('Expired 2 days ago');
    expect(html).toContain('Expires in 3 days');
    expect(html).toContain('Expires in 12 days');
    expect(html).not.toContain('No TLS Secrets found.');
  });

  it('marks cached counts as incomplete while a watch resynchronizes', () => {
    const html = render(snapshot([secret('cached', 12)], { status: 'loading', synced: false }));
    expect(html).toContain('Updating TLS certificates. Counts may be incomplete.');
    expect(counts(html)['TLS Secrets']).toBe('1');
    expect(html).not.toContain('could not be read');
  });

  it('does not show an incompletely readable certificate bundle as valid', () => {
    const partial = secret('partial-bundle', 100);
    partial.data = {
      'tls.crt': btoa(restamp(STOREFRONT_LEAF, NOW - 90 * DAY, NOW + 100 * DAY) + BROKEN_CERT),
    };
    const html = render(snapshot([partial]));
    expect(counts(html)['TLS Secrets']).toBe('1');
    expect(html).toContain('Certificate unreadable');
    expect(html).toContain('1 TLS Secret has missing or unreadable certificate data');
    expect(html).not.toContain('expires after 30 days');
    expect(html).not.toContain('Expires in 100 days');
    expect(html).not.toContain('Next expiry');
  });

  it('renders expiry metadata without raw certificate, private key, or other Secret values', () => {
    const copies = ['checkout', 'payments', 'web'].map((namespace) =>
      secret('storefront-tls', 12, namespace),
    );
    const html = render(snapshot(copies));
    expect(rows(html)).toHaveLength(1);
    expect(html).toContain('storefront-tls');
    expect(html).toContain('checkout');
    expect(html).toContain('Expires in 12 days');
    expect(html).toContain('Next expiry');
    expect(html).not.toContain('tls.crt');
    expect(html).not.toContain('tls.key');
    expect(html).not.toContain('-----BEGIN');
    expect(html).not.toContain('DemoKeyOnly');
    expect(html).not.toContain('do-not-render-this-secret');
    for (const object of copies) {
      for (const value of Object.values(object.data as Record<string, string>)) {
        expect(html).not.toContain(value);
        expect(html).not.toContain(atob(value));
      }
    }
  });

  it('shows one certificate row with namespace buttons for copies across namespaces', () => {
    const html = render(
      snapshot(
        ['web', 'checkout', 'payments'].map((namespace) => secret('wildcard', 3, namespace)),
      ),
    );
    const list = rows(html);
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('>wildcard</span>');
    expect(namespaceButtons(list[0]!)).toEqual([
      { title: 'checkout/wildcard', namespace: 'checkout' },
      { title: 'payments/wildcard', namespace: 'payments' },
      { title: 'web/wildcard', namespace: 'web' },
    ]);
    // Inventory and expiry buckets still count each Secret copy.
    expect(counts(html)['TLS Secrets']).toBe('3');
    expect(counts(html)['Within 7 days']).toBe('3');
  });

  it('keeps distinct certificates with the same Secret name in separate rows', () => {
    const html = render(
      snapshot([secret('wildcard', 3, 'web'), secret('wildcard', 12, 'payments')]),
    );
    const list = rows(html);
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('>wildcard</span>');
    expect(list[0]).toContain('Expires in 3 days');
    expect(namespaceButtons(list[0]!)).toEqual([{ title: 'web/wildcard', namespace: 'web' }]);
    expect(list[1]).toContain('>wildcard</span>');
    expect(list[1]).toContain('Expires in 12 days');
    expect(namespaceButtons(list[1]!)).toEqual([
      { title: 'payments/wildcard', namespace: 'payments' },
    ]);
  });

  it('limits the list by certificate groups rather than individual Secret copies', () => {
    const copies = Array.from({ length: 8 }, (_, index) => secret('wildcard', 3, `copy-${index}`));
    const others = [12, 15, 18, 21, 24].map((days) => secret(`certificate-${days}`, days));
    const html = render(snapshot([...copies, ...others]));
    const list = rows(html);
    expect(list).toHaveLength(5);
    expect(list[0]).toContain('>wildcard</span>');
    expect(list.slice(1).map((row) => row.match(/title="(certificate-\d+)"/)?.[1])).toEqual([
      'certificate-12',
      'certificate-15',
      'certificate-18',
      'certificate-21',
    ]);
    expect(html).not.toContain('certificate-24');
    expect(html).toContain('Showing 5 of 6 certificate groups');
    expect(counts(html)['TLS Secrets']).toBe('13');
  });

  it('initially shows six namespace tags and a disclosure for all remaining copies', () => {
    const namespaces = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const html = render(snapshot(namespaces.map((namespace) => secret('wildcard', 3, namespace))));
    const list = rows(html);
    expect(list).toHaveLength(1);
    expect(namespaceButtons(list[0]!).map((button) => button.namespace)).toEqual(
      namespaces.slice(0, 6),
    );
    expect(list[0]).toMatch(/<button\b[^>]*>Show all 8<\/button>/);
    expect(html).not.toContain('title="g/wildcard"');
    expect(html).not.toContain('title="h/wildcard"');
    expect(html).not.toContain('Showing 5 of');
    expect(counts(html)['TLS Secrets']).toBe('8');
  });

  it('shows the earliest certificate’s namespaces in both locations without nested buttons', () => {
    const html = render(
      snapshot([
        secret('soonest', 3, 'payments'),
        secret('later', 12, 'other'),
        secret('soonest', 3, 'checkout'),
      ]),
    );
    const nextExpiry = html.split('<ul')[0]!;
    const earliestTags = [
      { title: 'checkout/soonest', namespace: 'checkout' },
      { title: 'payments/soonest', namespace: 'payments' },
    ];
    expect(nextExpiry).toContain('Next expiry');
    expect(namespaceButtons(nextExpiry)).toEqual(earliestTags);
    expect(namespaceButtons(rows(html)[0]!)).toEqual(earliestTags);

    let buttonDepth = 0;
    for (const match of html.matchAll(/<\/?button\b[^>]*>/g)) {
      buttonDepth += match[0].startsWith('</') ? -1 : 1;
      expect(buttonDepth).toBeGreaterThanOrEqual(0);
      expect(buttonDepth).toBeLessThanOrEqual(1);
    }
    expect(buttonDepth).toBe(0);
  });

  it.each([false, true])(
    'passes active=%s to the all-namespace watch and expiry clock',
    (isActive) => {
      render(snapshot(), isActive);
      expect(mocked.watch).toHaveBeenCalledOnce();
      expect(mocked.watch).toHaveBeenCalledWith(
        'c-tls-test',
        { group: '', version: 'v1', kind: 'Secret', plural: 'secrets', namespaced: true },
        [],
        isActive,
      );
      expect(mocked.now).toHaveBeenCalledWith(30_000, isActive);
    },
  );
});
