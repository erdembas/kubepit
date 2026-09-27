import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asString, condition, spec, status } from '../accessors';
import { certificateExpiry, objectCertificates, type X509Certificate } from '../x509';
import { makeFinding, type Emit } from './context';

/** TLS certificates held in Secrets and cert-manager `Certificate` resources. */

export function isCertManagerCertificate(obj: KubeObject): boolean {
  return obj.kind === 'Certificate' && obj.apiVersion.startsWith('cert-manager.io/');
}

function certLabel(c: Pick<X509Certificate, 'subject' | 'sans' | 'serial'>): string {
  return c.subject.cn || c.sans[0] || c.serial;
}

function expiryFinding(
  obj: KubeObject,
  label: string,
  key: string,
  notBefore: number,
  notAfter: number,
  now: number,
  emit: Emit,
) {
  const { state, daysLeft } = certificateExpiry({ notBefore, notAfter }, now);
  if (state === 'expired') {
    const days = Math.max(0, -daysLeft - 1);
    emit(
      makeFinding(
        'certificate-expired',
        obj,
        key
          ? i18n.plural(
              'Certificate {name} in {key} expired {count} day ago',
              'Certificate {name} in {key} expired {count} days ago',
              days,
              { name: label, key },
            )
          : i18n.plural(
              'Certificate {name} expired {count} day ago',
              'Certificate {name} expired {count} days ago',
              days,
              { name: label },
            ),
        key,
      ),
    );
  } else if (state === 'expiring') {
    emit(
      makeFinding(
        'certificate-expiring',
        obj,
        key
          ? i18n.plural(
              'Certificate {name} in {key} expires in {count} day',
              'Certificate {name} in {key} expires in {count} days',
              daysLeft,
              { name: label, key },
            )
          : i18n.plural(
              'Certificate {name} expires in {count} day',
              'Certificate {name} expires in {count} days',
              daysLeft,
              { name: label },
            ),
        key,
      ),
    );
  }
}

/** The soonest-expiring certificate of a Secret decides its finding. */
export function secretCertificateFindings(secret: KubeObject, now: number, emit: Emit) {
  let soonest: { key: string; cert: X509Certificate } | null = null;
  for (const entry of objectCertificates(secret))
    for (const cert of entry.certs)
      if (!soonest || cert.notAfter < soonest.cert.notAfter) soonest = { key: entry.key, cert };
  if (soonest)
    expiryFinding(
      secret,
      certLabel(soonest.cert),
      soonest.key,
      soonest.cert.notBefore,
      soonest.cert.notAfter,
      now,
      emit,
    );
}

/**
 * cert-manager Certificates: the Ready condition, plus `status.notAfter`
 * when `withExpiry` (the issued secret could not be inspected).
 */
export function certManagerFindings(
  cert: KubeObject,
  now: number,
  withExpiry: boolean,
  emit: Emit,
) {
  const ready = condition(cert, 'Ready');
  if (ready && ready.status !== 'True')
    emit(
      makeFinding(
        'certificate-not-ready',
        cert,
        ready.message
          ? i18n.t('Not ready: {message}', { message: ready.message })
          : i18n.t('Certificate is not ready'),
      ),
    );
  const notAfter = Date.parse(asString(status(cert).notAfter));
  if (!withExpiry || !Number.isFinite(notAfter)) return;
  const notBefore = Date.parse(asString(status(cert).notBefore));
  const label = asString(asArray(spec(cert).dnsNames)[0]) || cert.metadata.name;
  expiryFinding(cert, label, '', Number.isFinite(notBefore) ? notBefore : 0, notAfter, now, emit);
}
