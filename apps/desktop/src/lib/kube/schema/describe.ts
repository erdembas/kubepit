import * as i18n from '@/i18n/core';
import type { FieldInfo } from './fields';

/**
 * Markdown for hovers and completion details. Schema text (descriptions,
 * enum values, markers) comes from the cluster and is never translated;
 * only the labels around it are.
 */

/** Escape what Markdown would otherwise interpret in schema prose; keep `code` spans. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\*<>[\]|#])/g, '\\$1')
    .replace(/\n(?!\n)/g, '  \n')
    .trim();
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

export function fieldMarkdown(field: FieldInfo, options: { title?: string } = {}): string {
  const head = [`**${options.title ?? field.name}**`, code(field.type)];
  if (field.required) head.push(`_${i18n.t('required')}_`);
  if (field.deprecated) head.push(`_${i18n.t('deprecated')}_`);
  const parts = [head.join(' · ')];
  if (field.description) parts.push(escapeMarkdown(field.description));
  const facts: string[] = [];
  if (field.enum?.length)
    facts.push(
      `${i18n.t('Allowed values:')} ${field.enum.map((v) => code(formatValue(v))).join(', ')}`,
    );
  if (field.hasDefault) facts.push(`${i18n.t('Default:')} ${code(formatValue(field.default))}`);
  if (field.format) facts.push(`${i18n.t('Format:')} ${code(field.format)}`);
  if (field.hints.length) facts.push(field.hints.map(code).join(' '));
  if (facts.length) parts.push(facts.join('  \n'));
  return parts.join('\n\n');
}

export function kindMarkdown(kind: string, apiVersion: string, description: string): string {
  const parts = [`**${kind}** · ${code(apiVersion)}`];
  if (description) parts.push(escapeMarkdown(description));
  return parts.join('\n\n');
}
