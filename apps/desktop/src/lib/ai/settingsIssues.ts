import { assistantErrorMessage } from './errorMessage';
import * as i18n from '@/i18n/core';
import type { AiPrice, AiProviderConfig, AiProviderStatus, AiSettings, AiStatus } from '@/types';

/**
 * Validation of the Settings → Assistant draft (`Settings.ai`) against the
 * backend's `ai_status`, mirroring `kubepit-core/src/ai/settings.rs`.
 *
 * - `error`: the draft would save something invalid or unusable (the
 *   backend would silently replace or clamp it, or refuse every request):
 *   Save is blocked. Readiness of the active provider (chosen, allowed,
 *   has a model, keys only over https) is an error while the assistant is
 *   on and a warning while it is off.
 * - `warning`: state outside the draft — API keys live in the credential
 *   store and change with "Set" / "Remove", and remote egress is a
 *   process setting — so it never blocks saving other settings.
 */
export type SettingsIssueSeverity = 'error' | 'warning';

export interface SettingsIssue {
  /**
   * `active_provider`, `max_context_tokens`,
   * `providers.<id>.{base_url,model,key,context_window,max_output_tokens}`
   * or `prices.<index>.<field of AiPrice>`.
   */
  field: string;
  message: string;
  severity: SettingsIssueSeverity;
}

export const MIN_CONTEXT_TOKENS = 2_000;
export const MAX_CONTEXT_TOKENS = 900_000;

export const PRICE_FIELDS = [
  'input_per_mtok',
  'output_per_mtok',
  'cache_write_per_mtok',
  'cache_read_per_mtok',
] as const satisfies ReadonlyArray<keyof AiPrice>;

/** The backend's `trim_base_url`: surrounding whitespace and trailing slashes. */
export function trimBaseUrl(url: string): string {
  let current = url;
  for (;;) {
    const next = current.trim().replace(/\/+$/, '');
    if (next === current) return current;
    current = next;
  }
}

type UrlProblem = 'empty' | 'characters' | 'query' | 'scheme' | 'userinfo' | 'host';

interface ParsedUrl {
  scheme: 'http' | 'https';
  /** Lowercase; IPv6 in brackets. */
  host: string;
}

/**
 * `parse_base_url`: `http(s)://host[:port][/path]` without user info, query,
 * fragment, whitespace or backslashes, whose host the WHATWG parser (the
 * HTTP client's) reads exactly as written (`http://127.1` is refused).
 */
function parseBaseUrl(raw: string): ParsedUrl | UrlProblem {
  const url = trimBaseUrl(raw);
  if (!url) return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return 'characters';
  if (url.includes('?') || url.includes('#')) return 'query';
  const lower = url.toLowerCase();
  const scheme = lower.startsWith('https://')
    ? 'https'
    : lower.startsWith('http://')
      ? 'http'
      : null;
  if (!scheme) return 'scheme';
  const authority = url.slice(scheme.length + 3).split('/')[0] ?? '';
  if (authority.includes('@')) return 'userinfo';
  let host: string;
  let rest: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return 'host';
    host = authority.slice(0, end + 1);
    rest = authority.slice(end + 1);
  } else {
    const colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
    rest = colon < 0 ? '' : authority.slice(colon);
  }
  if (!host || host === '[]') return 'host';
  let port = scheme === 'https' ? 443 : 80;
  if (rest) {
    if (!/^:\d+$/.test(rest)) return 'host';
    port = Number(rest.slice(1));
    if (port > 65_535) return 'host';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'host';
  }
  const parsedPort = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;
  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.hostname !== host.toLowerCase() ||
    parsedPort !== port
  )
    return 'host';
  return { scheme, host: host.toLowerCase() };
}

function hostIsLoopback(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!octets && octets.slice(1).every((o) => Number(o) <= 255);
}

/** Why `url` cannot be used as a provider base URL (translated), null when it can. */
export function baseUrlProblem(url: string): string | null {
  const parsed = parseBaseUrl(url);
  if (typeof parsed !== 'string') return null;
  switch (parsed) {
    case 'empty':
      return i18n.t('Enter the base URL.');
    case 'characters':
      return i18n.t('The base URL must not contain spaces or backslashes.');
    case 'query':
      return i18n.t('The base URL must not contain a query (?…) or a fragment (#…).');
    case 'scheme':
      return i18n.t('The base URL must start with http:// or https://.');
    case 'userinfo':
      return i18n.t('The base URL must not contain a user name or password.');
    case 'host':
      return i18n.t('The base URL does not have a valid host and port.');
  }
}

/** A usable base URL on this computer: `localhost`, `127.0.0.0/8` or `[::1]` (`is_loopback`). */
export function isLoopbackUrl(url: string): boolean {
  const parsed = parseBaseUrl(url);
  return typeof parsed !== 'string' && hostIsLoopback(parsed.host);
}

/** An API key may be sent to `url`: https, or plain http to this computer (`key_safe`). */
export function isKeySafeUrl(url: string): boolean {
  const parsed = parseBaseUrl(url);
  return typeof parsed !== 'string' && (parsed.scheme === 'https' || hostIsLoopback(parsed.host));
}

