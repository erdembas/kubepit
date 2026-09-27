import * as i18n from '@/i18n/core';
import type { ContainerImage, KubeObject } from '@/types';
import { asArray, asString, get, isObject } from './accessors';
import { parseApiVersion } from './catalog';

/**
 * Container image helpers for "Set image" and rollout history: where a kind
 * keeps its pod spec, splitting references into repository / tag / digest,
 * and the same sanity check the backend runs (`images.rs`), so problems
 * show up while typing instead of after a round trip.
 */

/** Dotted path of the pod spec for the kinds set image supports (mirrors `pod_spec_path`). */
export function podSpecPath(group: string, kind: string): string | null {
  if (group === '' && kind === 'Pod') return 'spec';
  if (
    (group === 'apps' && ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(kind)) ||
    (group === '' && kind === 'ReplicationController') ||
    (group === 'batch' && kind === 'Job')
  )
    return 'spec.template.spec';
  if (group === 'batch' && kind === 'CronJob') return 'spec.jobTemplate.spec.template.spec';
  return null;
}

export function supportsSetImage(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return podSpecPath(parseApiVersion(obj.apiVersion).group, obj.kind) !== null;
}

/** Images of a pod spec: app containers first, then init containers. */
export function podSpecImages(podSpec: unknown): ContainerImage[] {
  const spec = isObject(podSpec) ? podSpec : {};
  const out: ContainerImage[] = [];
  for (const [key, init] of [
    ['containers', false],
    ['initContainers', true],
  ] as const) {
    for (const c of asArray(spec[key]).filter(isObject))
      out.push({ container: asString(c.name), image: asString(c.image), init });
  }
  return out;
}

/** Images of an object set image supports; `[]` for other kinds. */
export function objectImages(obj: KubeObject): ContainerImage[] {
  const path = podSpecPath(parseApiVersion(obj.apiVersion).group, obj.kind);
  return path ? podSpecImages(get(obj, path)) : [];
}

export interface ImageParts {
  /** `ghcr.io/acme/api` (registry included). */
  repository: string;
  tag: string;
  /** `sha256:…` without the `@`. */
  digest: string;
}

/** `ghcr.io/acme/api:1.2@sha256:…` → repository, tag, digest. */
export function splitImage(image: string): ImageParts {
  let rest = image;
  let digest = '';
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = '';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { repository: rest, tag, digest };
}

/** Everything after the repository: `1.2`, `@sha256:…` or `1.2@sha256:…`. */
export function imageVersion(image: string): string {
  const { tag, digest } = splitImage(image);
  return `${tag}${digest ? `@${digest}` : ''}`;
}

/** Inverse of `splitImage` + `imageVersion`. */
export function joinImage(repository: string, version: string): string {
  const repo = repository.trim();
  const v = version.trim().replace(/^:/, '');
  if (!v) return repo;
  return v.startsWith('@') ? `${repo}${v}` : `${repo}:${v}`;
}

const MAX_IMAGE_LEN = 512;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Translated problem with an image reference, or `null` when it looks valid. */
export function validateImage(image: string): string | null {
  if (!image) return i18n.t('Image is required');
  if (/\s/.test(image)) return i18n.t('Image must not contain whitespace');
  if (image.length > MAX_IMAGE_LEN) return i18n.t('Image reference is too long');
  const bad = /[^A-Za-z0-9._\-/:@]/.exec(image);
  if (bad) return i18n.t('Invalid character "{char}"', { char: bad[0] });
  const at = image.indexOf('@');
  const name = at >= 0 ? image.slice(0, at) : image;
  if (at >= 0 && !/^[A-Za-z0-9]+:[0-9a-fA-F]{32,}$/.test(image.slice(at + 1)))
    return i18n.t('Invalid digest (expected @sha256:<hex>)');
  if (!/^[A-Za-z0-9]/.test(name)) return i18n.t('Must start with a letter or digit');
  const parts = name.split('/');
  if (parts.some((p) => !p)) return i18n.t('Empty path component');
  const last = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    const colons = parts[i]!.split(':').length - 1;
    const allowed = i === last ? 1 : i === 0 ? 1 : 0;
    if (colons > allowed) return i18n.t('Misplaced ":"');
  }
  const colon = parts[last]!.indexOf(':');
  if (colon >= 0) {
    if (colon === 0) return i18n.t('Missing repository name');
    const tag = parts[last]!.slice(colon + 1);
    if (!TAG.test(tag)) return i18n.t('Invalid tag "{tag}"', { tag });
  }
  return null;
}

/** The change-cause the backend records (`kubepit set image deployment/web web=nginx:1.27`). */
export function setImageChangeCause(kind: string, name: string, images: ContainerImage[]): string {
  const pairs = images.map((i) => `${i.container}=${i.image}`).join(' ');
  return `kubepit set image ${kind.toLowerCase()}/${name} ${pairs}`;
}

/** Stable identity of a container within a pod spec (`web`, `init:migrate`). */
export function containerKey(image: Pick<ContainerImage, 'container' | 'init'>): string {
  return `${image.init ? 'init:' : ''}${image.container}`;
}

/** Keys of the containers in `after` whose image differs from `before` (new ones included). */
export function changedContainers(
  before: ContainerImage[] | undefined,
  after: ContainerImage[],
): Set<string> {
  const old = new Map((before ?? []).map((i) => [containerKey(i), i.image]));
  return new Set(after.filter((i) => old.get(containerKey(i)) !== i.image).map(containerKey));
}
