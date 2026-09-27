import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { ShieldCheck } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  condition,
  spec,
  status,
} from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { isCertManagerCertificate } from '@/lib/kube/health/certificates';
import {
  certificateExpiry,
  objectCertificates,
  type Expiry,
  type X509Certificate,
} from '@/lib/kube/x509';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { ChipList, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { GenericSections } from './GenericSections';
import type { SectionProps } from './types';

/** Certificate insight: cards for PEM data in Secrets / ConfigMaps and cert-manager Certificates. */

const EXPIRY_TONE: Record<Expiry['state'], BadgeTone> = {
  expired: 'critical',
  expiring: 'warning',
  valid: 'success',
  'not-yet-valid': 'info',
};

const EXPIRY_BAR: Record<Expiry['state'], string> = {
  expired: 'bg-status-error',
  expiring: 'bg-status-starting',
  valid: 'bg-status-running',
  'not-yet-valid': 'bg-cat-frontend',
};

export function expiryText(e: Expiry): string {
  switch (e.state) {
    case 'expired': {
      const days = Math.max(0, -e.daysLeft - 1);
      return i18n.plural('Expired {count} day ago', 'Expired {count} days ago', days);
    }
    case 'not-yet-valid':
      return i18n.t('Not valid yet');
    default:
      return i18n.plural('Expires in {count} day', 'Expires in {count} days', e.daysLeft);
  }
}

export function ExpiryBadge({ expiry }: { expiry: Expiry }) {
  i18n.useLocale();
  return (
    <Badge tone={EXPIRY_TONE[expiry.state]} size="sm">
      {expiryText(expiry)}
    </Badge>
  );
}

function dateTime(ms: number) {
  return i18n.date(ms, { dateStyle: 'medium', timeStyle: 'short' });
}

function Lifetime({ cert, now, expiry }: { cert: X509Certificate; now: number; expiry: Expiry }) {
  const span = cert.notAfter - cert.notBefore;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((now - cert.notBefore) / span) * 100)) : 100;
  return (
    <span className="bg-fg/8 relative block h-1.5 w-full overflow-hidden rounded-full">
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', EXPIRY_BAR[expiry.state])}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function CertificateCard({
  cert,
  dataKey,
  index,
  count,
  now,
}: {
  cert: X509Certificate;
  dataKey: string;
  index: number;
  count: number;
  now: number;
}) {
  i18n.useLocale();
  const expiry = certificateExpiry(cert, now);
  const title = cert.subject.cn || cert.sans[0] || cert.subject.dn || cert.serial;
  return (
    <div className="border-border/70 bg-surface-raised/40 rounded-app overflow-hidden border">
      <div className="border-border/60 flex items-center gap-2 border-b px-3 py-2">
        <ShieldCheck className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <span className="text-fg min-w-0 flex-1 truncate text-[12.5px] font-medium" title={title}>
          {title}
        </span>
        <span className="text-fg-dim shrink-0 font-mono text-[10.5px]">
          {count > 1 ? `${dataKey} #${index + 1}` : dataKey}
        </span>
        <ExpiryBadge expiry={expiry} />
      </div>
      <div className="space-y-3 px-3 py-2.5">
        <div className="space-y-1">
          <Lifetime cert={cert} now={now} expiry={expiry} />
          <div className="text-fg-dim flex justify-between text-[10.5px] tabular-nums">
            <span>{dateTime(cert.notBefore)}</span>
            <span>{dateTime(cert.notAfter)}</span>
          </div>
        </div>
        <Rows>
          <Row label={i18n.t('Subject')}>
            <MonoText>{cert.subject.dn || '—'}</MonoText>
          </Row>
          <Row label={i18n.t('Issuer')}>
            <span className="flex flex-wrap items-center gap-1.5">
              <MonoText>{cert.issuer.dn || '—'}</MonoText>
              {cert.selfSigned && (
                <Badge tone="neutral" variant="outline">
                  {i18n.t('Self-signed')}
                </Badge>
              )}
            </span>
          </Row>
          <Row label={i18n.t('Alternative names')}>
            {cert.sans.length > 0 && <ChipList entries={cert.sans} limit={6} />}
          </Row>
          <Row label={i18n.t('Certificate authority')}>
            {cert.isCA ? i18n.t('Yes') : i18n.t('No')}
          </Row>
          <Row label={i18n.t('Public key')}>{cert.keyAlgorithm}</Row>
          <Row label={i18n.t('Signature')}>{cert.signatureAlgorithm}</Row>
          <Row label={i18n.t('Serial number')}>
            <MonoText>{cert.serial}</MonoText>
          </Row>
        </Rows>
      </div>
    </div>
  );
}

/**
 * Parsed certificates of a Secret (`kubernetes.io/tls`, `*.crt`, `ca.crt`)
 * or ConfigMap (CA bundles). Private keys are never decoded or shown.
 */
