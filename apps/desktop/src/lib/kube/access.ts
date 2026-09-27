import type {
  AccessCheck,
  AccessNonResourceRule,
  AccessResourceRule,
  AccessRules,
  Gvk,
} from '@/types';

/**
 * Local evaluation of RBAC rules (a `SelfSubjectRulesReview`) plus helpers
 * that turn kinds and actions into `AccessCheck`s. Pure: no IPC, no i18n.
 *
 * Matching mirrors the API server's `rbac/validation.RuleAllows` exactly:
 *  - verbs: `*` or an exact verb;
 *  - API groups: `*` or an exact group (`''` is the core group);
 *  - resources: `*` (every resource *and* subresource), the exact combined
 *    resource (`pods`, `pods/log`), or a star followed by `/<subresource>`
 *    (e.g. any resource's `scale`) for a subresource request. A trailing
 *    `/*` (`pods/` + star) is **not** a wildcard in RBAC and only matches
 *    itself literally, so it is treated the same way here;
 *  - resourceNames: empty = every name, otherwise the request must carry
 *    one of the names. A request without a name (list, create, cluster-wide
 *    checks) never matches a name-restricted rule — reported as
 *    `restricted` so the UI can say "only specific names".
 */

/** Tri-state answer used by every gate. `unknown` never blocks the UI. */
export type AccessState = 'allowed' | 'denied' | 'unknown';

/** Outcome of evaluating one check against a rules review. */
export type RuleVerdict = 'allowed' | 'restricted' | 'denied';

const ALL = '*';

/** RBAC's "combined resource": `pods` or `pods/log`. */
export function combinedResource(check: Pick<AccessCheck, 'resource' | 'subresource'>): string {
  return check.subresource ? `${check.resource}/${check.subresource}` : check.resource;
}

export function verbMatches(rule: AccessResourceRule | AccessNonResourceRule, verb: string) {
  return rule.verbs.some((v) => v === ALL || v === verb);
}

export function groupMatches(rule: AccessResourceRule, group: string) {
  return rule.api_groups.some((g) => g === ALL || g === group);
}

export function resourceMatches(rule: AccessResourceRule, combined: string, subresource: string) {
  return rule.resources.some((r) => {
    if (r === ALL || r === combined) return true;
    // `*/scale` grants the scale subresource of every resource.
    return !!subresource && r.length === subresource.length + 2 && r === `*/${subresource}`;
  });
}

export function nameMatches(rule: AccessResourceRule, name: string | null | undefined) {
  return !rule.resource_names.length || (!!name && rule.resource_names.includes(name));
}

/** True when `rule` grants `check` (verb, group, resource and name). */
export function ruleAllows(rule: AccessResourceRule, check: AccessCheck): boolean {
  return ruleCovers(rule, check) && nameMatches(rule, check.name);
}

/** Verb, group and resource match — the name is not considered. */
function ruleCovers(rule: AccessResourceRule, check: AccessCheck) {
  return (
    verbMatches(rule, check.verb) &&
    groupMatches(rule, check.group) &&
    resourceMatches(rule, combinedResource(check), check.subresource ?? '')
  );
}

function ruleList(rules: AccessRules | readonly AccessResourceRule[]) {
  return 'resource_rules' in rules ? rules.resource_rules : rules;
}

export function evaluateRules(
  rules: AccessRules | readonly AccessResourceRule[],
  check: AccessCheck,
): RuleVerdict {
  const list = ruleList(rules);
  if (list.some((rule) => ruleAllows(rule, check))) return 'allowed';
  if (!check.name && list.some((rule) => rule.resource_names.length && ruleCovers(rule, check)))
    return 'restricted';
  return 'denied';
}

/** Object names a `restricted` verdict still allows (sorted, unique). */
export function allowedNames(
  rules: AccessRules | readonly AccessResourceRule[],
  check: AccessCheck,
): string[] {
  const names = new Set<string>();
  for (const rule of ruleList(rules))
    if (ruleCovers(rule, check)) rule.resource_names.forEach((n) => names.add(n));
  return [...names].sort();
}

/** RBAC `NonResourceURLMatches`: `*`, an exact path, or a `prefix*` pattern. */
export function nonResourceAllows(rules: AccessRules, verb: string, path: string): boolean {
  return rules.non_resource_rules.some(
    (rule) =>
      verbMatches(rule, verb) &&
      rule.non_resource_urls.some(
        (url) =>
          url === ALL ||
          url === path ||
          (url.endsWith('*') && path.startsWith(url.replace(/\*+$/, ''))),
      ),
  );
}

// ---------------------------------------------------------------------------
// Building checks
// ---------------------------------------------------------------------------

/**
 * A check for `verb` on a kind. The namespace is only kept for namespaced
 * kinds; `null` for a namespaced kind asks across all namespaces.
 */
