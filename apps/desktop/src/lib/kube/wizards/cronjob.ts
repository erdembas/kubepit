import * as i18n from '@/i18n/core';
import { validateImage } from '../images';
import { isValidTimeZone, parseCron } from './cron';
import { nameError } from './validate';

/** `kubectl create cronjob NAME --image=… --schedule=… -- command…`. */

export interface CronJobInput {
  name: string;
  namespace: string;
  image: string;
  schedule: string;
  /** IANA name; empty = the controller's time zone. */
  timeZone: string;
  /** Command line; split like a shell (quotes respected) unless `shell` is on. */
  command: string;
  /** Run the command through `sh -c`. */
  shell: boolean;
  concurrencyPolicy: 'Allow' | 'Forbid' | 'Replace';
  restartPolicy: 'OnFailure' | 'Never';
  suspend: boolean;
  successfulJobsHistoryLimit: string;
  failedJobsHistoryLimit: string;
  backoffLimit: string;
  /** Seconds; empty = no deadline. */
  activeDeadlineSeconds: string;
}

export function cronJobDefaults(namespace: string): CronJobInput {
  return {
    name: '',
    namespace,
    image: '',
    schedule: '0 * * * *',
    timeZone: '',
    command: '',
    shell: false,
    concurrencyPolicy: 'Forbid',
    restartPolicy: 'OnFailure',
    suspend: false,
    successfulJobsHistoryLimit: '3',
    failedJobsHistoryLimit: '1',
    backoffLimit: '6',
    activeDeadlineSeconds: '',
  };
}

/** Splits a command line like a POSIX shell would (quotes and backslashes), without expansion. */
export function splitCommand(line: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!))
        current += line[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started || current) out.push(current);
  return out;
}

function count(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

export function buildCronJob(input: CronJobInput): Record<string, unknown> {
  const command = input.command.trim()
    ? input.shell
      ? ['sh', '-c', input.command.trim()]
      : (splitCommand(input.command.trim()) ?? [])
    : [];
  const deadline = count(input.activeDeadlineSeconds);
  const backoff = count(input.backoffLimit);
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: input.name, namespace: input.namespace },
    spec: {
      schedule: input.schedule.trim().replace(/\s+/g, ' '),
      ...(input.timeZone.trim() ? { timeZone: input.timeZone.trim() } : {}),
      concurrencyPolicy: input.concurrencyPolicy,
      ...(input.suspend ? { suspend: true } : {}),
      ...(count(input.successfulJobsHistoryLimit) !== undefined
        ? { successfulJobsHistoryLimit: count(input.successfulJobsHistoryLimit) }
        : {}),
      ...(count(input.failedJobsHistoryLimit) !== undefined
        ? { failedJobsHistoryLimit: count(input.failedJobsHistoryLimit) }
        : {}),
      jobTemplate: {
        metadata: { name: input.name },
        spec: {
          ...(backoff !== undefined ? { backoffLimit: backoff } : {}),
          ...(deadline !== undefined ? { activeDeadlineSeconds: deadline } : {}),
          template: {
            spec: {
              restartPolicy: input.restartPolicy,
              containers: [
                {
                  name: input.name || 'job',
                  image: input.image.trim(),
                  ...(command.length ? { command } : {}),
                },
              ],
            },
          },
        },
      },
    },
  };
}

export interface CronJobErrors {
  name: string | null;
  image: string | null;
  schedule: string | null;
  timeZone: string | null;
  command: string | null;
  numbers: string | null;
}

function nonNegative(value: string): boolean {
  return value.trim() === '' || (/^\d+$/.test(value.trim()) && Number(value) <= 2_147_483_647);
}

export function validateCronJob(input: CronJobInput): CronJobErrors {
  const schedule = parseCron(input.schedule);
  const deadline = input.activeDeadlineSeconds.trim();
  return {
    // Job names get an 11-character suffix, so CronJob names stop at 52.
    name: nameError(input.name, 'subdomain', 52),
    image: input.image.trim() ? validateImage(input.image.trim()) : i18n.t('An image is required.'),
    schedule: schedule.ok ? null : schedule.error,
    timeZone: isValidTimeZone(input.timeZone.trim())
      ? null
      : i18n.t('Unknown time zone; use an IANA name like Europe/Istanbul.'),
    command:
      !input.shell && input.command.trim() && splitCommand(input.command.trim()) === null
        ? i18n.t('A quote is not closed.')
        : null,
    numbers:
      nonNegative(input.successfulJobsHistoryLimit) &&
      nonNegative(input.failedJobsHistoryLimit) &&
      nonNegative(input.backoffLimit) &&
      (deadline === '' || (nonNegative(deadline) && Number(deadline) > 0))
        ? null
        : i18n.t('Limits are whole numbers of zero or more; the deadline is at least 1 second.'),
  };
}

export function cronJobBlocked(errors: CronJobErrors): boolean {
  return Object.values(errors).some(Boolean);
}
