import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { StatusTone } from '../pods';
import { certificateExpiry, earliestNotAfter, type ExpiryState } from '../x509';
import { Dash, Tone } from './cells';
import type { ColumnDef } from './types';

/** "Expires" column for Secrets holding certificates (TLS secrets, CA bundles). */

const TONE: Record<ExpiryState, StatusTone> = {
  expired: 'error',
  expiring: 'warning',
  valid: 'muted',
  'not-yet-valid': 'info',
};

export const certificateExpiryColumn: ColumnDef = {
  id: 'expires',
  label: () => i18n.t('Expires'),
  width: '104px',
  align: 'right',
  cell: (o, ctx) => {
    const cert = earliestNotAfter(o);
    if (!cert) return <Dash />;
    const { state } = certificateExpiry(cert, ctx.now);
    const when = i18n.date(cert.notAfter, { dateStyle: 'medium', timeStyle: 'short' });
    return (
      <Tone tone={TONE[state]} title={`${cert.subject.cn || cert.serial} · ${when}`}>
        {state === 'expired'
          ? i18n.t('{age} ago', { age: formatAge(cert.notAfter, ctx.now) })
          : // formatAge measures back from `now`; mirror the future instant into the past.
            i18n.t('in {age}', { age: formatAge(2 * ctx.now - cert.notAfter, ctx.now) })}
      </Tone>
    );
  },
  sort: (o) => earliestNotAfter(o)?.notAfter ?? Number.MAX_SAFE_INTEGER,
};
