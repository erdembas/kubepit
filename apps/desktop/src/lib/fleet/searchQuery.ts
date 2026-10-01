import { BUILTIN, resolveKindName, toGvk, type KindDef } from '@/lib/kube/catalog';
import type { ApiResourceInfo, ClusterEnvironment, FleetSearchQuery, Gvk } from '@/types';

/**
 * Fleet search query syntax (pure, no React):
 *
 *   kind:pod,deploy  ns:payments  app=web  tier!=db  !canary  label:team
 *   cluster:prod  env:staging  checkout web-*  /^api-\d+$/
 *
 * Field tokens (`kind:`, `ns:`, `cluster:`, `env:`, `label:`) narrow the
 * search; `key=value`, `key!=value` and `!key` are label selector terms;
 * everything else is the name pattern the backend matches (substring, glob
 * or `/regex/`).
 */

export interface ParsedSearch {
  /** Name pattern sent as `FleetSearchQuery.text`. */
  text: string;
  /** Kinds named with `kind:`; empty = the kind chips decide. */
  kinds: Gvk[];
  /** `kind:` values that matched no known kind. */
  unknownKinds: string[];
  namespace: string | null;
  /** Label selector terms, joined with `,` for the API server. */
  labels: string[];
  /** `cluster:` values (case-insensitive substrings of cluster names). */
  clusters: string[];
  environments: ClusterEnvironment[];
}

/** The kind chips offered by the search view, in display order. */
export const SEARCH_KINDS: Array<{ def: KindDef; label: string }> = [
  { def: BUILTIN.Pod, label: 'Pods' },
  { def: BUILTIN.Deployment, label: 'Deployments' },
  { def: BUILTIN.StatefulSet, label: 'StatefulSets' },
  { def: BUILTIN.DaemonSet, label: 'DaemonSets' },
  { def: BUILTIN.Job, label: 'Jobs' },
  { def: BUILTIN.CronJob, label: 'CronJobs' },
  { def: BUILTIN.Service, label: 'Services' },
  { def: BUILTIN.Ingress, label: 'Ingresses' },
  { def: BUILTIN.ConfigMap, label: 'ConfigMaps' },
  { def: BUILTIN.Secret, label: 'Secrets' },
  { def: BUILTIN.PersistentVolumeClaim, label: 'PVCs' },
  { def: BUILTIN.Node, label: 'Nodes' },
  { def: BUILTIN.Namespace, label: 'Namespaces' },
];

/** Chips selected until the user changes them. */
export const DEFAULT_SEARCH_KINDS = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'cronjobs.batch',
  'services',
  'ingresses.networking.k8s.io',
  'configmaps',
];

export const ENV_ALIASES: Record<string, ClusterEnvironment> = {
  prod: 'production',
  prd: 'production',
  production: 'production',
  stage: 'staging',
  stg: 'staging',
  staging: 'staging',
  dev: 'development',
  development: 'development',
  test: 'testing',
  testing: 'testing',
  qa: 'testing',
  local: 'local',
};

export type SearchField = 'kind' | 'namespace' | 'cluster' | 'environment' | 'label';
export type SearchLabelOperator = '=' | '!=' | 'exists' | 'not-exists';

export interface SearchToken {
  /** Exact source bytes as UTF-16 offsets, matching input.selectionStart. */
  raw: string;
  start: number;
  end: number;
  type: 'field' | 'label' | 'text';
  field: SearchField | null;
  /** Label key for a single selector; null for field tokens or selector lists. */
  key: string | null;
  /** Decoded field value, label value, or unchanged free-text pattern. */
  value: string;
  /** Decoded comma-separated field values, or normalized label selectors. */
  values: string[];
  operator: SearchLabelOperator | null;
  complete: boolean;
  valid: boolean;
}

const FIELD = /^(kind|kinds|k|ns|namespace|n|cluster|c|env|e|label|l):(.*)$/is;
const FIELDS: Record<string, SearchField> = {
  kind: 'kind',
  kinds: 'kind',
  k: 'kind',
  ns: 'namespace',
  namespace: 'namespace',
  n: 'namespace',
  cluster: 'cluster',
  c: 'cluster',
  env: 'environment',
  e: 'environment',
  label: 'label',
  l: 'label',
};
const LABEL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isRegexText(text: string) {
  return text.length >= 2 && text.startsWith('/') && text.endsWith('/');
}

export function validSearchLabelKey(key: string): boolean {
  const parts = key.split('/');
  const name = parts.pop() ?? '';
  if (!LABEL_NAME.test(name) || parts.length > 1) return false;
  return (
    !parts.length ||
    (parts[0]!.length <= 253 && parts[0]!.split('.').every((part) => DNS_LABEL.test(part)))
  );
}

export function validSearchLabelValue(value: string): boolean {
  return !value || LABEL_NAME.test(value);
}

