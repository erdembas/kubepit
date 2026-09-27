import * as i18n from '@/i18n';
import { Info, Loader2, UserRound } from 'lucide-react';
import type { ClusterDef } from '@/types';
import { ChipList, CopyButton, MonoText } from '../details/primitives';
import { isUnsupported, useWhoAmI } from './hooks';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-dim truncate pt-0.5" title={label}>
        {label}
      </dt>
      <dd className="text-fg min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Who the API server thinks you are (SelfSubjectReview), with copy buttons. */
export function IdentityCard({ cluster, isActive }: { cluster: ClusterDef; isActive: boolean }) {
  i18n.useLocale();
  const who = useWhoAmI(cluster.id, isActive);
  const data = who.data;
  const extra = Object.entries(data?.extra ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="border-border bg-surface-raised/40 rounded-lg border">
      <header className="border-border/60 flex h-10 items-center gap-2 border-b px-3">
        <UserRound className="text-fg-dim h-3.5 w-3.5" />
        <h3 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Identity')}
        </h3>
        {who.loading && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
      </header>
      <div className="px-3 py-3">
        {!data && who.error ? (
          isUnsupported(who.error) ? (
            <p className="text-fg-muted flex items-start gap-2 text-[12px] leading-relaxed">
              <Info className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" />
              {i18n.t(
                'This cluster cannot report who you are: SelfSubjectReview needs Kubernetes 1.28 or newer (1.27 with the beta API). Permissions below still work.',
              )}
            </p>
          ) : (
            <p className="text-status-error text-[12px] break-words">{who.error}</p>
          )
        ) : !data ? (
          <p className="text-fg-dim flex items-center gap-2 text-[12px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {i18n.t('Loading…')}
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(80px,110px)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
            <Field label={i18n.t('User')}>
              <span className="flex items-start gap-1">
                <MonoText>{data.username || '—'}</MonoText>
                {data.username && (
                  <CopyButton text={data.username} label={i18n.t('Copy user name')} />
                )}
              </span>
            </Field>
            {data.uid && (
              <Field label={i18n.t('UID')}>
                <span className="flex items-start gap-1">
                  <MonoText>{data.uid}</MonoText>
                  <CopyButton text={data.uid} label={i18n.t('Copy UID')} />
                </span>
              </Field>
            )}
            <Field label={i18n.t('Groups')}>
              <span className="flex items-start gap-1">
                <span className="min-w-0 flex-1">
                  <ChipList entries={data.groups} limit={8} />
                </span>
                {data.groups.length > 0 && (
                  <CopyButton text={data.groups.join('\n')} label={i18n.t('Copy groups')} />
                )}
              </span>
            </Field>
            {extra.map(([key, values]) => (
              <Field key={key} label={key}>
                <ChipList entries={values} limit={4} />
              </Field>
            ))}
            <Field label={i18n.t('Context')}>
              <MonoText>{cluster.context}</MonoText>
            </Field>
          </dl>
        )}
      </div>
    </section>
  );
}
