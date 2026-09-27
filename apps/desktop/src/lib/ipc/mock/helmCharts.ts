import YAML from 'yaml';
import { compareVersions, isPrerelease } from '@/lib/semver';
import type {
  ClusterDef,
  HelmChartDetail,
  HelmChartSummary,
  HelmChartVersion,
  HelmHubChart,
  HelmInstallRequest,
  HelmInstallResult,
  HelmRelease,
  HelmRepo,
  HelmRepoAddOptions,
  HelmRepoUpdateResult,
  HelmRevisionDetail,
  HelmSearchOptions,
  HelmUpgradeRequest,
} from '@/types';
import { sleep } from './bus';
import {
  CHARTS,
  INITIAL_REPOS,
  KNOWN_REPOS,
  chartDef,
  defaultValues,
  readme,
  renderManifest,
  renderNotes,
  valuesYaml,
  type ChartDef,
} from './fixtures/charts';
import { getDb, helmKey, list, type ClusterDb, type HelmRecord } from './fixtures/db';
import { syncHelmSecrets } from './fixtures/helm';
import { applyYaml } from './fixtures/ops';
import { mergePatch, nowIso } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo Helm charts backend: the user's repositories (bitnami,
 * prometheus-community, ingress-nginx, jetstack, grafana), a chart catalog
 * with version series, READMEs and values, Artifact Hub search, and
 * install / upgrade that mutate the demo releases and create their objects.
 */

let repos: HelmRepo[] = KNOWN_REPOS.filter((r) => INITIAL_REPOS.includes(r.name)).map(
  ({ name, url }) => ({ name, url }),
);

const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

