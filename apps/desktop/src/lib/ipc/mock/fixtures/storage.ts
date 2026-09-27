import type { KubeObject } from '@/types';
import { list, put, type ClusterDb } from './db';
import { DAY, hexId, meta, obj } from './util';

/** PVCs for StatefulSets and standalone claims, backing PVs and a Released volume. */

function defaultClass(db: ClusterDb) {
  return (
    list(db, 'storageclasses.storage.k8s.io').find(
      (sc) => sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
    )?.metadata.name ?? 'standard'
  );
}

function provisioner(db: ClusterDb, className: string) {
  return String(
    list(db, 'storageclasses.storage.k8s.io').find((sc) => sc.metadata.name === className)
      ?.provisioner ?? 'kubernetes.io/no-provisioner',
  );
}

function claim(
  db: ClusterDb,
  namespace: string,
  name: string,
  size: string,
  age: number,
  labels: Record<string, string>,
  opts: { className?: string; pending?: boolean; node?: string } = {},
) {
  const className = opts.className ?? defaultClass(db);
  const pvc = put(
    db,
    obj(
      'v1',
      'PersistentVolumeClaim',
      meta({
        name,
        namespace,
        age,
        labels,
        annotations: opts.pending
          ? { 'volume.kubernetes.io/storage-provisioner': 'fast-ssd.csi.example.com' }
          : {
              'pv.kubernetes.io/bind-completed': 'yes',
              'pv.kubernetes.io/bound-by-controller': 'yes',
              'volume.beta.kubernetes.io/storage-provisioner': provisioner(db, className),
              ...(opts.node ? { 'volume.kubernetes.io/selected-node': opts.node } : {}),
            },
        finalizers: ['kubernetes.io/pvc-protection'],
      }),
      {
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: size } },
          storageClassName: className,
          volumeMode: 'Filesystem',
        },
        status: opts.pending
          ? { phase: 'Pending' }
          : { phase: 'Bound', accessModes: ['ReadWriteOnce'], capacity: { storage: size } },
      },
    ),
  );
  if (opts.pending) return pvc;
  const pvName = `pvc-${pvc.metadata.uid}`;
  pvc.spec.volumeName = pvName;
  put(db, pvc);
  put(db, volume(db, pvName, size, className, age, 'Bound', pvc));
  return pvc;
}

function volume(
  db: ClusterDb,
  name: string,
  size: string,
  className: string,
  age: number,
  phase: string,
  pvc: KubeObject | null,
) {
  const prov = provisioner(db, className);
  const zone = db.profile.zones[0];
  return obj(
    'v1',
    'PersistentVolume',
    meta({
      name,
      age,
      annotations: {
        'pv.kubernetes.io/provisioned-by': prov,
        'volume.kubernetes.io/provisioner-deletion-secret-name': '',
      },
      finalizers: [
        'kubernetes.io/pv-protection',
        ...(prov.includes('csi') ? ['external-attacher/ebs-csi-aws-com'] : []),
      ],
    }),
    {
      spec: {
        accessModes: ['ReadWriteOnce'],
        capacity: { storage: size },
        ...(pvc
          ? {
              claimRef: {
                apiVersion: 'v1',
                kind: 'PersistentVolumeClaim',
                name: pvc.metadata.name,
                namespace: pvc.metadata.namespace,
                uid: pvc.metadata.uid,
                resourceVersion: pvc.metadata.resourceVersion,
              },
            }
          : {}),
        persistentVolumeReclaimPolicy: phase === 'Released' ? 'Retain' : 'Delete',
        storageClassName: className,
        volumeMode: 'Filesystem',
        ...(prov === 'rancher.io/local-path'
          ? { hostPath: { path: `/var/local-path-provisioner/${name}`, type: 'DirectoryOrCreate' } }
          : {
              csi: {
                driver: prov,
                fsType: 'ext4',
                volumeHandle:
                  db.profile.platform === 'EKS'
                    ? `vol-0${hexId(db.rand, 16)}`
                    : `projects/acme/zones/${zone}/disks/${name}`,
              },
            }),
        ...(zone
          ? {
              nodeAffinity: {
                required: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        { key: 'topology.kubernetes.io/zone', operator: 'In', values: [zone] },
                      ],
                    },
                  ],
                },
              },
            }
          : {}),
      },
      status: { phase, lastPhaseTransitionTime: new Date(Date.now() - age + 60_000).toISOString() },
    },
  );
}

export function buildStorage(db: ClusterDb) {
  for (const sts of list(db, 'statefulsets.apps')) {
    const tmpl = (
      sts.spec?.volumeClaimTemplates as
        | Array<{
            metadata: { name: string };
            spec: { resources: { requests: { storage: string } }; storageClassName?: string };
          }>
        | undefined
    )?.[0];
    if (!tmpl) continue;
    const replicas = Number(sts.spec?.replicas ?? 1);
    for (let i = 0; i < replicas; i++) {
      const pod = list(db, 'pods').find(
        (p) =>
          p.metadata.name === `${sts.metadata.name}-${i}` &&
          p.metadata.namespace === sts.metadata.namespace,
      );
      claim(
        db,
        sts.metadata.namespace!,
        `${tmpl.metadata.name}-${sts.metadata.name}-${i}`,
        tmpl.spec.resources.requests.storage,
        Date.now() - Date.parse(sts.metadata.creationTimestamp!),
        { app: sts.metadata.name },
        {
          className: tmpl.spec.storageClassName,
          node: pod?.spec?.nodeName,
        },
      );
    }
  }
  if (db.profile.platform !== 'kind') {
    claim(db, 'monitoring', 'prometheus-server', '100Gi', 120 * DAY, { app: 'prometheus-server' });
    claim(db, 'monitoring', 'storage-loki-0', '20Gi', 45 * DAY, { app: 'loki' });
    claim(db, 'web', 'image-cache', '20Gi', 70 * DAY, { app: 'image-resizer' });
  }
  claim(db, 'monitoring', 'grafana', '10Gi', 120 * DAY, { app: 'grafana' });
  if (db.profile.troubled)
    claim(
      db,
      'data',
      'scratch-etl',
      '500Gi',
      3 * DAY,
      { app: 'etl-worker' },
      { className: 'fast-ssd', pending: true },
    );
  put(
    db,
    volume(
      db,
      `pvc-${hexId(db.rand, 8)}-${hexId(db.rand, 4)}-${hexId(db.rand, 4)}-${hexId(db.rand, 4)}-${hexId(db.rand, 12)}`,
      '50Gi',
      defaultClass(db),
      210 * DAY,
      'Released',
      null,
    ),
  );
}
