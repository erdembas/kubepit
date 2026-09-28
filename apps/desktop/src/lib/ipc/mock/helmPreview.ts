import YAML from 'yaml';
import type {
  DryRunResult,
  HelmInstallResult,
  HelmPreviewChange,
  HelmPreviewObject,
  HelmReleaseDetail,
  HelmUpgradePreview,
  HelmUpgradeRequest,
  JsonSchema,
  KubeObject,
} from '@/types';
import { sleep } from './bus';
import { droppedPaths } from './droppedPaths';
import { CHARTS, chartDef, type ChartDef } from './fixtures/charts';
import { getDb, helmKey } from './fixtures/db';
import { handlers, register, type MockArgs } from './registry';
import { manifestDocs } from './upgrade';

/**
 * Demo Helm values schemas and upgrade preview. Charts from the bitnami,
 * ingress-nginx, jetstack and prometheus-community repositories ship a
 * `values.schema.json` generated from their documented parameters (types,
 * descriptions, a few enums and ranges, `resources` through a `$ref`);
 * the others have none, like many real charts. The preview mirrors
 * `crates/kubepit-core/src/helm_preview.rs` over the demo dry-run upgrade.
 */

const WITH_SCHEMA = new Set(['bitnami', 'ingress-nginx', 'jetstack', 'prometheus-community']);

type Schema = Record<string, unknown> & { properties?: Record<string, Schema> };

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value === 'object' ? 'object' : typeof value;
}

function leafSchema(key: string, value: unknown, description: string): Schema {
  if (key === 'resources') return { $ref: '#/definitions/resources', description };
  const type = typeOf(value);
  const out: Schema = type === 'null' ? { description } : { type, description };
  if (type === 'string' && /^(tag|image)$/i.test(key)) out.type = ['string', 'null'];
  if (/replica(s|Count)$/i.test(key) && type === 'integer') out.minimum = 0;
  if (/port$/i.test(key) && type === 'integer') Object.assign(out, { minimum: 1, maximum: 65535 });
  if (key === 'pullPolicy') out.enum = ['Always', 'IfNotPresent', 'Never'];
  if (key === 'type' && typeof value === 'string' && /ClusterIP|NodePort|LoadBalancer/.test(value))
    out.enum = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'];
  return out;
}

