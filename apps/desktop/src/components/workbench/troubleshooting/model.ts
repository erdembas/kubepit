import {
  asArray,
  asObject,
  asString,
  condition,
  isObject,
  lastTimestamp,
  spec,
  status,
} from '@/lib/kube/accessors';
import type { ObjectRef } from '@/lib/kube/columns';
import { podContainers, type ContainerInfo } from '@/lib/kube/pods';
import type { KubeObject } from '@/types';

export type DiagnosisCode =
  | 'crash-loop'
  | 'oom-current'
  | 'oom-previous'
  | 'image-pull'
  | 'config-error'
  | 'missing-config'
  | 'pending-scheduling'
  | 'pending-startup'
  | 'terminated-error';
export type EvidenceKind =
  'state' | 'restarts' | 'termination' | 'event' | 'condition' | 'phase' | 'node' | 'memory-limit';
export interface DiagnosisEvidence {
  kind: EvidenceKind;
  value: string;
  time?: string;
}
export interface PodFinding {
  id: string;
  code: DiagnosisCode;
  container?: string;
  evidence: DiagnosisEvidence[];
}
export interface PodDiagnosis {
  containers: ContainerInfo[];
  findings: PodFinding[];
  references: ObjectRef[];
  events: KubeObject[];
  phase: string;
}

