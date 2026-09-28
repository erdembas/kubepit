import type { KubeObject } from '@/types';
import { asArray, asObject, asString, isObject } from '../accessors';
import type { HealthKind } from './types';

/**
 * Secret names referenced by controller objects that read Secrets through
 * the API instead of mounting them: cert-manager issuers, Gateway API
 * listeners, admission webhook configurations (CA injection) and Flux
 * sources, kustomizations, Helm releases and notification providers.
 */

/** Lists `secret-unused` reads for controller references (watched only when served). */
export const SECRET_REFERRERS: readonly HealthKind[] = [
  'issuers',
  'clusterIssuers',
  'gateways',
  'validatingWebhooks',
  'mutatingWebhooks',
  'gitRepositories',
  'helmRepositories',
  'ociRepositories',
  'kustomizations',
  'helmReleases',
  'fluxProviders',
];

export interface SecretRef {
  /** `null`: any namespace (a cluster-scoped referrer without an explicit namespace). */
  namespace: string | null;
  name: string;
}

/** `{ name, namespace? }` objects naming a Secret. */
const REF_KEYS = new Set(['secretRef', 'certSecretRef', 'privateKeySecretRef']);
/** Lists of `{ kind, name }` sources; only `kind: Secret` entries count. */
const FROM_KEYS = new Set(['valuesFrom', 'substituteFrom']);
const INJECT_CA_FROM_SECRET = 'cert-manager.io/inject-ca-from-secret';

function push(out: SecretRef[], ref: unknown, own: string | null) {
  const r = asObject(ref);
  const name = asString(r.name);
  if (name) out.push({ namespace: asString(r.namespace) || own, name });
}

function walk(value: unknown, own: string | null, out: SecretRef[], depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, own, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    if (REF_KEYS.has(key)) push(out, v, own);
    else if (key === 'secretName' && typeof v === 'string') {
      if (v) out.push({ namespace: own, name: v });
    } else if (key === 'certificateRefs') {
      // Gateway API: the kind defaults to Secret.
      for (const r of asArray(v).filter(isObject))
        if (!r.kind || r.kind === 'Secret') push(out, r, own);
    } else if (FROM_KEYS.has(key)) {
      for (const r of asArray(v).filter(isObject)) if (r.kind === 'Secret') push(out, r, own);
    }
    if (typeof v === 'object' && v !== null) walk(v, own, out, depth + 1);
  }
}

const cache = new WeakMap<KubeObject, SecretRef[]>();

/** Secrets one controller object names, memoized per object snapshot. */
export function controllerSecretRefs(obj: KubeObject): SecretRef[] {
  const hit = cache.get(obj);
  if (hit) return hit;
  const own = obj.metadata.namespace || null;
  const out: SecretRef[] = [];
  walk(obj.spec, own, out);
  // `namespace/name`: cert-manager's cainjector reads the CA from this Secret.
  const inject = obj.metadata.annotations?.[INJECT_CA_FROM_SECRET]?.trim();
  if (inject) {
    const slash = inject.indexOf('/');
    if (slash < 0) out.push({ namespace: own, name: inject });
    else if (inject.slice(slash + 1))
      out.push({ namespace: inject.slice(0, slash) || own, name: inject.slice(slash + 1) });
  }
  cache.set(obj, out);
  return out;
}