function assertWritable(clusterId: string) {
  const clusters = (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
  const cluster = clusters.find((c) => c.id === clusterId);
  if (cluster?.read_only)
    throw new Error(
      `Cluster "${cluster.name}" is read-only in Kubepit; mutating commands are blocked.`,
    );
}

/** Charts served by a configured repository (matched by URL, so aliases work). */
function repoCharts(repo: HelmRepo): ChartDef[] {
  const known = KNOWN_REPOS.find((k) => trimSlash(k.url) === trimSlash(repo.url));
  return known ? CHARTS.filter((c) => c.repo === known.name) : [];
}

function resolve(chartRef: string): { alias: string; chart: ChartDef } {
  const oci = /^oci:\/\/registry-1\.docker\.io\/bitnamicharts\/([a-z0-9-]+)$/.exec(chartRef);
  if (oci) {
    const chart = chartDef('bitnami', oci[1]!);
    if (chart) return { alias: 'oci', chart };
  }
  if (chartRef.startsWith('oci://'))
    throw new Error(
      `failed to perform "FetchReference" on source: ${chartRef.slice(6)}: not found`,
    );
  const [alias = '', name = ''] = chartRef.split('/');
  const repo = repos.find((r) => r.name === alias);
  if (!repo) throw new Error(`repo ${alias} not found`);
  const chart = repoCharts(repo).find((c) => c.chart === name);
  if (!chart)
    throw new Error(
      `chart "${name}" not found in ${alias} index. (try 'helm repo update'): no chart name found`,
    );
  return { alias, chart };
}

function newestStable(chart: ChartDef): [string, string] {
  const sorted = [...chart.versions].sort((a, b) => compareVersions(b[0], a[0]));
  return sorted.find(([v]) => !isPrerelease(v)) ?? sorted[0]!;
}

function pickVersion(chart: ChartDef, version: string | null): [string, string] {
  if (!version) return newestStable(chart);
  const hit = chart.versions.find(([v]) => v === version);
  if (!hit)
    throw new Error(
      `chart "${chart.chart}" matching ${version} not found in ${chart.repo} index. (try 'helm repo update'): no chart version found for ${chart.chart}-${version}`,
    );
  return hit;
}

function parseValues(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    throw new Error(`failed to parse values: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('values must be a YAML mapping');
  return parsed as Record<string, unknown>;
}

const toYaml = (value: Record<string, unknown>) =>
  Object.keys(value).length ? YAML.stringify(value, { lineWidth: 0 }) : '';

// -- Per-revision data --------------------------------------------------------

interface RevisionData {
  manifest: string;
  notes: string;
  values: string;
  computed: string;
}

/** What demo installs/upgrades stored for each revision. */
const revisions = new WeakMap<HelmRecord, Map<number, RevisionData>>();
/** Newest fixture revision, captured on first sight (older ones are synthesised). */
const fixtureTop = new WeakMap<HelmRecord, number>();

function topOf(rec: HelmRecord) {
  if (!fixtureTop.has(rec)) fixtureTop.set(rec, rec.history[rec.history.length - 1]!.revision);
  return fixtureTop.get(rec)!;
}

/** Older fixture revisions ran with fewer replicas and without some extras. */
function agedValues(values: string, stepsBack: number): string {
  if (stepsBack <= 0 || !values.trim()) return values;
  const data = parseValues(values);
  const walk = (node: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(node)) {
      if (/replica/i.test(key) && typeof value === 'number' && value > 1)
        node[key] = Math.max(1, value - stepsBack);
      else if (stepsBack >= 2 && depth > 0 && /^(metrics|autoscaling|prometheus)$/.test(key))
        delete node[key];
      else if (value && typeof value === 'object' && !Array.isArray(value))
        walk(value as Record<string, unknown>, depth + 1);
    }
  };
  walk(data, 0);
  return toYaml(data);
}

/** Re-label a manifest for another chart version (fixture history). */
function retag(manifest: string, rel: HelmRelease): string {
  return YAML.parseAllDocuments(manifest)
    .map((doc) => {
      const o = doc.toJSON() as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!o?.metadata) return '';
      o.metadata.labels = {
        ...o.metadata.labels,
        'helm.sh/chart': `${rel.chart}-${rel.chart_version}`,
        ...(rel.app_version ? { 'app.kubernetes.io/version': rel.app_version } : {}),
      };
      const container = o.spec?.template?.spec?.containers?.[0];
      if (container?.image && rel.app_version) {
        // `repo:tag[@sha256:…]` → the revision's tag (a digest pins the old image, so drop it).
        const app = rel.app_version.replace(/^v/, '');
        container.image = String(container.image)
          .replace(/@sha256:[a-f0-9]+$/, '')
          .replace(/:([^:/]+)$/, (_: string, tag: string) =>
            tag.startsWith('v') ? `:v${app}` : `:${app}`,
          );
      }
      const comment =
        doc.commentBefore ??
        (doc.contents as { commentBefore?: string | null } | null)?.commentBefore;
      const head = comment ? `#${comment.replace(/\n/g, '\n#')}\n` : '';
      return `---\n${head}${YAML.stringify(o, { lineWidth: 0 })}`;
    })
    .join('');
}

function revisionData(rec: HelmRecord, revision: number): RevisionData {
  const stored = revisions.get(rec)?.get(revision);
  if (stored) return stored;
  const index = rec.history.findIndex((r) => r.revision === revision);
  if (index < 0) throw new Error(`release: not found`);
  const rel = rec.history[index]!;
  const latest = rec.history[rec.history.length - 1]!;
  const top = topOf(rec);
  const values = agedValues(rec.values[index] ?? '', revision <= top ? top - revision : 0);
  const computed =
    revision === latest.revision
      ? rec.computed
      : toYaml(
          mergePatch(parseValues(rec.computed), parseValues(values)) as Record<string, unknown>,
        );
  return {
    manifest: revision === latest.revision ? rec.manifest : retag(rec.manifest, rel),
    notes: rec.notes,
    values,
    computed,
  };
}

function store(rec: HelmRecord, revision: number, data: RevisionData) {
  const map = revisions.get(rec) ?? new Map<number, RevisionData>();
  map.set(revision, data);
  revisions.set(rec, map);
}

