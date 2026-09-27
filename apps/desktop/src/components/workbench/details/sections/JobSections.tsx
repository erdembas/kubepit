import * as i18n from '@/i18n';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  isObject,
  spec,
  status,
} from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { RefLink } from '@/lib/kube/columns/cells';
import { jobBucket, jobCompletions, jobDuration } from '@/lib/kube/workloads';
import { formatAge } from '@/lib/format';
import { useWatch } from '../../data/watchCache';
import { MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { PodsMiniTable } from '../PodsMiniTable';
import { ConditionsTable } from './PodSections';
import { TemplateContainers } from './WorkloadSections';
import type { SectionProps } from './types';

const JOB_GVK = toGvk(BUILTIN.Job);

function duration(ms: number | null) {
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
      : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function JobSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const c = jobCompletions(obj);
  const b = jobBucket(obj);
  return (
    <>
      <Section title={i18n.t('Job')}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText
              tone={
                b === 'succeeded'
                  ? 'success'
                  : b === 'failed'
                    ? 'error'
                    : b === 'suspended'
                      ? 'muted'
                      : 'info'
              }
            >
              {b === 'succeeded'
                ? 'Complete'
                : b === 'failed'
                  ? 'Failed'
                  : b === 'suspended'
                    ? 'Suspended'
                    : 'Running'}
            </ToneText>
          </Row>
          <Row label={i18n.t('Completions')}>{`${c.succeeded}/${c.completions}`}</Row>
          <Row label={i18n.t('Parallelism')}>{asString(s.parallelism) || '1'}</Row>
          <Row label={i18n.t('Backoff limit')}>{asString(s.backoffLimit)}</Row>
          <Row label={i18n.t('Pods')}>
            {i18n.t('{active} active · {succeeded} succeeded · {failed} failed', {
              active: asNumber(st.active),
              succeeded: asNumber(st.succeeded),
              failed: asNumber(st.failed),
            })}
          </Row>
          <Row label={i18n.t('Started')}>
            {asString(st.startTime) &&
              i18n.t('{age} ago', { age: formatAge(asString(st.startTime), ctx.now) })}
          </Row>
          <Row label={i18n.t('Duration')}>{duration(jobDuration(obj, ctx.now))}</Row>
          <Row label={i18n.t('TTL after finished')}>
            {s.ttlSecondsAfterFinished !== undefined
              ? `${asString(s.ttlSecondsAfterFinished)}s`
              : null}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
      <Section title={i18n.t('Pods')}>
        <PodsMiniTable
          ctx={ctx}
          namespace={obj.metadata.namespace ?? null}
          isActive={isActive}
          match={(p) =>
            p.metadata.ownerReferences?.some((r) => r.uid === obj.metadata.uid) ?? false
          }
        />
      </Section>
    </>
  );
}

export function CronJobSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const jobs = useWatch(
    ctx.clusterId,
    JOB_GVK,
    obj.metadata.namespace ? [obj.metadata.namespace] : [],
    isActive,
  );
  const owned = jobs.items
    .filter((j) => j.metadata.ownerReferences?.some((r) => r.uid === obj.metadata.uid))
    .sort(
      (a, b) =>
        Date.parse(b.metadata.creationTimestamp ?? '') -
        Date.parse(a.metadata.creationTimestamp ?? ''),
    );
  return (
    <>
      <Section title={i18n.t('CronJob')}>
        <Rows>
          <Row label={i18n.t('Schedule')}>
            <MonoText>{asString(s.schedule)}</MonoText>
            {asString(s.timeZone) && (
              <span className="text-fg-dim ml-1.5 text-[11px]">{asString(s.timeZone)}</span>
            )}
          </Row>
          <Row label={i18n.t('Suspended')}>
            {s.suspend === true ? (
              <ToneText tone="warning">{i18n.t('Yes')}</ToneText>
            ) : (
              i18n.t('No')
            )}
          </Row>
          <Row label={i18n.t('Concurrency')}>{asString(s.concurrencyPolicy)}</Row>
          <Row label={i18n.t('History limits')}>
            {i18n.t('{ok} successful · {failed} failed', {
              ok: asString(s.successfulJobsHistoryLimit) || '3',
              failed: asString(s.failedJobsHistoryLimit) || '1',
            })}
          </Row>
          <Row label={i18n.t('Last schedule')}>
            {asString(st.lastScheduleTime) &&
              i18n.t('{age} ago', { age: formatAge(asString(st.lastScheduleTime), ctx.now) })}
          </Row>
          <Row label={i18n.t('Last success')}>
            {asString(st.lastSuccessfulTime) &&
              i18n.t('{age} ago', { age: formatAge(asString(st.lastSuccessfulTime), ctx.now) })}
          </Row>
          <Row label={i18n.t('Active')}>
            {asArray(st.active).length > 0 && (
              <span className="flex flex-col">
                {asArray(st.active)
                  .filter(isObject)
                  .map((r) => (
                    <RefLink
                      key={asString(r.uid)}
                      target={{
                        apiVersion: 'batch/v1',
                        kind: 'Job',
                        name: asString(r.name),
                        namespace: asString(r.namespace),
                      }}
                      ctx={ctx}
                    />
                  ))}
              </span>
            )}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Jobs')}>
        <MiniTable
          rows={owned}
          rowKey={(j) => j.metadata.uid}
          empty={i18n.t('No jobs')}
          columns={[
            {
              label: i18n.t('Name'),
              cell: (j) => (
                <RefLink
                  target={{
                    apiVersion: 'batch/v1',
                    kind: 'Job',
                    name: j.metadata.name,
                    namespace: j.metadata.namespace ?? null,
                  }}
                  ctx={ctx}
                />
              ),
            },
            {
              label: i18n.t('Completions'),
              cell: (j) => `${jobCompletions(j).succeeded}/${jobCompletions(j).completions}`,
            },
            { label: i18n.t('Duration'), cell: (j) => duration(jobDuration(j, ctx.now)) ?? '—' },
            {
              label: i18n.t('Age'),
              className: 'text-right',
              cell: (j) => formatAge(j.metadata.creationTimestamp, ctx.now),
            },
            {
              label: i18n.t('Status'),
              cell: (j) => {
                const jb = jobBucket(j);
                return (
                  <ToneText
                    tone={jb === 'succeeded' ? 'success' : jb === 'failed' ? 'error' : 'info'}
                  >
                    {jb === 'succeeded' ? 'Complete' : jb === 'failed' ? 'Failed' : 'Running'}
                  </ToneText>
                );
              },
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('Job template')}>
        <TemplateContainers template={asObject(asObject(s.jobTemplate).spec).template} />
      </Section>
    </>
  );
}
