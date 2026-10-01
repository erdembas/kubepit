import { SEARCH_KINDS } from './searchQuery';
import type { SearchScope } from '@/store/useFleetSearchStore';

export const MAX_SAVED_SEARCHES = 50;
export const MAX_PINNED_SEARCHES = 8;
export const MAX_SEARCH_NAME = 80;
export const MAX_SAVED_QUERY = 4096;
export const MAX_SAVED_SEARCH_STORAGE = 512 * 1024;

export interface FleetSearchSnapshot {
  /** Preserve the original syntax, quoting and whitespace. */
  input: string;
  kinds: string[];
  scope: SearchScope;
}

export interface SavedFleetSearch extends FleetSearchSnapshot {
  id: string;
  name: string;
  pinned: boolean;
  createdAt: number;
}

const kinds = new Set(SEARCH_KINDS.map(({ def }) => def.key));
const environments = new Set(['production', 'staging', 'development', 'testing', 'local']);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/.test(value);

export function searchScope(value: unknown): SearchScope | null {
  if (!object(value)) return null;
  if (value.kind === 'all') return { kind: 'all' };
  if (value.kind === 'section' && boundedText(value.id, 128))
    return { kind: 'section', id: value.id };
  if (value.kind === 'environment' && typeof value.env === 'string' && environments.has(value.env))
    return {
      kind: 'environment',
      env: value.env as Extract<SearchScope, { kind: 'environment' }>['env'],
    };
  return null;
}

export function searchSnapshot(value: unknown): FleetSearchSnapshot | null {
  if (
    !object(value) ||
    typeof value.input !== 'string' ||
    !value.input.trim() ||
    value.input.length > MAX_SAVED_QUERY ||
    value.input.includes('\u0000')
  )
    return null;
  if (
    !Array.isArray(value.kinds) ||
    value.kinds.length > SEARCH_KINDS.length ||
    !value.kinds.every((key) => typeof key === 'string' && kinds.has(key))
  )
    return null;
  const scope = searchScope(value.scope);
  return scope ? { input: value.input, kinds: [...new Set(value.kinds as string[])], scope } : null;
}

export function savedSearchName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return boundedText(name, MAX_SEARCH_NAME) ? name : null;
}

/** Reject malformed records whole: dropping an unknown kind/scope could
 * silently widen the restored search. Unknown fields are never retained. */
export function sanitizeSavedSearches(value: unknown): SavedFleetSearch[] {
  if (!Array.isArray(value)) return [];
  const result: SavedFleetSearch[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  let pins = 0;
  for (const candidate of value.slice(0, MAX_SAVED_SEARCHES)) {
    if (!object(candidate)) continue;
    const snapshot = searchSnapshot(candidate);
    const name = savedSearchName(candidate.name);
    if (
      !snapshot ||
      !name ||
      !boundedText(candidate.id, 128) ||
      ids.has(candidate.id) ||
      names.has(name.toLowerCase()) ||
      typeof candidate.pinned !== 'boolean' ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0 ||
      candidate.createdAt > 8.64e15
    )
      continue;
    ids.add(candidate.id);
    names.add(name.toLowerCase());
    const pinned = candidate.pinned && pins < MAX_PINNED_SEARCHES;
    if (pinned) pins++;
    result.push({ ...snapshot, id: candidate.id, name, pinned, createdAt: candidate.createdAt });
  }
  return result;
}

export function sameSavedSearch(a: FleetSearchSnapshot, b: FleetSearchSnapshot): boolean {
  return (
    a.input === b.input &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope) &&
    a.kinds.length === b.kinds.length &&
    a.kinds.every((key) => b.kinds.includes(key))
  );
}

export function savedSearchScopeExists(
  scope: SearchScope,
  sections: readonly { id: string }[],
): boolean {
  return scope.kind !== 'section' || sections.some((section) => section.id === scope.id);
}