function deployObjects(db: ClusterDb, manifest: string, namespace: string) {
  try {
    applyYaml(db, manifest, 'apply', namespace);
  } catch {
    /* The demo cluster may not serve every kind; the release still records it. */
  }
}

function failIfTimedOut(
  request: { wait: boolean; atomic: boolean; timeout_secs: number | null },
  name: string,
) {
  if (!(request.wait || request.atomic) || !request.timeout_secs || request.timeout_secs >= 30)
    return;
  throw new Error(
    request.atomic
      ? `release ${name} failed, and has been uninstalled due to atomic being set: context deadline exceeded`
      : `release ${name} failed: context deadline exceeded`,
  );
}

// -- Handlers -------------------------------------------------------------------

register({
  helm_repo_list: async () => {
    await sleep(60);
    return structuredClone(repos);
  },
  helm_repo_add: async ({ name, url, options }: MockArgs) => {
    const opts = options as HelmRepoAddOptions;
    const repoName = String(name).trim();
    const repoUrl = trimSlash(String(url));
    await sleep(700);
    if (!repoName || /[\s/]/.test(repoName))
      throw new Error(
        `repository name (${repoName}) contains '/', please specify a different name without '/'`,
      );
    const existing = repos.find((r) => r.name === repoName);
    if (existing && !opts.force_update) {
      if (trimSlash(existing.url) === repoUrl) return;
      throw new Error(
        `repository name (${repoName}) already exists, please specify a different name`,
      );
    }
    const known = KNOWN_REPOS.find((k) => trimSlash(k.url) === repoUrl);
    if (!known)
      throw new Error(
        `looks like "${repoUrl}" is not a valid chart repository or cannot be reached: failed to fetch ${repoUrl}/index.yaml : 404 Not Found`,
      );
    if (known.auth && !(opts.username && opts.password))
      throw new Error(
        `looks like "${repoUrl}" is not a valid chart repository or cannot be reached: failed to fetch ${repoUrl}/index.yaml : 401 Unauthorized`,
      );
    const next = { name: repoName, url: repoUrl };
    repos = existing ? repos.map((r) => (r.name === repoName ? next : r)) : [...repos, next];
  },
  helm_repo_remove: async ({ name }: MockArgs) => {
    await sleep(120);
    if (!repos.some((r) => r.name === name)) throw new Error(`no repo named "${name}" found`);
    repos = repos.filter((r) => r.name !== name);
  },
  helm_repo_update: async ({ names }: MockArgs): Promise<HelmRepoUpdateResult[]> => {
    const wanted = (names as string[]) ?? [];
    for (const n of wanted)
      if (!repos.some((r) => r.name === n))
        throw new Error(`helm repository "${n}" is not configured`);
    await sleep(1400);
    return (wanted.length ? wanted : repos.map((r) => r.name)).map((name) => ({
      name,
      ok: true,
      error: null,
    }));
  },
  helm_chart_search: async ({ query, options }: MockArgs): Promise<HelmChartSummary[]> => {
    const { versions, devel } = options as HelmSearchOptions;
    const q = String(query ?? '')
      .trim()
      .toLowerCase();
    await sleep(180);
    const out: HelmChartSummary[] = [];
    for (const repo of repos)
      for (const c of repoCharts(repo)) {
        const name = `${repo.name}/${c.chart}`;
        if (q && !`${name} ${c.description} ${c.keywords.join(' ')}`.toLowerCase().includes(q))
          continue;
        const list = [...c.versions]
          .filter(([v]) => devel || !isPrerelease(v))
          .sort((a, b) => compareVersions(b[0], a[0]));
        for (const [version, app] of versions ? list : list.slice(0, 1))
          out.push({
            name,
            repo: repo.name,
            chart: c.chart,
            version,
            app_version: app,
            description: c.description,
            deprecated: !!c.deprecated,
          });
      }
    return out;
  },
  helm_chart_versions: async ({ chartRef }: MockArgs): Promise<HelmChartVersion[]> => {
    await sleep(120);
    let chart: ChartDef;
    try {
      chart = resolve(String(chartRef)).chart;
    } catch {
      return [];
    }
    if (String(chartRef).startsWith('oci://')) {
      const [version, app] = newestStable(chart);
      return [{ version, app_version: app }];
    }
    return [...chart.versions]
      .sort((a, b) => compareVersions(b[0], a[0]))
      .map(([version, app]) => ({ version, app_version: app }));
  },
  helm_hub_search: async ({ query }: MockArgs): Promise<HelmHubChart[]> => {
    const q = String(query ?? '')
      .trim()
      .toLowerCase();
    if (!q) throw new Error('enter a search term');
    await sleep(900);
    return CHARTS.filter((c) =>
      `${c.repo}/${c.chart} ${c.description} ${c.keywords.join(' ')}`.toLowerCase().includes(q),
    )
      .slice(0, 60)
      .map((c) => {
        const repo = KNOWN_REPOS.find((k) => k.name === c.repo)!;
        const [version, app] = newestStable(c);
        return {
          url: `https://artifacthub.io/packages/helm/${c.repo}/${c.chart}`,
          version,
          app_version: app,
          description: c.description,
          repository_name: repo.name,
          repository_url: repo.url,
        };
      });
  },
  helm_chart_show: async ({ chartRef, version }: MockArgs): Promise<HelmChartDetail> => {
    await sleep(420);
    const { chart } = resolve(String(chartRef));
    const [v, app] = pickVersion(chart, (version as string | null) ?? null);
    const repo = KNOWN_REPOS.find((k) => k.name === chart.repo)!;
    return {
      metadata: {
        name: chart.chart,
        version: v,
        app_version: app,
        description: chart.description,
        home: chart.home,
        icon: null,
        sources: chart.sources,
        keywords: chart.keywords,
        maintainers: chart.maintainers,
        dependencies: chart.dependencies ?? [],
        kube_version: chart.kube ?? null,
        chart_type: chart.type ?? 'application',
        deprecated: !!chart.deprecated,
      },
      readme: readme(chart, repo.url),
      values_yaml: valuesYaml(chart, v),
    };
  },
  helm_install: async ({ clusterId, request }: MockArgs): Promise<HelmInstallResult> => {
    const req = request as HelmInstallRequest;
    const name = req.release_name;
    if (!RELEASE_NAME.test(name) || name.length > 53)
      throw new Error(
        `release name "${name}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53`,
      );
    if (!req.dry_run) assertWritable(clusterId);
    const { chart } = resolve(req.chart_ref);
    const [version, app] = pickVersion(chart, req.version);
    const user = parseValues(req.values_yaml);
    const db = getDb(clusterId);
    const nsExists = list(db, 'namespaces').some((n) => n.metadata.name === req.namespace);
    await sleep(req.dry_run ? 800 : 1400 + (req.wait ? 1600 : 0));
    if (db.helm.has(helmKey(req.namespace, name)))
      throw new Error('cannot re-use a name that is still in use');
    if (!nsExists && !req.create_namespace && !req.dry_run)
      throw new Error(`create: failed to create: namespaces "${req.namespace}" not found`);
    if (!req.dry_run) failIfTimedOut(req, name);
    const computed = mergePatch(defaultValues(chart, version), user) as Record<string, unknown>;
    const manifest = renderManifest(chart, version, name, req.namespace, computed);
    const notes = renderNotes(chart, version, name, req.namespace);
    const release: HelmRelease = {
      name,
      namespace: req.namespace,
      revision: 1,
      status: req.dry_run ? 'pending-install' : 'deployed',
      chart: chart.chart,
      chart_version: version,
      app_version: app,
      updated: nowIso(),
      description: req.dry_run ? 'Dry run complete' : req.description?.trim() || 'Install complete',
    };
    const data: RevisionData = {
      manifest,
      notes,
      values: toYaml(user),
      computed: toYaml(computed),
    };
    if (!req.dry_run) {
      if (!nsExists)
        applyYaml(
          db,
          `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${req.namespace}\n`,
          'apply',
          null,
        );
      const rec: HelmRecord = {
        history: [release],
        values: [data.values],
        manifest,
        notes,
        computed: data.computed,
      };
      db.helm.set(helmKey(req.namespace, name), rec);
      store(rec, 1, data);
      syncHelmSecrets(db, req.namespace, name);
      deployObjects(db, manifest, req.namespace);
    }
    return {
      release: { ...release },
      manifest,
      notes,
      values_yaml: data.values,
      computed_values_yaml: data.computed,
    };
  },
  helm_upgrade: async ({
    clusterId,
    namespace,
    name,
    request,
  }: MockArgs): Promise<HelmInstallResult> => {
    const req = request as HelmUpgradeRequest;
    if (!req.dry_run) assertWritable(clusterId);
    const db = getDb(clusterId);
    const rec = db.helm.get(helmKey(namespace, name));
    if (!rec) throw new Error(`"${name}" has no deployed releases`);
    const { chart } = resolve(req.chart_ref);
    const [version, app] = pickVersion(chart, req.version);
    const current = rec.history[rec.history.length - 1]!;
    const previous = parseValues(revisionData(rec, current.revision).values);
    const supplied = parseValues(req.values_yaml);
    const user = req.reuse_values
      ? (mergePatch(previous, supplied) as Record<string, unknown>)
      : req.reset_values || req.values_yaml.trim()
        ? supplied
        : previous;
    await sleep(req.dry_run ? 800 : 1500 + (req.wait ? 1600 : 0));
    if (!req.dry_run) failIfTimedOut(req, name);
    const computed = mergePatch(defaultValues(chart, version), user) as Record<string, unknown>;
    const release: HelmRelease = {
      ...current,
      revision: current.revision + 1,
      status: req.dry_run ? 'pending-upgrade' : 'deployed',
      chart: chart.chart,
      chart_version: version,
      app_version: app,
      updated: nowIso(),
      description: req.dry_run ? 'Dry run complete' : 'Upgrade complete',
    };
    // Releases installed by the demo re-render; fixture releases keep their
    // objects and only move to the new chart version (labels, image tags).
    const rendered = rec.manifest.includes(`# Source: ${chart.chart}/templates/`);
    const manifest = rendered
      ? renderManifest(chart, version, name, namespace, computed)
      : retag(rec.manifest, release);
    const notes = rendered ? renderNotes(chart, version, name, namespace) : rec.notes;
    const data: RevisionData = {
      manifest,
      notes,
      values: toYaml(user),
      computed: toYaml(computed),
    };
    if (!req.dry_run) {
      topOf(rec);
      current.status = 'superseded';
      rec.history.push(release);
      rec.values.push(data.values);
      rec.manifest = manifest;
      rec.notes = notes;
      rec.computed = data.computed;
      store(rec, release.revision, data);
      syncHelmSecrets(db, namespace, name);
      if (rendered) deployObjects(db, manifest, namespace);
    }
    return {
      release: { ...release },
      manifest,
      notes,
      values_yaml: data.values,
      computed_values_yaml: data.computed,
    };
  },
  helm_release_revision: async ({
    clusterId,
    namespace,
    name,
    revision,
  }: MockArgs): Promise<HelmRevisionDetail> => {
    await sleep(120);
    const rec = getDb(clusterId).helm.get(helmKey(namespace, name));
    if (!rec) throw new Error(`release: not found`);
    const rel = rec.history.find((r) => r.revision === Number(revision));
    if (!rel)
      throw new Error(`helm release ${name} has no revision ${revision} in namespace ${namespace}`);
    const data = revisionData(rec, rel.revision);
    return {
      release: { ...rel },
      values_yaml: data.values,
      computed_values_yaml: data.computed,
      manifest: data.manifest,
      notes: data.notes,
    };
  },
});
