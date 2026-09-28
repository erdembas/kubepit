import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { CRON_PRESETS, describeCron, nextRuns, parseCron } from '@/lib/kube/wizards/cron';
import {
  buildCronJob,
  cronJobBlocked,
  cronJobDefaults,
  validateCronJob,
  type CronJobInput,
} from '@/lib/kube/wizards/cronjob';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import { GVK } from './data';
import { FieldError, FieldGrid, NamespaceSelect, Section } from './fields';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Istanbul', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo'];
  }
}

/** `kubectl create cronjob NAME --image=… --schedule=… -- command`. */
export function CronJobWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'cronjob' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [input, setInput] = useState<CronJobInput>(() => cronJobDefaults(request.namespace));
  const patch = (p: Partial<CronJobInput>) => setInput((s) => ({ ...s, ...p }));
  const errors = useMemo(() => validateCronJob(input), [input]);
  const yaml = useMemo(() => manifestYaml([buildCronJob(input)]), [input]);
  const zones = useMemo(timeZones, []);

  return (
    <WizardShell
      request={request}
      title={i18n.t('Create CronJob')}
      subtitle="kubectl create cronjob"
      yaml={yaml}
      namespace={input.namespace}
      blocked={cronJobBlocked(errors)}
      errors={errors}
      creates={[{ gvk: GVK.cronJob, namespace: input.namespace }]}
      onClose={onClose}
    >
      <FieldGrid>
        <Field label={i18n.t('Name')} error={input.name ? errors.name : null}>
          <Input
            mono
            autoFocus
            value={input.name}
            placeholder="nightly-report"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            onChange={(namespace) => patch({ namespace })}
          />
        </Field>
      </FieldGrid>
      <Field
        label={<span lang="en">{i18n.t('Image')}</span>}
        error={input.image ? errors.image : null}
      >
        <Input
          mono
          value={input.image}
          placeholder="busybox:1.37"
          onChange={(e) => patch({ image: e.target.value })}
        />
      </Field>
      <Field
        label={i18n.t('Command')}
        hint={i18n.t('Optional. Leave empty to run the image entrypoint.')}
        error={errors.command}
      >
        <Input
          mono
          value={input.command}
          placeholder={input.shell ? 'date; echo "report done"' : 'echo "Hello from Kubernetes"'}
          onChange={(e) => patch({ command: e.target.value })}
        />
      </Field>
      <Switch
        checked={input.shell}
        onChange={(shell) => patch({ shell })}
        label={i18n.t('Run through a shell (sh -c)')}
        description={i18n.t('Needed for pipes, variables and several commands.')}
      />

      <ScheduleSection input={input} error={errors.schedule} onChange={patch} />

      <Field
        label={i18n.t('Time zone')}
        hint={i18n.t('Empty: the time zone of kube-controller-manager (usually UTC).')}
        error={errors.timeZone}
      >
        <Input
          mono
          lang="en"
          value={input.timeZone}
          placeholder="Europe/Istanbul"
          list="kp-cron-zones"
          onChange={(e) => patch({ timeZone: e.target.value })}
        />
        <datalist id="kp-cron-zones">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </Field>

      <Section title={i18n.t('Behaviour')}>
        <FieldGrid>
          <Field
            label={i18n.t('Concurrency')}
            hint={i18n.t('What happens when a run is still active at the next schedule.')}
          >
            <Select<string>
              value={input.concurrencyPolicy}
              onChange={(v) => patch({ concurrencyPolicy: v as CronJobInput['concurrencyPolicy'] })}
              options={[
                { value: 'Forbid', label: i18n.t('Skip the new run (Forbid)') },
                { value: 'Replace', label: i18n.t('Replace the running job (Replace)') },
                { value: 'Allow', label: i18n.t('Run in parallel (Allow)') },
              ]}
              size="md"
              ariaLabel={i18n.t('Concurrency')}
              className="w-full"
            />
          </Field>
          <Field label={i18n.t('Restart policy')}>
            <Select<string>
              value={input.restartPolicy}
              onChange={(v) => patch({ restartPolicy: v as CronJobInput['restartPolicy'] })}
              options={[
                { value: 'OnFailure', label: i18n.t('Restart the container (OnFailure)') },
                { value: 'Never', label: i18n.t('New pod per retry (Never)') },
              ]}
              size="md"
              ariaLabel={i18n.t('Restart policy')}
              className="w-full"
            />
          </Field>
        </FieldGrid>
        <div className="grid gap-3 @md:grid-cols-4">
          <Field label={i18n.t('Kept successful')}>
            <Input
              type="number"
              min={0}
              value={input.successfulJobsHistoryLimit}
              onChange={(e) => patch({ successfulJobsHistoryLimit: e.target.value })}
              className="tabular-nums"
            />
          </Field>
          <Field label={i18n.t('Kept failed')}>
            <Input
              type="number"
              min={0}
              value={input.failedJobsHistoryLimit}
              onChange={(e) => patch({ failedJobsHistoryLimit: e.target.value })}
              className="tabular-nums"
            />
          </Field>
          <Field label={i18n.t('Retries')}>
            <Input
              type="number"
              min={0}
              value={input.backoffLimit}
              onChange={(e) => patch({ backoffLimit: e.target.value })}
              className="tabular-nums"
            />
          </Field>
          <Field label={i18n.t('Deadline (s)')}>
            <Input
              type="number"
              min={1}
              value={input.activeDeadlineSeconds}
              placeholder={i18n.t('none')}
              onChange={(e) => patch({ activeDeadlineSeconds: e.target.value })}
              className="tabular-nums"
            />
          </Field>
        </div>
        <FieldError>{errors.numbers}</FieldError>
        <Switch
          checked={input.suspend}
          onChange={(suspend) => patch({ suspend })}
          label={i18n.t('Create suspended')}
          description={i18n.t('No runs until you resume it.')}
        />
      </Section>
    </WizardShell>
  );
}

