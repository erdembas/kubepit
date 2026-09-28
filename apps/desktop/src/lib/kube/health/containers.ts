import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, type JsonObject } from '../accessors';
import { splitImage } from '../images';
import { makeFinding, podSpecOf, type Emit } from './context';

/**
 * Pod-spec rules: resources, probes, images and security context. Run once
 * per workload template (or bare pod), never per replica.
 */

const BATCH_KINDS = new Set(['Job', 'CronJob']);

function has(map: JsonObject, key: string) {
  return map[key] !== undefined && map[key] !== null && map[key] !== '';
}

function resourceFindings(owner: KubeObject, c: JsonObject, name: string, emit: Emit) {
  const res = asObject(c.resources);
  const requests = asObject(res.requests);
  const limits = asObject(res.limits);
  // Requests default to limits when only limits are set.
  const cpu = has(requests, 'cpu') || has(limits, 'cpu');
  const memory = has(requests, 'memory') || has(limits, 'memory');
  if (!cpu || !memory) {
    const message =
      !cpu && !memory
        ? i18n.t('Container {container} has no CPU and no memory request', { container: name })
        : !cpu
          ? i18n.t('Container {container} has no CPU request', { container: name })
          : i18n.t('Container {container} has no memory request', { container: name });
    emit(makeFinding('container-no-requests', owner, message, name));
  }
  if (!has(limits, 'memory'))
    emit(
      makeFinding(
        'container-no-memory-limit',
        owner,
        i18n.t('Container {container} has no memory limit', { container: name }),
        name,
      ),
    );
}

function probeFindings(owner: KubeObject, c: JsonObject, name: string, emit: Emit) {
  if (!isObject(c.readinessProbe) && asArray(c.ports).length > 0)
    emit(
      makeFinding(
        'container-no-readiness-probe',
        owner,
        i18n.t('Container {container} has no readiness probe', { container: name }),
        name,
      ),
    );
  if (!isObject(c.livenessProbe))
    emit(
      makeFinding(
        'container-no-liveness-probe',
        owner,
        i18n.t('Container {container} has no liveness probe', { container: name }),
        name,
      ),
    );
}

function imageFindings(owner: KubeObject, c: JsonObject, name: string, emit: Emit) {
  const image = asString(c.image);
  if (!image) return;
  const { tag, digest } = splitImage(image);
  if (!digest && (tag === '' || tag === 'latest'))
    emit(
      makeFinding(
        'image-latest-tag',
        owner,
        tag
          ? i18n.t('Container {container} uses {image} with the :latest tag', {
              container: name,
              image,
            })
          : i18n.t('Container {container} uses {image} without a tag (implies :latest)', {
              container: name,
              image,
            }),
        name,
      ),
    );
  if (digest && asString(c.imagePullPolicy) === 'Always')
    emit(
      makeFinding(
        'image-pull-always-digest',
        owner,
        i18n.t('Container {container} pulls a pinned digest with imagePullPolicy Always', {
          container: name,
        }),
        name,
      ),
    );
}

function securityFindings(
  owner: KubeObject,
  c: JsonObject,
  name: string,
  podSc: JsonObject,
  emit: Emit,
) {
  const sc = asObject(c.securityContext);
  const privileged = sc.privileged === true;
  if (privileged)
    emit(
      makeFinding(
        'container-privileged',
        owner,
        i18n.t('Container {container} runs privileged', { container: name }),
        name,
      ),
    );
  const runAsUser = sc.runAsUser ?? podSc.runAsUser;
  const runAsNonRoot = sc.runAsNonRoot ?? podSc.runAsNonRoot;
  if (runAsUser === 0)
    emit(
      makeFinding(
        'container-run-as-root',
        owner,
        i18n.t('Container {container} runs as root (runAsUser: 0)', { container: name }),
        name,
      ),
    );
  else if (runAsNonRoot !== true && runAsUser === undefined)
    emit(
      makeFinding(
        'container-run-as-root',
        owner,
        i18n.t('Container {container} does not set runAsNonRoot and may run as root', {
          container: name,
        }),
        name,
        'info',
      ),
    );
  if (sc.allowPrivilegeEscalation === true && !privileged)
    emit(
      makeFinding(
        'container-privilege-escalation',
        owner,
        i18n.t('Container {container} sets allowPrivilegeEscalation: true', { container: name }),
        name,
      ),
    );
  // Unset is the Kubernetes default and very common; the rule is opt-in per cluster.
  else if (sc.allowPrivilegeEscalation === undefined && !privileged)
    emit(
      makeFinding(
        'container-privilege-escalation-unset',
        owner,
        i18n.t('Container {container} does not set allowPrivilegeEscalation: false', {
          container: name,
        }),
        name,
      ),
    );
}

/** Every pod-spec finding of one workload template or bare pod. */
export function podSpecFindings(owner: KubeObject, emit: Emit) {
  const spec = podSpecOf(owner);
  if (!spec) return;
  const batch =
    BATCH_KINDS.has(owner.kind) ||
    (owner.kind === 'Pod' && ['Never', 'OnFailure'].includes(asString(spec.restartPolicy)));
  const podSc = asObject(spec.securityContext);
  const main = asArray(spec.containers).filter(isObject);
  const init = asArray(spec.initContainers).filter(isObject);
  for (const c of main) {
    const name = asString(c.name);
    resourceFindings(owner, c, name, emit);
    if (!batch) probeFindings(owner, c, name, emit);
  }
  for (const c of [...main, ...init]) {
    const name = asString(c.name);
    imageFindings(owner, c, name, emit);
    securityFindings(owner, c, name, podSc, emit);
  }
  const hostPaths = asArray(spec.volumes)
    .filter(isObject)
    .map((v) => asString(asObject(v.hostPath).path))
    .filter(Boolean);
  if (hostPaths.length)
    emit(
      makeFinding(
        'pod-host-path',
        owner,
        i18n.t('Mounts host paths: {paths}', { paths: hostPaths.join(', ') }),
      ),
    );
  const hostNs = (['hostNetwork', 'hostPID', 'hostIPC'] as const).filter((k) => spec[k] === true);
  if (hostNs.length)
    emit(
      makeFinding(
        'pod-host-network',
        owner,
        i18n.t('Shares host namespaces: {fields}', { fields: hostNs.join(', ') }),
      ),
    );
}