export function accessCheck(
  verb: string,
  gvk: Pick<Gvk, 'group' | 'plural' | 'namespaced'>,
  opts: { namespace?: string | null; name?: string | null; subresource?: string | null } = {},
): AccessCheck {
  return {
    verb,
    group: gvk.group,
    resource: gvk.plural,
    subresource: opts.subresource || null,
    namespace: gvk.namespaced ? opts.namespace || null : null,
    name: opts.name || null,
  };
}

/** Stable cache key for a check. */
export function checkKey(c: AccessCheck): string {
  return [c.verb, c.group, c.resource, c.subresource ?? '', c.namespace ?? '', c.name ?? ''].join(
    '|',
  );
}

/** `deployments.apps`, `pods/log`, `deployments.apps/scale` (kubectl-style). */
export function resourceRef(c: Pick<AccessCheck, 'group' | 'resource' | 'subresource'>): string {
  const base = c.group ? `${c.resource}.${c.group}` : c.resource;
  return c.subresource ? `${base}/${c.subresource}` : base;
}

/** Inverse of `resourceRef`: `deployments.apps/scale` → group, resource, subresource. */
export function parseResourceRef(text: string): {
  group: string;
  resource: string;
  subresource: string | null;
} {
  const [base = '', ...rest] = text.trim().split('/');
  const dot = base.indexOf('.');
  return {
    resource: dot < 0 ? base : base.slice(0, dot),
    group: dot < 0 ? '' : base.slice(dot + 1),
    subresource: rest.join('/') || null,
  };
}

/** The equivalent `kubectl auth can-i` command line. */
export function kubectlCanI(c: AccessCheck, namespaced = !!c.namespace): string {
  const target = `${c.group ? `${c.resource}.${c.group}` : c.resource}${c.name ? `/${c.name}` : ''}`;
  const parts = ['kubectl auth can-i', c.verb, target];
  if (c.subresource) parts.push(`--subresource=${c.subresource}`);
  if (c.namespace) parts.push(`-n ${c.namespace}`);
  else if (namespaced) parts.push('--all-namespaces');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Combining answers
// ---------------------------------------------------------------------------

/** Every state must allow: any denial denies, otherwise unknown wins over allowed. */
export function allOf(states: readonly AccessState[]): AccessState {
  if (states.includes('denied')) return 'denied';
  return states.every((s) => s === 'allowed') ? 'allowed' : 'unknown';
}

/** One allowing state is enough; denied only when every state denies. */
export function anyOf(states: readonly AccessState[]): AccessState {
  if (!states.length) return 'unknown';
  if (states.includes('allowed')) return 'allowed';
  return states.every((s) => s === 'denied') ? 'denied' : 'unknown';
}

/**
 * What an action needs. A plain list means every check must be allowed;
 * `anyOf` lists alternatives (node shells fall back from `kube-system` to
 * `default`; bulk actions need permission on at least one target).
 */
export type AccessNeed =
  readonly AccessCheck[] | { readonly anyOf: readonly (readonly AccessCheck[])[] };

export function alternatives(need: AccessNeed): readonly (readonly AccessCheck[])[] {
  return 'anyOf' in need ? need.anyOf : [need];
}

/** Alternatives of several needs merged into one (any of them suffices). */
export function eitherNeed(needs: readonly AccessNeed[]): AccessNeed {
  return { anyOf: needs.flatMap(alternatives).filter((alt) => alt.length) };
}

/** Every check a need may ask about, deduplicated. */
export function needChecks(need: AccessNeed): AccessCheck[] {
  const seen = new Map<string, AccessCheck>();
  for (const alt of alternatives(need)) for (const c of alt) seen.set(checkKey(c), c);
  return [...seen.values()];
}

/**
 * Resolve a need from per-check states. `blocking` is the first denied check
 * of the first denied alternative (for the tooltip).
 */
export function evaluateNeed(
  need: AccessNeed,
  stateOf: (check: AccessCheck) => AccessState,
): { state: AccessState; blocking: AccessCheck | null } {
  const alts = alternatives(need).filter((alt) => alt.length);
  if (!alts.length) return { state: 'allowed', blocking: null };
  let blocking: AccessCheck | null = null;
  const states = alts.map((alt) => {
    const each = alt.map(stateOf);
    const state = allOf(each);
    if (state === 'denied' && !blocking) blocking = alt[each.indexOf('denied')] ?? null;
    return state;
  });
  const state = anyOf(states);
  return { state, blocking: state === 'denied' ? blocking : null };
}

// ---------------------------------------------------------------------------
// Permission matrix columns
// ---------------------------------------------------------------------------

export const MATRIX_VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection',
] as const;

/** Pod-only shortcut columns: subresources behind Logs, Shell, Attach and Port forward. */
export const POD_SHORTCUTS = [
  { id: 'logs', verb: 'get', subresource: 'log' },
  { id: 'exec', verb: 'create', subresource: 'exec' },
  { id: 'attach', verb: 'create', subresource: 'attach' },
  { id: 'port-forward', verb: 'create', subresource: 'portforward' },
] as const;
