import YAML from 'yaml';
import type {
  ClusterDef,
  DryRunResult,
  KubeObject,
  ManifestApplyResult,
  ManifestDocument,
  ManifestProblem,
  ManifestRecent,
  ManifestRender,
  ManifestSource,
  ManifestSourceKind,
} from '@/types';
import { sleep } from './bus';
import { find, getDb, keyOf } from './fixtures/db';
import {
  CHART_VALUES_FILES,
  NESTED,
  PLAIN_FILES,
  chartOutput,
  overlayOutput,
} from './fixtures/manifestProject';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo implementation of local manifests. There is no filesystem in the
 * browser: every picked path renders as the fixture project in
 * `fixtures/manifestProject.ts` (its overlays and chart by their sub-paths).
 * Dry runs and applies go through the demo `resource_dry_run_yaml` /
 * `resource_apply_yaml`, plus the namespace check a real API server makes.
 * Messages mirror kubepit-core.
 */

const DEMO_ROOT = '/Users/demo/src/shop-deploy';

let recent: ManifestRecent[] = [
  {
    source: { paths: [DEMO_ROOT], kind: 'auto', helm: null },
    opened_at: Date.now() - 3_600_000,
  },
  {
    source: {
      paths: [`${DEMO_ROOT}/charts/storefront`],
      kind: 'helm',
      helm: { release_name: 'storefront', namespace: 'web', values_files: ['values-prod.yaml'] },
    },
    opened_at: Date.now() - 86_400_000,
  },
];

// -- Parsing (mirrors manifests/parse.rs) ---------------------------------------

class Parsed {
  documents: ManifestDocument[] = [];
  problems: ManifestProblem[] = [];
  private ids = new Map<string, number>();
  private perSource = new Map<string, number>();

  problem(source: string, line: number, message: string) {
    this.problems.push({ source, line, message });
  }

  addText(text: string, source: string, rendered = false) {
    const lines = text.split('\n');
    let chunk: string[] = [];
    let start = 0;
    const flush = () => {
      const body = chunk.join('\n');
      if (chunk.some((l) => l.trim() && !l.trim().startsWith('#'))) {
        const from = rendered ? (/^# Source: (.+)$/m.exec(body)?.[1]?.trim() ?? source) : source;
        const doc = YAML.parseDocument(body);
        if (doc.errors.length) {
          const err = doc.errors[0]!;
          const line = start + (err.linePos?.[0]?.line ?? 1) - 1;
          this.problem(from, line, `invalid YAML: ${err.message.split('\n')[0]}`);
        } else this.addValue(doc.toJS(), from, start);
      }
      chunk = [];
      start = 0;
    };
    lines.forEach((raw, i) => {
      if (raw === '---' || raw.startsWith('--- ')) {
        flush();
        return;
      }
      if (!start) {
        if (!raw.trim()) return;
        start = i + 1;
      }
      chunk.push(raw);
    });
    flush();
  }

  private addValue(value: unknown, source: string, line: number) {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.problem(source, line, 'skipped: not a Kubernetes object');
      return;
    }
    const obj = value as KubeObject & { items?: unknown[] };
    if (obj.kind === 'List' && Array.isArray(obj.items)) {
      for (const item of obj.items) this.addValue(item, source, line);
      return;
    }
    if (!obj.apiVersion || !obj.kind) {
      this.problem(source, line, 'skipped: not a Kubernetes object (no apiVersion or kind)');
      return;
    }
    const group = obj.apiVersion.includes('/') ? obj.apiVersion.split('/')[0]! : '';
    const name = obj.metadata?.name ?? '';
    const namespace = obj.metadata?.namespace || null;
    const identity = `${group}/${obj.kind}/${namespace ?? ''}/${name}`;
    const seen = (this.ids.get(identity) ?? 0) + 1;
    this.ids.set(identity, seen);
    const index = this.perSource.get(source) ?? 0;
    this.perSource.set(source, index + 1);
    this.documents.push({
      id: seen === 1 ? identity : `${identity} #${seen}`,
      source,
      index,
      line,
      api_version: obj.apiVersion,
      kind: obj.kind,
      name,
      namespace,
      yaml: YAML.stringify(obj, { lineWidth: 0 }),
    });
  }
}

// -- Rendering ----------------------------------------------------------------

function trimSlash(path: string) {
  return path.replace(/[\\/]+$/, '');
}

function detect(path: string): ManifestSourceKind {
  const hit = NESTED.find((n) => trimSlash(path).endsWith(`/${n.relative}`));
  return hit?.kind ?? 'plain';
}