function ScheduleSection({
  input,
  error,
  onChange,
}: {
  input: CronJobInput;
  error: string | null;
  onChange: (patch: Partial<CronJobInput>) => void;
}) {
  i18n.useLocale();
  const description = describeCron(input.schedule);
  const runs = useMemo(
    () => nextRuns(input.schedule, Date.now(), 3, input.timeZone.trim()),
    [input.schedule, input.timeZone],
  );
  const zone = input.timeZone.trim() || 'UTC';
  const format = (t: number) =>
    i18n.date(t, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });
  const parsed = parseCron(input.schedule);
  return (
    <Section title={i18n.t('Schedule')}>
      <Input
        mono
        lang="en"
        value={input.schedule}
        aria-label={i18n.t('Schedule')}
        placeholder="*/15 * * * *"
        onChange={(e) => onChange({ schedule: e.target.value })}
      />
      <div className="flex flex-wrap gap-1">
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            title={describeCron(preset) ?? preset}
            onClick={() => onChange({ schedule: preset })}
            className={cn(
              'rounded-md px-1.5 py-0.5 font-mono text-[11px] transition',
              input.schedule.trim() === preset
                ? 'bg-accent/15 text-accent'
                : 'bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg',
            )}
          >
            {preset}
          </button>
        ))}
      </div>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <div className="border-border/70 space-y-1 rounded-lg border px-3 py-2">
          <p className="text-fg flex items-start gap-2 text-[12px]">
            <CalendarClock className="text-accent mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{description}</span>
          </p>
          {parsed.ok && 'every' in parsed ? (
            <p className="text-fg-dim text-[11px]">
              {i18n.t('Counted from when the controller starts; no fixed times.')}
            </p>
          ) : (
            runs.length > 0 && (
              <p className="text-fg-dim text-[11px]">
                {i18n.t('Next runs ({zone}): {times}', {
                  zone,
                  times: runs.map(format).join(' · '),
                })}
              </p>
            )
          )}
        </div>
      )}
    </Section>
  );
}