export function CertificateCards({ obj, now }: { obj: KubeObject; now: number }) {
  i18n.useLocale();
  const entries = useMemo(() => objectCertificates(obj), [obj]);
  if (!entries.length) return null;
  const invalid = entries.reduce((n, e) => n + e.invalid, 0);
  return (
    <Section title={i18n.t('Certificates')}>
      <div className="space-y-2.5">
        {entries.flatMap((e) =>
          e.certs.map((cert, i) => (
            <CertificateCard
              key={`${e.key}|${i}`}
              cert={cert}
              dataKey={e.key}
              index={i}
              count={e.certs.length}
              now={now}
            />
          )),
        )}
        {invalid > 0 && (
          <p className="text-status-starting text-[11.5px]">
            {i18n.plural(
              '{count} certificate block could not be parsed',
              '{count} certificate blocks could not be parsed',
              invalid,
            )}
          </p>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// cert-manager.io/v1 Certificate
// ---------------------------------------------------------------------------

function Timestamp({ value, now }: { value: string; now: number }) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return (
    <span title={value}>
      {dateTime(ms)}
      <span className="text-fg-dim ml-1.5 text-[11px]">
        {ms > now
          ? // formatAge measures back from `now`; mirror the future instant into the past.
            i18n.t('in {age}', { age: formatAge(2 * now - ms, now) })
          : i18n.t('{age} ago', { age: formatAge(ms, now) })}
      </span>
    </span>
  );
}

function CertManagerSummary({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const ready = condition(obj, 'Ready');
  const issuer = asObject(s.issuerRef);
  const issuerKind = asString(issuer.kind) || 'Issuer';
  const notAfter = Date.parse(asString(st.notAfter));
  const notBefore = Date.parse(asString(st.notBefore));
  const expiry = Number.isFinite(notAfter)
    ? certificateExpiry(
        { notBefore: Number.isFinite(notBefore) ? notBefore : 0, notAfter },
        ctx.now,
      )
    : null;
  const key = asObject(s.privateKey);
  const ns = obj.metadata.namespace ?? null;
  return (
    <Section title={i18n.t('Certificate')}>
      <Rows>
        <Row label={i18n.t('Ready')}>
          {ready ? (
            <ToneText tone={ready.status === 'True' ? 'success' : 'error'} title={ready.message}>
              {ready.status === 'True' ? i18n.t('Yes') : ready.reason || i18n.t('No')}
            </ToneText>
          ) : (
            <span className="text-fg-dim">{i18n.t('Unknown')}</span>
          )}
        </Row>
        {ready?.message && ready.status !== 'True' && (
          <Row label={i18n.t('Message')}>
            <span className="text-fg-muted">{ready.message}</span>
          </Row>
        )}
        <Row label={i18n.t('Secret')}>
          {asString(s.secretName) && (
            <RefLink
              target={{
                apiVersion: 'v1',
                kind: 'Secret',
                name: asString(s.secretName),
                namespace: ns,
              }}
              ctx={ctx}
            />
          )}
        </Row>
        <Row label={i18n.t('Issuer')}>
          {asString(issuer.name) && (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="text-fg-dim text-[11px]">{issuerKind}</span>
              <RefLink
                target={{
                  apiVersion: `${asString(issuer.group) || 'cert-manager.io'}/v1`,
                  kind: issuerKind,
                  name: asString(issuer.name),
                  namespace: issuerKind === 'ClusterIssuer' ? null : ns,
                }}
                ctx={ctx}
              />
            </span>
          )}
        </Row>
        <Row label={i18n.t('Common name')}>
          {asString(s.commonName) && <MonoText>{asString(s.commonName)}</MonoText>}
        </Row>
        <Row label={i18n.t('DNS names')}>
          {asArray(s.dnsNames).length > 0 && (
            <ChipList entries={asArray(s.dnsNames).map((d) => asString(d))} limit={6} />
          )}
        </Row>
        <Row label={i18n.t('Not before')}>
          {asString(st.notBefore) && <Timestamp value={asString(st.notBefore)} now={ctx.now} />}
        </Row>
        <Row label={i18n.t('Not after')}>
          {expiry && (
            <span className="flex flex-wrap items-center gap-2">
              <Timestamp value={asString(st.notAfter)} now={ctx.now} />
              <ExpiryBadge expiry={expiry} />
            </span>
          )}
        </Row>
        <Row label={i18n.t('Renewal')}>
          {asString(st.renewalTime) && <Timestamp value={asString(st.renewalTime)} now={ctx.now} />}
        </Row>
        <Row label={i18n.t('Private key')}>
          {asString(key.algorithm) &&
            [asString(key.algorithm), key.size !== undefined ? asNumber(key.size) : null]
              .filter(Boolean)
              .join(' ')}
        </Row>
        <Row label={i18n.t('Revision')}>
          {st.revision !== undefined ? asNumber(st.revision) : null}
        </Row>
      </Rows>
    </Section>
  );
}

/** `Certificate` kind: cert-manager gets a summary; any other group keeps the generic view. */
export function CertificateKindSections(props: SectionProps) {
  if (!isCertManagerCertificate(props.obj)) return <GenericSections {...props} />;
  return (
    <>
      <CertManagerSummary {...props} />
      <GenericSections {...props} />
    </>
  );
}