function fingerprintOf(source: ManifestSource): string {
  return `demo-${JSON.stringify(source).length.toString(16)}`;
}

function renderSource(source: ManifestSource): ManifestRender {
  const paths = source.paths.map((p) => p.trim()).filter(Boolean);
  if (!paths.length) throw new Error('pick a folder or manifest files first');
  const bad = paths.find((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p));
  if (bad) throw new Error(`${bad} is not an absolute path`);
  const single = paths.length === 1 ? trimSlash(paths[0]!) : null;
  const detected = single ? detect(single) : 'plain';
  let kind = source.kind === 'auto' ? detected : source.kind;
  if (!single) kind = source.kind === 'auto' || source.kind === 'plain' ? 'plain' : kind;
  if ((kind === 'kustomize' || kind === 'helm') && !single)
    throw new Error('Kustomize and Helm render one folder; pick a single folder');
  if (kind === 'kustomize' && detected !== 'kustomize')
    throw new Error(`${single} has no kustomization.yaml, so it cannot be rendered with Kustomize`);
  if (kind === 'helm' && detected !== 'helm')
    throw new Error(`${single} is not a Helm chart (no Chart.yaml)`);

  const parsed = new Parsed();
  let command: string | null = null;
  let files = 0;
  let nested: ManifestRender['nested'] = [];
  let root = single ?? DEMO_ROOT;

  if (kind === 'kustomize') {
    const env = single!.endsWith('staging') ? 'staging' : 'prod';
    command = `kubectl kustomize ${single}`;
    parsed.addText(overlayOutput(env), 'kustomization.yaml', true);
  } else if (kind === 'helm') {
    const release = source.helm?.release_name.trim() || 'storefront';
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(release) || release.length > 53)
      throw new Error(
        `invalid release name "${release}": use lowercase letters, digits, '-' and '.', starting and ending with a letter or digit`,
      );
    const namespace = source.helm?.namespace?.trim() || 'default';
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))
      throw new Error(`invalid namespace "${namespace}"`);
    const values = (source.helm?.values_files ?? []).map((v) => v.trim()).filter(Boolean);
    for (const v of values) {
      const rel = v.startsWith(`${single}/`) ? v.slice(single!.length + 1) : v;
      if (!CHART_VALUES_FILES.includes(rel)) throw new Error(`values file ${v} does not exist`);
    }
    command = `helm template ${release} ${single} --namespace=${namespace} --include-crds${values
      .map((v) => ` --values=${v}`)
      .join('')}`;
    parsed.addText(
      chartOutput({ release_name: release, namespace, values_files: values }),
      'storefront',
      true,
    );
  } else {
    // Several picked files: the fixture files they name (by path suffix).
    const picked = single
      ? PLAIN_FILES
      : PLAIN_FILES.filter((f) => paths.some((p) => p.endsWith(`/${f.path}`)));
    if (!single) root = paths[0]!.slice(0, paths[0]!.lastIndexOf('/')) || DEMO_ROOT;
    for (const file of picked.length ? picked : PLAIN_FILES) {
      files++;
      parsed.addText(file.text, single ? file.path : file.path.split('/').pop()!);
    }
    if (single)
      nested = NESTED.map((n) => ({
        path: `${single}/${n.relative}`,
        relative: n.relative,
        kind: n.kind,
      }));
  }
  return {
    root,
    kind,
    files,
    documents: parsed.documents,
    problems: parsed.problems,
    nested,
    command,
    fingerprint: fingerprintOf(source),
    rendered_at: Date.now(),
  };
}

function remember(source: ManifestSource) {
  const key = (s: ManifestSource) => [...s.paths].sort().join('\0');
  recent = [
    { source, opened_at: Date.now() },
    ...recent.filter((r) => key(r.source) !== key(source)),
  ].slice(0, 12);
}

// -- Dry run / apply ----------------------------------------------------------

const KIND_ORDER = [
  'Namespace',
  'NetworkPolicy',
  'ResourceQuota',
  'LimitRange',
  'PodDisruptionBudget',
  'ServiceAccount',
  'Secret',
  'ConfigMap',
  'StorageClass',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'CustomResourceDefinition',
  'ClusterRole',
  'ClusterRoleBinding',
  'Role',
  'RoleBinding',
  'Service',
  'DaemonSet',
  'Pod',
  'ReplicaSet',
  'Deployment',
  'HorizontalPodAutoscaler',
  'StatefulSet',
  'Job',
  'CronJob',
  'IngressClass',
  'Ingress',
];

const rank = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
};