/** A draft-07 `values.schema.json` from a demo chart's documented parameters. */
export function demoValuesSchema(chart: ChartDef): JsonSchema | null {
  if (!WITH_SCHEMA.has(chart.repo)) return null;
  const root: Schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `Values for ${chart.chart}`,
    type: 'object',
    properties: {},
    definitions: {
      resources: {
        type: 'object',
        description: 'Container resource requests and limits.',
        additionalProperties: false,
        properties: {
          limits: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
          requests: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        },
      },
    },
  };
  for (const [path, description, value] of chart.params) {
    const keys = path.split('.');
    let node = root;
    keys.forEach((key, i) => {
      node.properties ??= {};
      if (i === keys.length - 1) {
        node.properties[key] = leafSchema(key, value, description.replace(/`/g, ''));
        return;
      }
      node.properties[key] ??= { type: 'object', properties: {} };
      node = node.properties[key]!;
    });
  }
  return root;
}

function chartFor(chartRef: string): ChartDef | null {
  const oci = /^oci:\/\/registry-1\.docker\.io\/bitnamicharts\/([a-z0-9-]+)$/.exec(chartRef);
  if (oci) return chartDef('bitnami', oci[1]!) ?? null;
  const [repo = '', name = ''] = chartRef.split('/');
  return chartDef(repo, name) ?? CHARTS.find((c) => c.chart === name) ?? null;
}

// -- Preview ---------------------------------------------------------------------

const CLUSTER_SCOPED = new Set([
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'IngressClass',
  'MutatingWebhookConfiguration',
  'Namespace',
  'PersistentVolume',
  'PriorityClass',
  'StorageClass',
  'ValidatingWebhookConfiguration',
]);

function identity(o: KubeObject, releaseNamespace: string) {
  const group = o.apiVersion.includes('/') ? o.apiVersion.split('/')[0]! : '';
  const namespace = o.metadata.namespace || (CLUSTER_SCOPED.has(o.kind) ? null : releaseNamespace);
  return { key: `${group}/${o.kind}/${namespace ?? ''}/${o.metadata.name}`, namespace };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ORDER: Record<HelmPreviewChange, number> = { added: 0, changed: 1, removed: 2, unchanged: 3 };

export function diffManifests(before: string, after: string, ns: string): HelmPreviewObject[] {
  const old = new Map(manifestDocs(before).map((d) => [identity(d.value, ns).key, d] as const));
  const out: HelmPreviewObject[] = [];
  for (const doc of manifestDocs(after)) {
    const id = identity(doc.value, ns);
    if (out.some((o) => o.key === id.key)) continue;
    const previous = old.get(id.key);
    old.delete(id.key);
    out.push({
      key: id.key,
      api_version: doc.apiVersion,
      kind: doc.kind,
      namespace: id.namespace,
      name: doc.name,
      source: doc.source ?? previous?.source ?? null,
      change: !previous ? 'added' : same(previous.value, doc.value) ? 'unchanged' : 'changed',
      before: previous?.value ?? null,
      after: doc.value,
      live: null,
      dropped_fields: [],
    });
  }
  for (const [key, doc] of old)
    out.push({
      key,
      api_version: doc.apiVersion,
      kind: doc.kind,
      namespace: identity(doc.value, ns).namespace,
      name: doc.name,
      source: doc.source,
      change: 'removed',
      before: doc.value,
      after: null,
      live: null,
      dropped_fields: [],
    });
  return out.sort(
    (a, b) =>
      ORDER[a.change] - ORDER[b.change] ||
      a.kind.localeCompare(b.kind) ||
      (a.namespace ?? '').localeCompare(b.namespace ?? '') ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Demo: the chart versions the demo upgrades to stop setting this
 * annotation, which the running revision rendered on the release's first
 * changed Deployment (so it is live too). The review then lists it under
 * the fields helm removes. Only the preview's copies carry it.
 */
const RETIRED_ANNOTATION = 'example.com/legacy-rollout';

function retiredBefore(objects: HelmPreviewObject[]): HelmPreviewObject | null {
  const target = objects.find((o) => o.kind === 'Deployment' && o.change === 'changed');
  if (!target?.before) return null;
  target.before = structuredClone(target.before);
  target.before.metadata.annotations = {
    ...target.before.metadata.annotations,
    [RETIRED_ANNOTATION]: 'enabled',
  };
  return target;
}

function retiredLive(result: DryRunResult): DryRunResult {
  for (const o of [result.live, result.result])
    if (o) o.metadata.annotations = { ...o.metadata.annotations, [RETIRED_ANNOTATION]: 'enabled' };
  return result;
}

async function liveDryRun(
  clusterId: string,
  object: KubeObject,
  namespace: string,
): Promise<DryRunResult> {
  try {
    const [result] = (await handlers.resource_dry_run_yaml!({
      clusterId,
      yaml: YAML.stringify(object),
      mode: 'apply',
      namespace,
    })) as DryRunResult[];
    if (result) return result;
    throw new Error('the dry run returned nothing');
  } catch (e) {
    return {
      api_version: object.apiVersion,
      kind: object.kind,
      name: object.metadata.name,
      namespace,
      operation: 'create',
      live: null,
      result: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

register({
  helm_chart_values_schema: async ({ chartRef }: MockArgs): Promise<JsonSchema | null> => {
    await sleep(500);
    const chart = chartFor(String(chartRef));
    if (!chart) throw new Error(`helm pull failed: chart "${chartRef}" not found`);
    return demoValuesSchema(chart);
  },
  helm_release_values_schema: async ({
    clusterId,
    namespace,
    name,
  }: MockArgs): Promise<JsonSchema | null> => {
    await sleep(120);
    const rec = getDb(clusterId).helm.get(helmKey(namespace, name));
    if (!rec) throw new Error(`helm release ${name} not found in namespace ${namespace}`);
    const latest = rec.history[rec.history.length - 1]!;
    const chart = CHARTS.find((c) => c.chart === latest.chart);
    return chart ? demoValuesSchema(chart) : null;
  },
  helm_upgrade_preview: async ({
    clusterId,
    namespace,
    name,
    request,
    live,
  }: MockArgs): Promise<HelmUpgradePreview> => {
    const detail = (await handlers.helm_release_detail!({
      clusterId,
      namespace,
      name,
    })) as HelmReleaseDetail;
    const result = (await handlers.helm_upgrade!({
      clusterId,
      namespace,
      name,
      request: { ...(request as HelmUpgradeRequest), dry_run: true },
    })) as HelmInstallResult;
    const objects = diffManifests(detail.manifest, result.manifest, namespace);
    const retired = retiredBefore(objects);
    if (live) {
      await sleep(400);
      for (const o of objects) {
        if (!o.after) continue;
        const dryRun = await liveDryRun(clusterId, o.after, namespace);
        o.live = o === retired ? retiredLive(dryRun) : dryRun;
        if (o.change === 'changed' && o.before && o.live.live)
          o.dropped_fields = droppedPaths(o.before, o.after, o.live.live);
      }
    }
    return {
      result,
      current_revision: detail.release.revision,
      objects,
      live_checked: !!live,
      live_truncated: false,
    };
  },
});
