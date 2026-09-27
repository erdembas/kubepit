import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, field, isObject, spec, status } from '../accessors';
import { phaseTone } from '../workloads';
import { Chips, Dash, Mono, Muted, RefLink, standard, Tone } from './cells';
import type { KindColumns } from './types';
import { memoryBytes } from '../quantity';

const phase = (o: KubeObject) =>
  o.metadata.deletionTimestamp ? 'Terminating' : asString(status(o).phase) || 'Unknown';

export const pvcColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'storageClass',
      label: () => i18n.t('Storage Class'),
      width: 'minmax(110px, 1fr)',
      cell: (o, ctx) => {
        const sc = asString(spec(o).storageClassName);
        return sc ? (
          <RefLink
            target={{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', name: sc }}
            ctx={ctx}
          />
        ) : (
          <Dash />
        );
      },
      sort: (o) => asString(spec(o).storageClassName),
    },
    {
      id: 'size',
      label: () => i18n.t('Size'),
      width: '76px',
      align: 'right',
      cell: (o) => (
        <Muted>
          {asString(asObject(status(o).capacity).storage) ||
            asString(asObject(asObject(spec(o).resources).requests).storage)}
        </Muted>
      ),
      sort: (o) => memoryBytes(asObject(asObject(spec(o).resources).requests).storage),
    },
    {
      id: 'volume',
      label: () => i18n.t('Volume'),
      width: 'minmax(140px, 1.4fr)',
      defaultHidden: true,
      cell: (o, ctx) => {
        const v = asString(spec(o).volumeName);
        return v ? (
          <RefLink target={{ apiVersion: 'v1', kind: 'PersistentVolume', name: v }} ctx={ctx} />
        ) : (
          <Dash />
        );
      },
    },
    {
      id: 'access',
      label: () => i18n.t('Access Modes'),
      width: 'minmax(100px, 1fr)',
      defaultHidden: true,
      cell: (o) => (
        <Muted>
          {asArray(spec(o).accessModes)
            .map((x) => asString(x))
            .join(', ')}
        </Muted>
      ),
    },
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: '96px',
      cell: (o) => <Tone tone={phaseTone(phase(o))}>{phase(o)}</Tone>,
      sort: phase,
    },
  ]),
};

export const pvColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'storageClass',
      label: () => i18n.t('Storage Class'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => <Muted>{asString(spec(o).storageClassName) || '—'}</Muted>,
      sort: (o) => asString(spec(o).storageClassName),
    },
    {
      id: 'capacity',
      label: () => i18n.t('Capacity'),
      width: '84px',
      align: 'right',
      cell: (o) => <Muted>{asString(asObject(spec(o).capacity).storage)}</Muted>,
      sort: (o) => memoryBytes(asObject(spec(o).capacity).storage),
    },
    {
      id: 'claim',
      label: () => i18n.t('Claim'),
      width: 'minmax(160px, 1.6fr)',
      cell: (o, ctx) => {
        const ref = asObject(spec(o).claimRef);
        return asString(ref.name) ? (
          <RefLink
            target={{
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              name: asString(ref.name),
              namespace: asString(ref.namespace),
            }}
            ctx={ctx}
            label={`${asString(ref.namespace)}/${asString(ref.name)}`}
          />
        ) : (
          <Dash />
        );
      },
    },
    {
      id: 'reclaim',
      label: () => i18n.t('Reclaim Policy'),
      width: '104px',
      defaultHidden: true,
      cell: (o) => <Muted>{asString(spec(o).persistentVolumeReclaimPolicy)}</Muted>,
    },
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: '96px',
      cell: (o) => <Tone tone={phaseTone(phase(o))}>{phase(o)}</Tone>,
      sort: phase,
    },
  ]),
};

export const storageClassColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'provisioner',
      label: () => i18n.t('Provisioner'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => <Mono>{asString(field(o, 'provisioner'))}</Mono>,
      sort: (o) => asString(field(o, 'provisioner')),
    },
    {
      id: 'reclaim',
      label: () => i18n.t('Reclaim Policy'),
      width: '110px',
      cell: (o) => <Muted>{asString(field(o, 'reclaimPolicy')) || 'Delete'}</Muted>,
    },
    {
      id: 'binding',
      label: () => i18n.t('Binding Mode'),
      width: 'minmax(130px, 1fr)',
      defaultHidden: true,
      cell: (o) => <Muted>{asString(field(o, 'volumeBindingMode'))}</Muted>,
    },
    {
      id: 'default',
      label: () => i18n.t('Default'),
      width: '76px',
      cell: (o) =>
        o.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? (
          <Tone tone="success">{i18n.t('Yes')}</Tone>
        ) : (
          <Dash />
        ),
    },
  ]),
};

export function bindingSubjects(o: KubeObject): string[] {
  return asArray(field(o, 'subjects'))
    .filter(isObject)
    .map(
      (s) =>
        `${asString(s.kind)}:${s.namespace ? `${asString(s.namespace)}/` : ''}${asString(s.name)}`,
    );
}

export const serviceAccountColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'secrets',
      label: () => i18n.t('Secrets'),
      width: '76px',
      align: 'right',
      defaultHidden: true,
      cell: (o) => <Muted>{asArray(field(o, 'secrets')).length}</Muted>,
    },
    {
      id: 'role',
      label: () => i18n.t('IAM Role'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => {
        const arn =
          o.metadata.annotations?.['eks.amazonaws.com/role-arn'] ??
          o.metadata.annotations?.['iam.gke.io/gcp-service-account'];
        return arn ? <Mono title={arn}>{arn}</Mono> : <Dash />;
      },
    },
  ]),
};

export const roleColumns = (namespaced: boolean): KindColumns => ({
  columns: standard(namespaced, [
    {
      id: 'rules',
      label: () => i18n.t('Rules'),
      width: '72px',
      align: 'right',
      cell: (o) => <Muted>{asArray(field(o, 'rules')).length}</Muted>,
      sort: (o) => asArray(field(o, 'rules')).length,
    },
  ]),
});

export const bindingColumns = (namespaced: boolean): KindColumns => ({
  searchText: (o) =>
    `${bindingSubjects(o).join(' ')} ${asString(asObject(field(o, 'roleRef')).name)}`,
  columns: standard(namespaced, [
    {
      id: 'role',
      label: () => i18n.t('Role'),
      width: 'minmax(150px, 1.5fr)',
      cell: (o, ctx) => {
        const r = asObject(field(o, 'roleRef'));
        return (
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="text-fg-dim shrink-0 text-[10.5px]">{asString(r.kind)}</span>
            <RefLink
              target={{
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: asString(r.kind),
                name: asString(r.name),
                namespace: asString(r.kind) === 'Role' ? (o.metadata.namespace ?? null) : null,
              }}
              ctx={ctx}
            />
          </span>
        );
      },
      sort: (o) => asString(asObject(field(o, 'roleRef')).name),
    },
    {
      id: 'subjects',
      label: () => i18n.t('Subjects'),
      width: 'minmax(200px, 2.5fr)',
      cell: (o) => <Chips values={bindingSubjects(o)} />,
    },
  ]),
});
