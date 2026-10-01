import YAML from 'yaml';
import type { ChangePage, ClusterDef, ClusterStatus, KubeObject, MetricsSeries } from '@/types';
import type {
  Investigation,
  InvestigationCaptureRequest,
  InvestigationEvidence,
  InvestigationEvidenceKind,
} from '@/types/investigations';
import { asArray, asObject, asString } from '@/lib/kube/accessors';
import { matchesSelector, parseSelector } from '@/lib/kube/selectors';
import {
  byteLength,
  MAX_BUNDLE_BYTES,
  MAX_EVIDENCE_BYTES,
  parseInvestigationBundle,
  selectedEvidence,
  summarizeCounts,
  summary,
} from '@/components/workbench/investigations/bundle';
import { generatorFor } from './dock';
import { getDb, list } from './fixtures/db';
import { redactDemo } from './fixtures/ai';
import { handlers, register } from './registry';

const STORAGE = 'kubepit.demo.investigations.v1';
let volatile: Investigation[] = [];

/** Demo-only mirror. Real credentials should never be pasted into a demo;
 * imported bundles still receive structural and token redaction. */
function safeText(text: string): string {
  // Match the native redactor's treatment of manifests supplied as text,
  // including a bundle that deliberately mislabels Secret YAML as logs.
  if (/\b(?:apiVersion|kind|stringData|encryptedData|data)\s*["']?\s*:/.test(text)) {
    try {
      const documents = YAML.parseAllDocuments(text);
      if (documents.some((document) => document.errors.length)) return '__SECRET__';
      const values: unknown[] = documents.map((document) => document.toJS({ maxAliasCount: 20 }));
      if (values.some((value) => value && typeof value === 'object')) {
        text = values.map((value) => YAML.stringify(safeValue(value))).join('---\n');
      }
    } catch {
      return '__SECRET__';
    }
  }
  return redactDemo(
    text,
    'text',
    { tokens: true, ips: false, hostnames: false },
    { ips: new Map(), hosts: new Map() },
  )
    .text.replace(
      /(\b(?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1__TOKEN__',
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '__SECRET__',
    );
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return '__SECRET__';
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map((part) => safeValue(part, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const secret = typeof obj.kind === 'string' && obj.kind.toLowerCase().endsWith('secret');
  return Object.fromEntries(
    Object.entries(obj).map(([key, part]) => {
      if (
        (secret && ['data', 'stringData', 'encryptedData', 'spec'].includes(key)) ||
        ['data', 'stringData', 'encryptedData'].includes(key)
      ) {
        return [
          key,
          Object.fromEntries(Object.keys(asObject(part)).map((key) => [key, '__SECRET__'])),
        ];
      }
      if (key === 'metadata') {
        const { annotations: _annotations, managedFields: _managed, ...meta } = asObject(part);
        return [key, safeValue(meta, depth + 1)];
      }
      if (key === 'env' && Array.isArray(part))
        return [
          key,
          part.map((entry) => {
            const item = asObject(entry);
            return safeValue(
              { ...item, ...('value' in item ? { value: '__SECRET__' } : {}) },
              depth + 1,
            );
          }),
        ];
      return [safeText(key), safeValue(part, depth + 1)];
    }),
  );
}

function sanitized(record: Investigation): Investigation {
  const result = structuredClone(record);
  result.title = safeText(result.title);
  result.notes = safeText(result.notes);
  result.cluster_name = safeText(result.cluster_name);
  result.target = Object.fromEntries(
    Object.entries(result.target).map(([key, value]) => [key, safeText(value)]),
  ) as unknown as Investigation['target'];
  result.evidence = result.evidence.map((entry) => {
    let content = entry.content;
    if (content && entry.format !== 'text') {
      try {
        const parsed =
          entry.format === 'json'
            ? JSON.parse(content)
            : YAML.parse(content, { maxAliasCount: 20 });
        content =
          entry.format === 'json'
            ? JSON.stringify(safeValue(parsed), null, 2)
            : YAML.stringify(safeValue(parsed));
      } catch {
        content = '__SECRET__';
      }
    } else content = safeText(content);
    const capped = cap(content);
    return {
      ...entry,
      id: safeText(entry.id),
      label: safeText(entry.label),
      content: capped,
      ...(capped !== content
        ? { status: 'truncated' as const, reason: 'capture-limit' as const }
        : {}),
    };
  });
  return parseInvestigationBundle(JSON.stringify(summarizeCounts(result)));
}

function cap(text: string) {
  if (byteLength(text) <= MAX_EVIDENCE_BYTES) return text;
  const bytes = new TextEncoder().encode(text).subarray(0, MAX_EVIDENCE_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\uFFFD$/, '');
}

function read(): Investigation[] {
  if (typeof localStorage === 'undefined') return structuredClone(volatile);
  const text = localStorage.getItem(STORAGE);
  if (!text) return [];
  if (byteLength(text) > 20 * 1024 * 1024) throw new Error('investigations:store-too-large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('investigations:invalid-data');
  }
  const store = asObject(data);
  if (store.version !== 1) throw new Error('investigations:unsupported-version');
  if (!Array.isArray(store.items) || store.items.length > 50)
    throw new Error('investigations:invalid-data');
  const records = store.items.map((item) =>
    sanitized(parseInvestigationBundle(JSON.stringify(item))),
  );
  if (new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error('investigations:invalid-data');
  return records;
}
function write(records: Investigation[]) {
  const serialized = JSON.stringify({ version: 1, items: records });
  if (byteLength(serialized) > 20 * 1024 * 1024) throw new Error('investigations:store-too-large');
  if (typeof localStorage === 'undefined') volatile = structuredClone(records);
  else localStorage.setItem(STORAGE, serialized);
}
function save(record: Investigation): Investigation {
  const records = read();
  if (records.length >= 50) throw new Error('investigations:limit-reached');
  const result = sanitized(record);
  write([...records, result]);
  return result;
}
function get(id: string): Investigation {
  const record = read().find((record) => record.id === id);
  if (!record) throw new Error('investigations:not-found');
  return record;
}
function evidence(
  id: string,
  kind: InvestigationEvidenceKind,
  label: string,
  data: unknown,
  empty = false,
  truncated = false,
): InvestigationEvidence {
  const content = empty ? '' : YAML.stringify(safeValue(data));
  const capped = cap(content);
  return {
    id,
    kind,
    label,
    content: capped,
    format: capped === content ? 'yaml' : 'text',
    status: truncated || capped !== content ? 'truncated' : empty ? 'empty' : 'captured',
    reason: truncated || capped !== content ? 'capture-limit' : null,
  };
}
function unavailable(
  id: string,
  kind: InvestigationEvidenceKind,
  label: string,
  reason: InvestigationEvidence['reason'],
): InvestigationEvidence {
  return { id, kind, label, content: '', format: 'text', status: 'unavailable', reason };
}

register({
  investigations_list: ({ clusterId }) =>
    read()
      .filter((record) => !clusterId || !record.cluster_id || record.cluster_id === clusterId)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map(summary),
  investigation_get: ({ id }) => get(id),
  investigation_delete: ({ id }) => write(read().filter((record) => record.id !== id)),
  investigation_update: ({ id, title, notes }) => {
    const records = read();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error('investigations:not-found');
    const record = sanitized(
      parseInvestigationBundle(
        JSON.stringify({ ...records[index], title, notes, updated_at: Date.now() }),
      ),
    );
    records[index] = record;
    write(records);
    return record;
  },
  investigation_export: ({ id, evidenceIds }) => {
    const record = sanitized(get(id));
    record.cluster_id = null;
    record.evidence = selectedEvidence(record, evidenceIds ?? null);
    const exported = JSON.stringify(summarizeCounts(record), null, 2);
    if (byteLength(exported) > MAX_BUNDLE_BYTES) throw new Error('investigations:bundle-too-large');
    return exported;
  },
  investigation_import: ({ bundle }) => {
    const record = parseInvestigationBundle(bundle);
    return save({
      ...record,
      id: crypto.randomUUID(),
      cluster_id: null,
      imported: true,
      updated_at: Date.now(),
    });
  },
  investigation_capture: async ({ clusterId, request: raw }) => {
    const request = raw as InvestigationCaptureRequest;
    const statuses = (await handlers.cluster_statuses?.({})) as Record<string, ClusterStatus>;
    if (statuses[clusterId]?.state !== 'connected') throw new Error('investigations:disconnected');
    const clusters = (await handlers.cluster_list?.({})) as ClusterDef[];
    const cluster = clusters.find((value) => value.id === clusterId);
    if (!cluster) throw new Error('investigations:disconnected');
    if (
      !['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'].includes(
        request.gvk.kind,
      )
    )
      throw new Error('investigations:unsupported-target');
    const captured = Date.now();
    const since = captured - request.lookback_minutes * 60_000;
    const object = (await handlers.resource_get?.({
      clusterId,
      gvk: request.gvk,
      namespace: request.namespace,
      name: request.name,
    })) as KubeObject;
    const db = getDb(clusterId);
    const label = `${object.kind}/${object.metadata.name}`;
    let selected = object;
    if (object.kind === 'CronJob') {
      selected =
        list(db, 'jobs.batch')
          .filter((job) =>
            job.metadata.ownerReferences?.some((owner) => owner.uid === object.metadata.uid),
          )
          .sort((a, b) =>
            String(b.metadata.creationTimestamp).localeCompare(
              String(a.metadata.creationTimestamp),
            ),
          )[0] ?? object;
    }
    const selector = parseSelector(asObject(selected.spec).selector);
    const matches =
      object.kind === 'Pod'
        ? [object]
        : list(db, 'pods').filter(
            (pod) =>
              pod.metadata.namespace === request.namespace &&
              matchesSelector(selector, pod.metadata.labels),
          );
    const pods = matches.slice(0, 3);
    const entries: InvestigationEvidence[] = [
      evidence('object', 'object', label, object),
      evidence('pods', 'pods', request.namespace, pods, !pods.length, matches.length > 3),
    ];
    const targets = [object, ...pods.filter((pod) => pod.metadata.uid !== object.metadata.uid)];
    for (const [index, target] of targets.entries()) {
      const events = (await handlers.resource_events?.({
        clusterId,
        namespace: request.namespace,
        uid: target.metadata.uid,
      })) as KubeObject[];
      const filtered = events.filter(
        (event) =>
          Date.parse(String(event.lastTimestamp ?? event.metadata.creationTimestamp)) >= since,
      );
      entries.push(
        evidence(
          `events-${index}`,
          'events',
          target.metadata.name,
          filtered.slice(0, 50),
          !filtered.length,
          filtered.length > 50,
        ),
      );
    }
    let logIndex = 0;
    for (const pod of pods) {
      const containers = asArray(asObject(pod.spec).containers);
      for (const rawContainer of containers.slice(0, 2)) {
        const name = asString(asObject(rawContainer).name);
        const gen = generatorFor(pod.metadata.name, name);
        const content = Array.from({ length: 24 }, (_, index) => {
          const date = new Date(captured - (24 - index) * 3000);
          return gen(date)
            .map((line) => `${date.toISOString()} ${line}`)
            .join('\n');
        }).join('\n');
        entries.push({
          id: `logs-${logIndex++}`,
          kind: 'logs',
          label: `${pod.metadata.name}/${name}`,
          content: safeText(content),
          format: 'text',
          status: 'captured',
          reason: null,
        });
        const status = asArray(asObject(pod.status).containerStatuses)
          .map(asObject)
          .find((status) => status.name === name);
        if (typeof status?.restartCount === 'number' && status.restartCount > 0)
          entries.push({
            id: `logs-${logIndex++}`,
            kind: 'logs',
            label: `${pod.metadata.name}/${name}#previous`,
            content: `${new Date(captured - 60_000).toISOString()} previous container terminated\n${new Date(captured - 59_000).toISOString()} ${asString(asObject(asObject(status.lastState).terminated).reason, 'Error')}`,
            format: 'text',
            status: 'captured',
            reason: null,
          });
      }
      if (containers.length > 2 || asArray(asObject(pod.spec).initContainers).length)
        entries.push(
          unavailable(
            `logs-limit-${pod.metadata.name}`,
            'logs',
            pod.metadata.name,
            'capture-limit',
          ),
        );
    }
    if (!logIndex) entries.push(unavailable('logs', 'logs', label, 'no-pods'));
    const changes = (await handlers.changes_list?.({
      clusterId,
      filter: {
        namespaces: [request.namespace],
        kinds: [object.kind],
        name: object.metadata.name,
        since,
        until: captured,
        limit: 10,
      },
    })) as ChangePage;
    entries.push(
      changes?.status.recording
        ? evidence(
            'changes',
            'changes',
            label,
            changes.entries.map((entry) => ({
              ts: entry.ts,
              operation: entry.op,
              actor: entry.actor,
            })),
            !changes.entries.length,
            !!changes.next_cursor || !changes.status.synced,
          )
        : unavailable('changes', 'changes', label, 'not-recording'),
    );
    const metrics = (await handlers.metrics_history?.({
      clusterId,
      query: {
        scope: 'pods',
        namespace: request.namespace,
        names: pods.map((pod) => pod.metadata.name),
      },
    })) as MetricsSeries;
    const points =
      metrics?.points.filter((point) => point.ts >= since && point.ts <= captured) ?? [];
    entries.push(
      points.length && pods.length
        ? evidence('metrics', 'metrics', label, {
            source: 'metrics-server/history',
            pods: pods.map((pod) => pod.metadata.name),
            points,
          })
        : unavailable('metrics', 'metrics', label, pods.length ? 'not-available' : 'no-pods'),
    );
    return save({
      version: 1,
      id: crypto.randomUUID(),
      title: request.title,
      cluster_id: clusterId,
      cluster_name: cluster.name,
      target: {
        api_version: object.apiVersion,
        kind: object.kind,
        namespace: request.namespace,
        name: request.name,
      },
      captured_at: captured,
      updated_at: captured,
      imported: false,
      evidence_count: entries.length,
      incomplete_count: 0,
      notes: '',
      lookback_minutes: request.lookback_minutes,
      evidence: entries,
    });
  },
});