/** Requests to the provider carry an API key: Anthropic always, the others when one is stored. */
export function sendsKey(provider: AiProviderConfig, status: AiProviderStatus | undefined) {
  return provider.kind === 'anthropic' || (status?.has_key ?? false);
}

/** The provider cannot answer without a key: Anthropic, or a remote OpenAI-compatible endpoint. */
export function needsKey(provider: AiProviderConfig): boolean {
  if (provider.kind === 'anthropic') return true;
  return provider.kind === 'openai-compatible' && !isLoopbackUrl(provider.base_url);
}

const positiveInteger = (n: number) => Number.isInteger(n) && n >= 1;

/** Issues of the draft `ai` given the backend's key and egress status (null while loading). */
export function settingsIssues(ai: AiSettings, status: AiStatus | null): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const push = (field: string, message: string, severity: SettingsIssueSeverity) =>
    issues.push({ field, message, severity });
  const readiness: SettingsIssueSeverity = ai.enabled ? 'error' : 'warning';
  const active = ai.providers.find((p) => p.id === ai.active_provider) ?? null;

  if (!active) push('active_provider', i18n.t('Choose a provider.'), readiness);

  for (const provider of ai.providers) {
    const field = `providers.${provider.id}`;
    const isActive = provider === active;
    const providerStatus = status?.providers.find((p) => p.id === provider.id);
    const urlProblem = baseUrlProblem(provider.base_url);
    const local = isLoopbackUrl(provider.base_url);

    if (urlProblem) push(`${field}.base_url`, urlProblem, 'error');
    else if (sendsKey(provider, providerStatus) && !isKeySafeUrl(provider.base_url))
      push(
        `${field}.base_url`,
        i18n.t(
          'API keys are sent only over https:// or to this computer. Use an https:// address.',
        ),
        isActive ? readiness : 'warning',
      );

    if (isActive && !urlProblem && !local) {
      if (ai.local_only)
        push(
          'active_provider',
          i18n.t(
            '{name} is not on this computer, and local-only mode refuses remote providers. Choose a local provider or turn local-only mode off.',
            { name: provider.name },
          ),
          readiness,
        );
      else if (status && !status.remote_allowed)
        push(
          'active_provider',
          i18n.t(
            'This app cannot reach remote providers. Choose a provider on this computer (localhost).',
          ),
          'warning',
        );
    }

    if (isActive && provider.kind !== 'anthropic' && !provider.model.trim())
      push(
        `${field}.model`,
        i18n.t('Choose a model for {name}.', { name: provider.name }),
        readiness,
      );

    if (provider.context_window !== null && !positiveInteger(provider.context_window))
      push(`${field}.context_window`, i18n.t('Enter a whole number greater than zero.'), 'error');
    if (!positiveInteger(provider.max_output_tokens))
      push(
        `${field}.max_output_tokens`,
        i18n.t('Enter a whole number greater than zero.'),
        'error',
      );

    if (providerStatus?.key_error)
      push(
        `${field}.key`,
        i18n.t('The stored key cannot be used: {error}', {
          error: assistantErrorMessage(providerStatus.key_error),
        }),
        'warning',
      );
    else if (isActive && providerStatus && !providerStatus.has_key && needsKey(provider))
      push(
        `${field}.key`,
        i18n.t('No API key is stored for {name}.', { name: provider.name }),
        'warning',
      );
  }

  const n = ai.max_context_tokens;
  if (!Number.isInteger(n) || n < MIN_CONTEXT_TOKENS || n > MAX_CONTEXT_TOKENS)
    push(
      'max_context_tokens',
      i18n.t('Enter a whole number from {min} to {max}.', {
        min: i18n.number(MIN_CONTEXT_TOKENS),
        max: i18n.number(MAX_CONTEXT_TOKENS),
      }),
      'error',
    );

  const priced = new Set<string>();
  ai.prices.forEach((price, index) => {
    const field = `prices.${index}`;
    const model = price.model.trim();
    if (!model) push(`${field}.model`, i18n.t('Enter the model id.'), 'error');
    else if (priced.has(model))
      push(`${field}.model`, i18n.t('This model already has a price.'), 'error');
    priced.add(model);
    for (const key of PRICE_FIELDS) {
      const value = price[key];
      // Cache prices may be empty (they then cost the input price).
      if (value === null && (key === 'cache_write_per_mtok' || key === 'cache_read_per_mtok'))
        continue;
      if (value === null || !Number.isFinite(value))
        push(`${field}.${key}`, i18n.t('Enter a price per million tokens.'), 'error');
      else if (value < 0) push(`${field}.${key}`, i18n.t('Prices cannot be negative.'), 'error');
    }
  });

  return issues;
}

/** Save must wait: at least one issue is an error. */
export function hasBlockingIssues(issues: readonly SettingsIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** The issues of one field (`providers.anthropic.key`). */
export function issuesOf(issues: readonly SettingsIssue[], field: string): SettingsIssue[] {
  return issues.filter((issue) => issue.field === field);
}
