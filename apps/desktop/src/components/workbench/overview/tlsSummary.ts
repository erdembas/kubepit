import { asObject } from '@/lib/kube/accessors';
import {
  certificateExpiry,
  certificateIdentity,
  objectCertificates,
  type Expiry,
  type X509Certificate,
} from '@/lib/kube/x509';
import type { KubeObject } from '@/types';

const DAY_MS = 86_400_000;

export type TlsSecretStatus =
  'expired' | 'within7Days' | 'days8To30' | 'valid' | 'notYetValid' | 'unknown';

export interface TlsSecretEntry {
  object: KubeObject;
  certificate: X509Certificate | null;
  expiry: Expiry | null;
  /** Missing, unreadable or incompletely parsed tls.crt data. */
  invalid: boolean;
  status: TlsSecretStatus;
}

export interface TlsCertificateGroup {
  /** Representative Secret UID, never the certificate's DER identity. */
  id: string;
  entry: TlsSecretEntry;
  members: TlsSecretEntry[];
  namespaces: string[];
}

export interface TlsSecretSummary {
  entries: TlsSecretEntry[];
  groups: TlsCertificateGroup[];
  total: number;
  expired: number;
  within7Days: number;
  days8To30: number;
  valid: number;
  notYetValid: number;
  unknown: number;
  /** Earliest future expiry from a fully readable bundle. */
  earliestExpiry: TlsSecretEntry | null;
}

/** Catch truncated blocks and the parser's bounded-bundle limit as incomplete data. */
function completeBundle(raw: unknown, parsed: number): boolean {
  if (typeof raw !== 'string' || parsed === 0) return false;
  try {
    const pem = atob(raw.replace(/\s+/g, ''));
    const begins = pem.match(/-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----/g)?.length ?? 0;
    const ends = pem.match(/-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g)?.length ?? 0;
    return begins === parsed && ends === parsed;
  } catch {
    return false;
  }
}

function entryStatus(
  certificate: X509Certificate | null,
  expiry: Expiry | null,
  invalid: boolean,
  now: number,
): TlsSecretStatus {
  if (invalid || !certificate || !expiry) return 'unknown';
  switch (expiry.state) {
    case 'expired':
      return 'expired';
    case 'not-yet-valid':
      return 'notYetValid';
    case 'valid':
      return 'valid';
    case 'expiring':
      return certificate.notAfter - now <= 7 * DAY_MS ? 'within7Days' : 'days8To30';
  }
}

const PRIORITY: Record<TlsSecretStatus, number> = {
  expired: 0,
  within7Days: 1,
  days8To30: 2,
  notYetValid: 3,
  unknown: 4,
  valid: 5,
};

function compareEntries(a: TlsSecretEntry, b: TlsSecretEntry): number {
  return (
    PRIORITY[a.status] - PRIORITY[b.status] ||
    (a.certificate?.notAfter ?? Infinity) - (b.certificate?.notAfter ?? Infinity) ||
    (a.object.metadata.namespace ?? '').localeCompare(b.object.metadata.namespace ?? '') ||
    a.object.metadata.name.localeCompare(b.object.metadata.name)
  );
}

/** Input is already sorted by severity, expiry and namespace/name. */
function groupCertificates(entries: TlsSecretEntry[]): TlsCertificateGroup[] {
  const groups: TlsCertificateGroup[] = [];
  const byCertificate = new Map<string, TlsCertificateGroup>();
  for (const entry of entries) {
    const identity =
      !entry.invalid && entry.certificate ? certificateIdentity(entry.certificate) : null;
    const existing = identity ? byCertificate.get(identity) : undefined;
    if (existing) {
      existing.members.push(entry);
      const namespace = entry.object.metadata.namespace ?? '';
      if (!existing.namespaces.includes(namespace)) existing.namespaces.push(namespace);
      continue;
    }
    const group: TlsCertificateGroup = {
      id:
        entry.object.metadata.uid ||
        `${entry.object.metadata.namespace ?? ''}/${entry.object.metadata.name}`,
      entry,
      members: [entry],
      namespaces: [entry.object.metadata.namespace ?? ''],
    };
    groups.push(group);
    if (identity) byCertificate.set(identity, group);
  }
  return groups;
}

/** One entry per TLS Secret, preferring service certificates over their CA chain. */
export function summarizeTlsSecrets(objects: readonly KubeObject[], now: number): TlsSecretSummary {
  const summary: TlsSecretSummary = {
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
  };
  for (const object of objects) {
    const data = asObject(object.data);
    if (
      object.kind !== 'Secret' ||
      (object.type !== 'kubernetes.io/tls' && !Object.hasOwn(data, 'tls.crt'))
    )
      continue;

    const bundle = objectCertificates(object).find((entry) => entry.key === 'tls.crt');
    const certificates = bundle?.certs ?? [];
    const leaves = certificates.filter((cert) => !cert.isCA);
    const candidates = leaves.length ? leaves : certificates;
    const certificate = candidates.reduce<X509Certificate | null>(
      (soonest, cert) => (!soonest || cert.notAfter < soonest.notAfter ? cert : soonest),
      null,
    );
    const invalid =
      !bundle || bundle.invalid > 0 || !completeBundle(data['tls.crt'], certificates.length);
    const expiry = certificate ? certificateExpiry(certificate, now) : null;
    const entry: TlsSecretEntry = {
      object,
      certificate,
      expiry,
      invalid,
      status: entryStatus(certificate, expiry, invalid, now),
    };
    summary.entries.push(entry);
    summary.total++;
    summary[entry.status]++;
    if (
      !invalid &&
      certificate &&
      certificate.notAfter > now &&
      (!summary.earliestExpiry ||
        certificate.notAfter < summary.earliestExpiry.certificate!.notAfter ||
        (certificate.notAfter === summary.earliestExpiry.certificate!.notAfter &&
          compareEntries(entry, summary.earliestExpiry) < 0))
    ) {
      summary.earliestExpiry = entry;
    }
  }
  summary.entries.sort(compareEntries);
  summary.groups = groupCertificates(summary.entries);
  return summary;
}