/** Quote only when needed, with JSON-compatible quote/backslash escaping. */
export function quoteSearchValue(value: string): string {
  return !value || /[\s,"'\\]/.test(value) ? JSON.stringify(value) : value;
}

interface DecodedValues {
  values: string[];
  closed: boolean;
  explicitEmpty: boolean;
}

function decodeValues(raw: string): DecodedValues {
  const values: string[] = [];
  let value = '';
  let quote = '';
  let explicitEmpty = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '\\' && index + 1 < raw.length) {
      const next = raw[index + 1]!;
      // Unknown escapes (especially \d / \w in regexes) stay literal.
      if (next === quote || next === '\\' || (!quote && /[\s,"']/.test(next))) {
        value += next;
        index++;
        continue;
      }
      value += char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
        explicitEmpty ||= value === '';
      } else value += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ',') {
      values.push(value);
      value = '';
    } else value += char;
  }
  values.push(value);
  return { values, closed: !quote, explicitEmpty };
}

/** Find a complete slash regex, respecting escapes and character classes. */
function regexEnd(input: string, start: number): number | null {
  if (input[start] !== '/') return null;
  let inClass = false;
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]!;
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (
      char === '/' &&
      !inClass &&
      (index + 1 === input.length || /\s/.test(input[index + 1]!))
    )
      return index + 1;
  }
  return null;
}

interface LabelPart {
  key: string;
  value: string;
  operator: SearchLabelOperator;
  selector: string;
  valid: boolean;
}
function labelPart(raw: string): LabelPart | null {
  const match = /^(!?)([^=!,\s]+?)(?:(==|!=|=)(.*))?$/.exec(raw);
  if (!match) return null;
  const [, absent, key = '', operator, value = ''] = match;
  if (absent && operator) return null;
  const op: SearchLabelOperator = absent
    ? 'not-exists'
    : operator === '!='
      ? '!='
      : operator
        ? '='
        : 'exists';
  return {
    key,
    value,
    operator: op,
    selector: op === 'not-exists' ? `!${key}` : op === 'exists' ? key : `${key}${op}${value}`,
    valid: validSearchLabelKey(key) && validSearchLabelValue(value),
  };
}