function kindOf(yaml: string): string {
  try {
    return String((YAML.parse(yaml) as { kind?: unknown } | null)?.kind ?? '');
  } catch {
    return '';
  }
}

function single(yaml: string): KubeObject {
  const docs = YAML.parseAllDocuments(yaml).filter((d) => d.contents !== null);
  if (docs.length !== 1)
    throw new Error(
      docs.length
        ? `expected one object per document, found ${docs.length}`
        : 'the document contains no object',
    );
  if (docs[0]!.errors.length) throw new Error(`document 1 is not valid YAML`);
  return docs[0]!.toJS() as KubeObject;
}

/** A real API server rejects namespaced objects whose namespace does not exist. */
function missingNamespace(clusterId: string, namespace: string | null): string | null {
  if (!namespace) return null;
  const db = getDb(clusterId);
  return find(db, 'namespaces', null, namespace) ? null : `namespaces "${namespace}" not found`;
}

function failed(error: string): DryRunResult {
  return {
    api_version: '',
    kind: '',
    name: '',
    namespace: null,
    operation: 'create',
    live: null,
    result: null,
    error,
  };
}

async function dryRunOne(
  clusterId: string,
  yaml: string,
  namespace: string | null,
): Promise<DryRunResult> {
  try {
    single(yaml);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  const results = (await handlers.resource_dry_run_yaml!({
    clusterId,
    yaml,
    mode: 'apply',
    namespace,
  })) as DryRunResult[];
  const result = results[0]!;
  if (!result.error && !result.live) {
    const missing = missingNamespace(clusterId, result.namespace);
    if (missing) return { ...result, result: null, error: missing };
  }
  return result;
}

function assertWritable(clusterId: string) {
  const clusters = (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
  const cluster = clusters.find((c) => c.id === clusterId);
  if (cluster?.read_only)
    throw new Error(`Cluster "${cluster.name}" is read-only: apply is not allowed`);
}

register({
  manifests_render: async ({ source }: MockArgs) => {
    await sleep(source.kind === 'helm' || detect(source.paths?.[0] ?? '') !== 'plain' ? 420 : 180);
    const out = renderSource(source as ManifestSource);
    remember(source as ManifestSource);
    return structuredClone(out);
  },
  // Demo files never change: a watch gets an id and never fires.
  manifests_watch: async () => `manifests-watch-${crypto.randomUUID().slice(0, 8)}`,
  manifests_unwatch: async () => undefined,
  manifests_recent_list: async () => structuredClone(recent),
  manifests_recent_remove: async ({ paths }: MockArgs) => {
    const key = (list: string[]) => [...list].sort().join('\0');
    recent = recent.filter((r) => key(r.source.paths) !== key(paths as string[]));
    return structuredClone(recent);
  },
  // Allowed on read-only clusters, like the real command.
  manifests_dry_run: async ({ clusterId, documents, namespace }: MockArgs) => {
    const docs = documents as string[];
    if (!docs.length) throw new Error('there is nothing to diff');
    await sleep(300 + Math.random() * 500);
    // Documents run concurrently, like the real command.
    const out = await Promise.all(
      docs.map((yaml) => dryRunOne(clusterId, yaml, namespace ?? null)),
    );
    return structuredClone(out);
  },
  manifests_apply: async ({ clusterId, documents, namespace }: MockArgs) => {
    assertWritable(clusterId);
    const docs = documents as string[];
    if (!docs.length) throw new Error('there is nothing to apply');
    const order = docs
      .map((_, i) => i)
      .sort((a, b) => rank(kindOf(docs[a]!)) - rank(kindOf(docs[b]!)));
    const results: ManifestApplyResult[] = docs.map(() => ({ object: null, error: null }));
    for (const i of order) {
      try {
        const obj = single(docs[i]!);
        const db = getDb(clusterId);
        const exists =
          obj.metadata?.name &&
          find(
            db,
            keyOf(db, obj),
            obj.metadata.namespace ?? namespace ?? 'default',
            obj.metadata.name,
          );
        if (!exists && obj.kind !== 'Namespace') {
          const dry = await dryRunOne(clusterId, docs[i]!, namespace ?? null);
          if (dry.error) throw new Error(dry.error);
        }
        const applied = (await handlers.resource_apply_yaml!({
          clusterId,
          yaml: docs[i],
          mode: 'apply',
          namespace: namespace ?? null,
        })) as KubeObject[];
        results[i] = { object: applied[0] ?? null, error: null };
      } catch (e) {
        results[i] = { object: null, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return structuredClone(results);
  },
});