const missingConfiguration = (message: string) =>
  /\b(?:secret|configmap)\b[^\n]*(?:not found|does not exist)/i.test(message) ||
  /(?:couldn't|cannot|could not) find key[^\n]*\b(?:secret|configmap)\b/i.test(message);

/** Only references, never literal env values, Secret data or ConfigMap contents. */
export function podReferences(pod: KubeObject): ObjectRef[] {
  const refs = new Map<string, ObjectRef>();
  const namespace = pod.metadata.namespace ?? 'default';
  const add = (kind: string, name: unknown, apiVersion = 'v1', ns: string | null = namespace) => {
    if (typeof name !== 'string' || !name) return;
    refs.set(`${apiVersion}/${kind}/${ns}/${name}`, { apiVersion, kind, name, namespace: ns });
  };
  const s = spec(pod);
  for (const container of [...asArray(s.initContainers), ...asArray(s.containers)].filter(
    isObject,
  )) {
    for (const env of asArray(container.env).filter(isObject)) {
      const from = asObject(env.valueFrom);
      add('Secret', asObject(from.secretKeyRef).name);
      add('ConfigMap', asObject(from.configMapKeyRef).name);
    }
    for (const env of asArray(container.envFrom).filter(isObject)) {
      add('Secret', asObject(env.secretRef).name);
      add('ConfigMap', asObject(env.configMapRef).name);
    }
  }
  for (const volume of asArray(s.volumes).filter(isObject)) {
    add('Secret', asObject(volume.secret).secretName);
    add('ConfigMap', asObject(volume.configMap).name);
    add('PersistentVolumeClaim', asObject(volume.persistentVolumeClaim).claimName);
    for (const source of asArray(asObject(volume.projected).sources).filter(isObject)) {
      add('Secret', asObject(source.secret).name);
      add('ConfigMap', asObject(source.configMap).name);
    }
  }
  for (const secret of asArray(s.imagePullSecrets).filter(isObject)) add('Secret', secret.name);
  add('ServiceAccount', s.serviceAccountName);
  add('Node', s.nodeName, 'v1', null);
  for (const owner of pod.metadata.ownerReferences ?? [])
    add(owner.kind, owner.name, owner.apiVersion);
  return [...refs.values()];
}

export function diagnosePod(pod: KubeObject, suppliedEvents: readonly KubeObject[]): PodDiagnosis {
  const containers = podContainers(pod);
  const phase = asString(status(pod).phase) || 'Unknown';
  const events = suppliedEvents
    .filter((event) => {
      const ref = asObject(event.involvedObject ?? event.regarding);
      return !ref.uid || ref.uid === pod.metadata.uid;
    })
    .sort(
      (a, b) =>
        (Date.parse(lastTimestamp(b) ?? '') || 0) - (Date.parse(lastTimestamp(a) ?? '') || 0),
    )
    .slice(0, 100);
  const findings: PodFinding[] = [];
  const eventEvidence = (match: (event: KubeObject) => boolean): DiagnosisEvidence[] =>
    events
      .filter(match)
      .slice(0, 3)
      .map((event) => ({
        kind: 'event',
        value: [asString(event.reason), asString(event.message ?? event.note)]
          .filter(Boolean)
          .join(': '),
        time: lastTimestamp(event),
      }));
  for (const container of containers) {
    const state: DiagnosisEvidence = {
      kind: 'state',
      value: [container.state, container.reason, container.message].filter(Boolean).join(' · '),
    };
    const restarts: DiagnosisEvidence = { kind: 'restarts', value: String(container.restarts) };
    const add = (code: DiagnosisCode, evidence: DiagnosisEvidence[]) =>
      findings.push({
        id: `${container.init ? 'init' : 'app'}/${container.name}/${code}`,
        code,
        container: container.name,
        evidence,
      });
    if (container.reason === 'CrashLoopBackOff')
      add('crash-loop', [
        state,
        restarts,
        ...eventEvidence(
          (event) =>
            asString(event.reason) === 'BackOff' &&
            asString(event.message).includes(container.name),
        ),
      ]);
    if (container.reason === 'OOMKilled' || container.lastTermination?.reason === 'OOMKilled') {
      const current = container.reason === 'OOMKilled';
      const memory = asString(asObject(asObject(container.spec.resources).limits).memory);
      add(current ? 'oom-current' : 'oom-previous', [
        ...(current
          ? [state]
          : [
              {
                kind: 'termination' as const,
                value: `OOMKilled · ${container.lastTermination?.exitCode ?? '?'}`,
                time: container.lastTermination?.finishedAt ?? undefined,
              },
            ]),
        restarts,
        ...(memory ? [{ kind: 'memory-limit' as const, value: memory }] : []),
      ]);
    }
    if (['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(container.reason ?? ''))
      add('image-pull', [
        state,
        ...eventEvidence((event) => /pull|image/i.test(asString(event.message))),
      ]);
    if (container.reason === 'CreateContainerConfigError')
      add(missingConfiguration(container.message ?? '') ? 'missing-config' : 'config-error', [
        state,
      ]);
    if (
      container.state === 'terminated' &&
      container.exitCode !== null &&
      container.exitCode !== 0 &&
      container.reason !== 'OOMKilled'
    )
      add('terminated-error', [state, { kind: 'termination', value: String(container.exitCode) }]);
  }
  if (phase === 'Pending') {
    const scheduled = condition(pod, 'PodScheduled');
    const node = asString(spec(pod).nodeName);
    const unscheduled = !node && scheduled?.status === 'False';
    findings.push({
      id: 'pod/pending',
      code: unscheduled ? 'pending-scheduling' : 'pending-startup',
      evidence: [
        { kind: 'phase', value: phase },
        ...(scheduled
          ? [
              {
                kind: 'condition' as const,
                value: [scheduled.type, scheduled.status, scheduled.reason, scheduled.message]
                  .filter(Boolean)
                  .join(' · '),
              },
            ]
          : []),
        ...(node ? [{ kind: 'node' as const, value: node }] : []),
        ...eventEvidence((event) =>
          [
            'FailedScheduling',
            'FailedMount',
            'FailedAttachVolume',
            'FailedCreatePodSandBox',
          ].includes(asString(event.reason)),
        ),
      ],
    });
  }
  // Old warning events must not imply a current config failure after recovery.
  if (phase === 'Pending' || containers.some((container) => container.state === 'waiting')) {
    const missing = eventEvidence((event) =>
      missingConfiguration(asString(event.message ?? event.note)),
    );
    if (missing.length)
      findings.push({ id: 'pod/config-event', code: 'missing-config', evidence: missing });
  }
  return { containers, findings, references: podReferences(pod), events, phase };
}

export type EvidenceError = 'forbidden' | 'missing' | 'timeout' | 'unavailable';
export function evidenceError(error: unknown): EvidenceError {
  const text = String(error).toLowerCase();
  if (/forbidden|\b403\b|permission denied/.test(text)) return 'forbidden';
  if (/not found|\b404\b|no previous|previous.*does not exist/.test(text)) return 'missing';
  if (/timeout|timed out/.test(text)) return 'timeout';
  return 'unavailable';
}