/** Tokenization never discards malformed fields: they remain editable text. */
export function scanSearchInput(
  input: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): SearchToken[] {
  const tokens: SearchToken[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    if (/\s/.test(input[cursor]!)) {
      cursor++;
      continue;
    }
    const start = cursor;
    const regex = regexEnd(input, start);
    let quote = '';
    if (regex !== null) cursor = regex;
    else {
      while (cursor < input.length) {
        const char = input[cursor]!;
        if (char === '\\' && cursor + 1 < input.length) {
          cursor += 2;
          continue;
        }
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (/\s/.test(char)) break;
        cursor++;
      }
    }
    const raw = input.slice(start, cursor);
    const base: SearchToken = {
      raw,
      start,
      end: cursor,
      type: 'text',
      field: null,
      key: null,
      value: raw,
      values: [raw],
      operator: null,
      complete: !quote,
      valid: !quote,
    };
    const match = FIELD.exec(raw);
    if (match) {
      const field = FIELDS[match[1]!.toLowerCase()]!;
      const decoded = decodeValues(match[2]!);
      const values = decoded.values;
      const hasValues = values.every((value) => !!value);
      let valid = decoded.closed && hasValues;
      if (field === 'kind') valid &&= values.every((kind) => !!resolveKindName(kind, apiResources));
      else if (field === 'environment')
        valid &&= values.every((env) => !!ENV_ALIASES[env.toLowerCase()]);
      else if (field === 'namespace') valid &&= values.length === 1 && DNS_LABEL.test(values[0]!);
      const token = {
        ...base,
        type: 'field' as const,
        field,
        value: values.join(','),
        values,
        complete: decoded.closed && hasValues,
        valid,
      };
      if (field !== 'label') {
        tokens.push(token);
        continue;
      }
      const parts = values.map(labelPart);
      const single = parts.length === 1 ? parts[0] : null;
      const emptyAssignment =
        single && (single.operator === '=' || single.operator === '!=') && !single.value;
      tokens.push({
        ...token,
        type: 'label',
        key: single?.key ?? null,
        value: single?.value ?? values.join(','),
        values: parts.map((part, index) => part?.selector ?? values[index]!),
        operator: single?.operator ?? null,
        valid: decoded.closed && parts.every((part) => !!part?.valid),
        complete:
          decoded.closed &&
          parts.every(Boolean) &&
          (!emptyAssignment ||
            cursor < input.length ||
            decoded.explicitEmpty ||
            /["']{2}$/.test(raw)),
      });
      continue;
    }
    if (regex === null && (raw.startsWith('!') || /(?:=|!=)/.test(raw))) {
      const decoded = decodeValues(raw);
      const part = decoded.values.length === 1 ? labelPart(decoded.values[0]!) : null;
      if (part) {
        const emptyAssignment = (part.operator === '=' || part.operator === '!=') && !part.value;
        tokens.push({
          ...base,
          type: 'label',
          field: 'label',
          key: part.key,
          value: part.value,
          values: [part.selector],
          operator: part.operator,
          valid: decoded.closed && part.valid,
          complete:
            decoded.closed && (!emptyAssignment || cursor < input.length || /["']{2}$/.test(raw)),
        });
        continue;
      }
    }
    if (/^["']/.test(raw) && base.complete) {
      const decoded = decodeValues(raw);
      base.value = decoded.values.join(',');
      base.values = [base.value];
    }
    tokens.push(base);
  }
  return tokens;
}

export function searchTags(
  input: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): SearchToken[] {
  return scanSearchInput(input, apiResources).filter(
    (token) => token.type !== 'text' && token.valid && token.complete,
  );
}

export function splitSearchDraft(
  input: string,
  commitLast: boolean,
  apiResources?: readonly ApiResourceInfo[] | null,
): { filters: SearchToken[]; draft: string } {
  // Enter/blur is a delimiter too, including for Kubernetes' empty label value.
  const tokens = scanSearchInput(commitLast ? `${input} ` : input, apiResources);
  const filters = tokens.filter(
    (token) =>
      token.type !== 'text' &&
      token.valid &&
      token.complete &&
      (commitLast || token.end < input.length),
  );
  let end = 0;
  let draft = '';
  for (const token of filters) {
    draft += input.slice(end, token.start);
    end = token.end;
  }
  draft += input.slice(end);
  return { filters, draft };
}

export function removeSearchToken(
  input: string,
  token: Pick<SearchToken, 'start' | 'end'>,
): string {
  const before = input.slice(0, token.start).trimEnd();
  const after = input.slice(token.end).trimStart();
  return before && after ? `${before} ${after}` : before || after;
}

export function replaceSearchToken(
  input: string,
  token: Pick<SearchToken, 'start' | 'end'> | null,
  replacement: string,
): { input: string; caret: number } {
  const start = token?.start ?? input.length;
  const end = token?.end ?? input.length;
  return {
    input: input.slice(0, start) + replacement + input.slice(end),
    caret: start + replacement.length,
  };
}

export function parseSearchInput(
  input: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): ParsedSearch {
  const out: ParsedSearch = {
    text: '',
    kinds: [],
    unknownKinds: [],
    namespace: null,
    labels: [],
    clusters: [],
    environments: [],
  };
  const terms: string[] = [];
  let regex: string | null = null;
  for (const token of scanSearchInput(input, apiResources)) {
    if (token.type === 'field' && token.field === 'kind' && token.complete) {
      for (const kind of token.values) {
        const gvk = resolveKindName(kind, apiResources);
        if (!gvk) out.unknownKinds.push(kind);
        else if (
          !out.kinds.some((known) => known.group === gvk.group && known.plural === gvk.plural)
        )
          out.kinds.push(gvk);
      }
      continue;
    }
    if (token.valid && token.type === 'label') {
      out.labels.push(...token.values);
      continue;
    }
    if (token.valid && token.complete && token.type === 'field') {
      if (token.field === 'namespace') out.namespace = token.value;
      else if (token.field === 'cluster')
        out.clusters.push(...token.values.map((value) => value.toLowerCase()));
      else if (token.field === 'environment')
        for (const env of token.values) {
          const value = ENV_ALIASES[env.toLowerCase()]!;
          if (!out.environments.includes(value)) out.environments.push(value);
        }
      continue;
    }
    if (isRegexText(token.value)) regex = token.value;
    else terms.push(token.value);
  }
  out.text = regex ?? terms.join(' ');
  return out;
}

/** Kinds to search: `kind:` tokens win over the chips. */
export function effectiveKinds(parsed: ParsedSearch, chipKeys: readonly string[]): Gvk[] {
  if (parsed.kinds.length) return parsed.kinds;
  return SEARCH_KINDS.filter((k) => chipKeys.includes(k.def.key)).map((k) => toGvk(k.def));
}

export function buildFleetQuery(
  parsed: ParsedSearch,
  kinds: Gvk[],
  clusterIds: string[],
  limitPerKind = 200,
): FleetSearchQuery {
  return {
    text: parsed.text,
    kinds,
    cluster_ids: clusterIds,
    namespace: parsed.namespace,
    label_selector: parsed.labels.length ? parsed.labels.join(',') : null,
    limit_per_kind: limitPerKind,
  };
}

/** True when the query would list every object of every kind (worth a nudge). */
export function isBroad(parsed: ParsedSearch) {
  return !parsed.text && !parsed.labels.length && !parsed.namespace;
}
