import { put, type ClusterDb } from './db';
import { GATEWAY_CRDS } from './gateway';
import { gitopsCrds } from './gitops';
import { buildInstances } from './instances';
import { trivyCrds } from './trivy';
import { DAY, meta, obj } from './util';

/** A few popular CRDs (cert-manager, Argo CD, Prometheus Operator). */

interface Column {
  name: string;
  type: string;
  jsonPath: string;
  priority?: number;
  description?: string;
}

export interface CrdInput {
  group: string;
  kind: string;
  plural: string;
  singular: string;
  shortNames?: string[];
  scope: 'Namespaced' | 'Cluster';
  versions: string[];
  columns?: Column[];
  categories?: string[];
  age: number;
}

const readyCol = (priority?: number): Column => ({
  name: 'Ready',
  type: 'string',
  jsonPath: '.status.conditions[?(@.type=="Ready")].status',
  ...(priority ? { priority } : {}),
});
const ageCol: Column = { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' };

export const CRDS: CrdInput[] = [
  {
    group: 'cert-manager.io',
    kind: 'Certificate',
    plural: 'certificates',
    singular: 'certificate',
    shortNames: ['cert', 'certs'],
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['cert-manager'],
    columns: [
      readyCol(),
      { name: 'Secret', type: 'string', jsonPath: '.spec.secretName' },
      { name: 'Issuer', type: 'string', jsonPath: '.spec.issuerRef.name', priority: 1 },
      {
        name: 'Status',
        type: 'string',
        jsonPath: '.status.conditions[?(@.type=="Ready")].message',
        priority: 1,
      },
      ageCol,
    ],
    age: 150 * DAY,
  },
  {
    group: 'cert-manager.io',
    kind: 'Issuer',
    plural: 'issuers',
    singular: 'issuer',
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['cert-manager'],
    columns: [
      readyCol(),
      {
        name: 'Status',
        type: 'string',
        jsonPath: '.status.conditions[?(@.type=="Ready")].message',
        priority: 1,
      },
      ageCol,
    ],
    age: 150 * DAY,
  },
  {
    group: 'cert-manager.io',
    kind: 'ClusterIssuer',
    plural: 'clusterissuers',
    singular: 'clusterissuer',
    shortNames: ['ciss'],
    scope: 'Cluster',
    versions: ['v1'],
    categories: ['cert-manager'],
    columns: [
      readyCol(),
      {
        name: 'Status',
        type: 'string',
        jsonPath: '.status.conditions[?(@.type=="Ready")].message',
        priority: 1,
      },
      ageCol,
    ],
    age: 150 * DAY,
  },
  {
    group: 'argoproj.io',
    kind: 'Application',
    plural: 'applications',
    singular: 'application',
    shortNames: ['app', 'apps'],
    scope: 'Namespaced',
    versions: ['v1alpha1'],
    columns: [
      { name: 'Sync Status', type: 'string', jsonPath: '.status.sync.status' },
      { name: 'Health Status', type: 'string', jsonPath: '.status.health.status' },
      { name: 'Revision', type: 'string', jsonPath: '.status.sync.revision', priority: 10 },
      { name: 'Project', type: 'string', jsonPath: '.spec.project', priority: 10 },
    ],
    age: 100 * DAY,
  },
  {
    group: 'argoproj.io',
    kind: 'AppProject',
    plural: 'appprojects',
    singular: 'appproject',
    shortNames: ['appproj'],
    scope: 'Namespaced',
    versions: ['v1alpha1'],
    age: 100 * DAY,
  },
  {
    group: 'monitoring.coreos.com',
    kind: 'ServiceMonitor',
    plural: 'servicemonitors',
    singular: 'servicemonitor',
    shortNames: ['smon'],
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['prometheus-operator'],
    age: 120 * DAY,
  },
  {
    group: 'monitoring.coreos.com',
    kind: 'PrometheusRule',
    plural: 'prometheusrules',
    singular: 'prometheusrule',
    shortNames: ['promrule'],
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['prometheus-operator'],
    age: 120 * DAY,
  },
  ...GATEWAY_CRDS,
];

export function crdsFor(db: ClusterDb) {
  // GitOps: ApplicationSet and the Flux CRDs (./gitops.ts).
  return [...CRDS, ...gitopsCrds(db), ...trivyCrds(db)].filter(
    (c) => db.profile.argocd || c.group !== 'argoproj.io',
  );
}

export function buildCrds(db: ClusterDb) {
  for (const c of crdsFor(db)) {
    put(
      db,
      obj(
        'apiextensions.k8s.io/v1',
        'CustomResourceDefinition',
        meta({
          name: `${c.plural}.${c.group}`,
          age: c.age,
          labels: { 'app.kubernetes.io/name': c.group.split('.')[0]! },
          annotations: { 'controller-gen.kubebuilder.io/version': 'v0.16.5' },
        }),
        {
          spec: {
            group: c.group,
            names: {
              kind: c.kind,
              listKind: `${c.kind}List`,
              plural: c.plural,
              singular: c.singular,
              ...(c.shortNames ? { shortNames: c.shortNames } : {}),
              ...(c.categories ? { categories: c.categories } : {}),
            },
            scope: c.scope,
            conversion: { strategy: 'None' },
            versions: c.versions.map((name, i) => ({
              name,
              served: true,
              storage: i === c.versions.length - 1,
              subresources: { status: {} },
              ...(c.columns ? { additionalPrinterColumns: c.columns } : {}),
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    apiVersion: { type: 'string' },
                    kind: { type: 'string' },
                    metadata: { type: 'object' },
                    spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                    status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                  },
                },
              },
            })),
          },
          status: {
            acceptedNames: {
              kind: c.kind,
              plural: c.plural,
              singular: c.singular,
              listKind: `${c.kind}List`,
            },
            conditions: [
              {
                type: 'NamesAccepted',
                status: 'True',
                reason: 'NoConflicts',
                message: 'no conflicts found',
                lastTransitionTime: new Date(Date.now() - c.age).toISOString(),
              },
              {
                type: 'Established',
                status: 'True',
                reason: 'InitialNamesAccepted',
                message: 'the initial names have been accepted',
                lastTransitionTime: new Date(Date.now() - c.age).toISOString(),
              },
            ],
            storedVersions: [c.versions[c.versions.length - 1]],
          },
        },
      ),
    );
  }
  buildInstances(db);
}
