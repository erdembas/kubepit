import { describe, expect, it } from 'vitest';
import {
  DEMO_ISSUER_CA,
  KUBE_ROOT_CA,
  STOREFRONT_LEAF,
  restamp,
} from '@/lib/ipc/mock/fixtures/certs';
import type { KubeObject } from '@/types';
import { summarizeTlsSecrets } from './tlsSummary';

const NOW = Date.UTC(2026, 8, 29, 12);
const DAY = 86_400_000;
const BROKEN_CERT = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----';

function pem(expiresInDays: number, source = STOREFRONT_LEAF, startsInDays = -90): string {
  return restamp(source, NOW + startsInDays * DAY, NOW + expiresInDays * DAY);
}

function secret(
  name: string,
  certificate?: string,
  namespace = 'default',
  type = 'kubernetes.io/tls',
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type,
    metadata: { name, namespace, uid: `${namespace}/${name}` },
    data: certificate === undefined ? {} : { 'tls.crt': btoa(certificate) },
  };
}

function rewrap(pem: string): string {
  const body = pem.replace(/-----[^\n]+-----|\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\r\n${body.match(/.{1,25}/g)!.join(' \r\n')}\r\n-----END CERTIFICATE-----\r\n`;
}

function changeSignature(pem: string): string {
  const binary = atob(pem.replace(/-----[^\n]+-----|\s+/g, ''));
  const changed =
    binary.slice(0, -1) + String.fromCharCode(binary.charCodeAt(binary.length - 1) ^ 1);
  return `-----BEGIN CERTIFICATE-----\n${btoa(changed)}\n-----END CERTIFICATE-----\n`;
}

describe('TLS Secret overview summary', () => {
  it('counts each Secret once, preferring its earliest leaf over bundled or separate CAs', () => {
    const object = secret('service', pem(1, DEMO_ISSUER_CA) + pem(80) + pem(12));
    object.data = { ...(object.data as object), 'ca.crt': btoa(pem(-5, KUBE_ROOT_CA)) };
    const summary = summarizeTlsSecrets([object], NOW);

    expect(summary.total).toBe(1);
    expect(summary.days8To30).toBe(1);
    expect(summary.expired).toBe(0);
    expect(summary.entries[0]?.certificate?.isCA).toBe(false);
    expect(summary.entries[0]?.expiry).toEqual({ state: 'expiring', daysLeft: 12 });
    expect(summary.entries[0]?.object).toBe(object);
  });

  it('includes Opaque TLS data and CA-only typed TLS Secrets, excluding generic CA and non-Secret data', () => {
    const tlsCa = secret('root-ca', pem(400, KUBE_ROOT_CA) + pem(60, DEMO_ISSUER_CA));
    const opaqueTls = secret('opaque-tls', pem(20), 'default', 'Opaque');
    const opaqueCa = {
      ...secret('opaque-ca', undefined, 'default', 'Opaque'),
      data: { 'ca.crt': btoa(pem(-1, KUBE_ROOT_CA)) },
    };
    const configmap = { ...secret('configmap', pem(-1)), kind: 'ConfigMap' };
    const summary = summarizeTlsSecrets(
      [tlsCa, opaqueTls, opaqueCa, configmap, secret('password', undefined, 'default', 'Opaque')],
      NOW,
    );

    expect(summary.total).toBe(2);
    expect(summary.days8To30).toBe(1);
    expect(summary.valid).toBe(1);
    expect(summary.entries.find((entry) => entry.object === tlsCa)?.certificate?.isCA).toBe(true);
    expect(summary.entries.find((entry) => entry.object === tlsCa)?.expiry?.daysLeft).toBe(60);
  });

  it('keeps expiry buckets exclusive at the exact zero, seven-day and thirty-day boundaries', () => {
    const summary = summarizeTlsSecrets(
      [
        secret('expired', pem(-1)),
        secret('expires-now', pem(0)),
        secret('today', pem(0.5)),
        secret('seven', pem(7)),
        secret('after-seven', pem(7 + (1 / DAY) * 1000)),
        secret('thirty', pem(30)),
        secret('after-thirty', pem(30 + (1 / DAY) * 1000)),
      ],
      NOW,
    );

    expect(summary).toMatchObject({
      total: 7,
      expired: 2,
      within7Days: 2,
      days8To30: 2,
      valid: 1,
      notYetValid: 0,
      unknown: 0,
    });
    expect(summary.entries.map((entry) => [entry.object.metadata.name, entry.status])).toEqual([
      ['expired', 'expired'],
      ['expires-now', 'expired'],
      ['today', 'within7Days'],
      ['seven', 'within7Days'],
      ['after-seven', 'days8To30'],
      ['thirty', 'days8To30'],
      ['after-thirty', 'valid'],
    ]);
    expect(summary.earliestExpiry?.object.metadata.name).toBe('today');
  });

  it('separates certificates that are not yet valid from currently valid certificates', () => {
    const summary = summarizeTlsSecrets(
      [
        secret('starts-later', pem(2, STOREFRONT_LEAF, 1)),
        secret('starts-now', pem(40, STOREFRONT_LEAF, 0)),
      ],
      NOW,
    );
    expect(summary).toMatchObject({
      total: 2,
      notYetValid: 1,
      valid: 1,
      within7Days: 0,
      days8To30: 0,
    });
    expect(summary.earliestExpiry?.object.metadata.name).toBe('starts-later');
  });

  it('classifies missing, unreadable, and incomplete bundles as unknown, preserving known expiry for inspection', () => {
    const invalidBase64 = secret('base64');
    invalidBase64.data = { 'tls.crt': '%%%not-base64' };
    const wrongShape = secret('wrong-shape');
    wrongShape.data = { 'tls.crt': { certificate: 'bad' } };
    const partial = secret('partial', pem(100) + BROKEN_CERT);
    const truncated = secret('truncated', pem(40) + '-----BEGIN CERTIFICATE-----\nunfinished');
    const summary = summarizeTlsSecrets(
      [
        secret('missing'),
        secret('empty', ''),
        secret('plain-text', 'hello'),
        secret('broken', BROKEN_CERT),
        invalidBase64,
        wrongShape,
        partial,
        truncated,
      ],
      NOW,
    );

    expect(summary).toMatchObject({ total: 8, unknown: 8, valid: 0, earliestExpiry: null });
    expect(summary.entries.every((entry) => entry.invalid && entry.status === 'unknown')).toBe(
      true,
    );
    expect(summary.entries.find((entry) => entry.object === partial)?.expiry?.daysLeft).toBe(100);
    expect(summary.entries.find((entry) => entry.object === truncated)?.expiry?.daysLeft).toBe(40);
    expect(
      summary.entries.find((entry) => entry.object.metadata.name === 'missing')?.certificate,
    ).toBeNull();
  });

  it('does not substitute a readable ca.crt for missing or invalid tls.crt', () => {
    const object = secret('broken-tls', BROKEN_CERT);
    object.data = { ...(object.data as object), 'ca.crt': btoa(pem(400, KUBE_ROOT_CA)) };
    const summary = summarizeTlsSecrets([object], NOW);
    expect(summary.unknown).toBe(1);
    expect(summary.entries[0]?.certificate).toBeNull();
  });

  it('keeps same-name Secrets in different namespaces and orders issue rows deterministically', () => {
    const objects = [
      secret('healthy', pem(40)),
      secret('missing'),
      secret('future', pem(60, STOREFRONT_LEAF, 1)),
      secret('later', pem(25)),
      secret('shared', pem(3), 'zeta'),
      secret('shared', pem(3), 'alpha'),
      secret('another', pem(3), 'alpha'),
      secret('expired', pem(-1)),
    ];
    const summary = summarizeTlsSecrets(objects, NOW);
    expect(summary.total).toBe(8);
    expect(
      summary.entries.map(
        (entry) => `${entry.object.metadata.namespace}/${entry.object.metadata.name}`,
      ),
    ).toEqual([
      'default/expired',
      'alpha/another',
      'alpha/shared',
      'zeta/shared',
      'default/later',
      'default/future',
      'default/missing',
      'default/healthy',
    ]);
    expect(summarizeTlsSecrets([...objects].reverse(), NOW).entries).toEqual(summary.entries);
    expect(summary.earliestExpiry?.object.metadata.name).toBe('another');
    expect(summarizeTlsSecrets([...objects].reverse(), NOW).earliestExpiry).toBeDefined();
    expect(summarizeTlsSecrets([...objects].reverse(), NOW).earliestExpiry?.object).toBe(
      summary.earliestExpiry?.object,
    );
  });

  it('does not claim a bundle is healthy when it exceeds the certificate parser limit', () => {
    const summary = summarizeTlsSecrets([secret('oversized-bundle', pem(40).repeat(65))], NOW);
    expect(summary).toMatchObject({ total: 1, unknown: 1, valid: 0, earliestExpiry: null });
    expect(summary.entries[0]?.invalid).toBe(true);
  });

  it('groups the same certificate across namespaces and Secret names, preserving per-Secret counts', () => {
    const objects = [
      secret('wildcard', pem(12), 'zeta'),
      secret('wildcard', pem(12), 'alpha'),
      secret('other-name', pem(12), 'alpha'),
    ];
    const summary = summarizeTlsSecrets(objects, NOW);
    expect(summary).toMatchObject({ total: 3, days8To30: 3 });
    expect(summary.entries).toHaveLength(3);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.namespaces).toEqual(['alpha', 'zeta']);
    expect(summary.groups[0]?.members.map((entry) => entry.object.metadata.uid)).toEqual([
      'alpha/other-name',
      'alpha/wildcard',
      'zeta/wildcard',
    ]);
    expect(summary.groups[0]?.id).toBe('alpha/other-name');
    expect(summary.groups[0]?.entry).toBe(summary.earliestExpiry);
    expect(summarizeTlsSecrets([...objects].reverse(), NOW).groups).toEqual(summary.groups);
  });

  it('does not merge same-name Secrets that hold different certificates', () => {
    const summary = summarizeTlsSecrets(
      [secret('wildcard', pem(3), 'alpha'), secret('wildcard', pem(12), 'beta')],
      NOW,
    );
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.map((group) => group.entry.expiry?.daysLeft)).toEqual([3, 12]);
    expect(summary).toMatchObject({ total: 2, within7Days: 1, days8To30: 1 });
  });

  it('compares all DER bytes, keeping distinct signatures separate despite identical exposed metadata', () => {
    const certificate = pem(12);
    const summary = summarizeTlsSecrets(
      [
        secret('original', certificate, 'alpha'),
        secret('other-signature', changeSignature(certificate), 'beta'),
      ],
      NOW,
    );
    expect(summary.entries[0]?.certificate).toEqual(summary.entries[1]?.certificate);
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.map((group) => group.members.length)).toEqual([1, 1]);
  });

  it('groups identical leaf DER regardless of PEM whitespace or accompanying CA chain', () => {
    const certificate = pem(12);
    const summary = summarizeTlsSecrets(
      [
        secret('first', certificate + pem(200, DEMO_ISSUER_CA), 'alpha'),
        secret('second', pem(100, KUBE_ROOT_CA) + rewrap(certificate), 'beta'),
      ],
      NOW,
    );
    expect(summary.unknown).toBe(0);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.namespaces).toEqual(['alpha', 'beta']);
  });

  it('keeps unreadable and incomplete copies separate from each other and readable copies', () => {
    const certificate = pem(12);
    const summary = summarizeTlsSecrets(
      [
        secret('valid', certificate),
        secret('partial-a', certificate + BROKEN_CERT),
        secret('partial-b', certificate + BROKEN_CERT),
        secret('missing-a'),
        secret('missing-b'),
      ],
      NOW,
    );
    expect(summary).toMatchObject({ total: 5, unknown: 4, days8To30: 1 });
    expect(summary.groups).toHaveLength(5);
    expect(summary.groups.every((group) => group.members.length === 1)).toBe(true);
  });

  it('preserves severity and expiry order when several issue rows contain namespace copies', () => {
    const summary = summarizeTlsSecrets(
      [
        secret('healthy', pem(60)),
        secret('soon', pem(2), 'zeta'),
        secret('expired', pem(-1), 'zeta'),
        secret('soon', pem(2), 'alpha'),
        secret('missing'),
        secret('expired', pem(-1), 'alpha'),
      ],
      NOW,
    );
    expect(summary.groups.map((group) => group.entry.status)).toEqual([
      'expired',
      'within7Days',
      'unknown',
      'valid',
    ]);
    expect(summary.groups.map((group) => group.members.length)).toEqual([2, 2, 1, 1]);
    expect(summary).toMatchObject({ total: 6, expired: 2, within7Days: 2, unknown: 1, valid: 1 });
  });

  it('returns an empty summary with no future expiry when there are no TLS Secrets', () => {
    expect(summarizeTlsSecrets([], NOW)).toEqual({
      entries: [],
      groups: [],
      total: 0,
      expired: 0,
      within7Days: 0,
      days8To30: 0,
      valid: 0,
      notYetValid: 0,
      unknown: 0,
      earliestExpiry: null,
    });
  });
});
