import * as i18n from '@/i18n';
import { asArray, asObject, asString, field, isObject, spec, status } from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { phaseTone } from '@/lib/kube/workloads';
import { ChipList, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { PodsMiniTable } from '../PodsMiniTable';
import type { SectionProps } from './types';

export function PvcSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const phase = asString(status(obj).phase) || 'Unknown';
  const ns = obj.metadata.namespace ?? null;
  return (
    <>
      <Section title={i18n.t('Claim')}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText tone={phaseTone(phase)}>{phase}</ToneText>
          </Row>
          <Row label={i18n.t('Storage class')}>
            {asString(s.storageClassName) && (
              <RefLink
                target={{
                  apiVersion: 'storage.k8s.io/v1',
                  kind: 'StorageClass',
                  name: asString(s.storageClassName),
                }}
                ctx={ctx}
              />
            )}
          </Row>
          <Row label={i18n.t('Requested')}>
            {asString(asObject(asObject(s.resources).requests).storage)}
          </Row>
          <Row label={i18n.t('Capacity')}>{asString(asObject(status(obj).capacity).storage)}</Row>
          <Row label={i18n.t('Access modes')}>
            {asArray(s.accessModes)
              .map((x) => asString(x))
              .join(', ')}
          </Row>
          <Row label={i18n.t('Volume mode')}>{asString(s.volumeMode)}</Row>
          <Row label={i18n.t('Volume')}>
            {asString(s.volumeName) && (
              <RefLink
                target={{
                  apiVersion: 'v1',
                  kind: 'PersistentVolume',
                  name: asString(s.volumeName),
                }}
                ctx={ctx}
              />
            )}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Mounted by')}>
        <PodsMiniTable
          ctx={ctx}
          namespace={ns}
          isActive={isActive}
          match={(p) =>
            asArray(p.spec?.volumes).some(
              (v) =>
                isObject(v) &&
                asString(asObject(v.persistentVolumeClaim).claimName) === obj.metadata.name,
            )
          }
        />
      </Section>
    </>
  );
}

function volumeSource(s: Record<string, unknown>): [string, string] | null {
  for (const key of [
    'csi',
    'hostPath',
    'nfs',
    'awsElasticBlockStore',
    'gcePersistentDisk',
    'azureDisk',
    'local',
  ]) {
    const v = asObject(s[key]);
    if (!Object.keys(v).length) continue;
    return [
      key,
      asString(v.volumeHandle) ||
        asString(v.path) ||
        asString(v.volumeID) ||
        asString(v.pdName) ||
        asString(v.diskName) ||
        asString(v.server),
    ];
  }
  return null;
}

export function PvSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const claim = asObject(s.claimRef);
  const phase = asString(status(obj).phase) || 'Unknown';
  const source = volumeSource(s);
  return (
    <Section title={i18n.t('Volume')}>
      <Rows>
        <Row label={i18n.t('Status')}>
          <ToneText tone={phaseTone(phase)}>{phase}</ToneText>
        </Row>
        <Row label={i18n.t('Capacity')}>{asString(asObject(s.capacity).storage)}</Row>
        <Row label={i18n.t('Claim')}>
          {asString(claim.name) && (
            <RefLink
              target={{
                apiVersion: 'v1',
                kind: 'PersistentVolumeClaim',
                name: asString(claim.name),
                namespace: asString(claim.namespace),
              }}
              ctx={ctx}
              label={`${asString(claim.namespace)}/${asString(claim.name)}`}
            />
          )}
        </Row>
        <Row label={i18n.t('Storage class')}>
          {asString(s.storageClassName) && (
            <RefLink
              target={{
                apiVersion: 'storage.k8s.io/v1',
                kind: 'StorageClass',
                name: asString(s.storageClassName),
              }}
              ctx={ctx}
            />
          )}
        </Row>
        <Row label={i18n.t('Reclaim policy')}>{asString(s.persistentVolumeReclaimPolicy)}</Row>
        <Row label={i18n.t('Access modes')}>
          {asArray(s.accessModes)
            .map((x) => asString(x))
            .join(', ')}
        </Row>
        <Row label={i18n.t('Source')}>
          {source && (
            <span>
              <span className="text-fg-dim mr-1.5 text-[11px]">{source[0]}</span>
              <MonoText>{source[1]}</MonoText>
            </span>
          )}
        </Row>
      </Rows>
    </Section>
  );
}

export function StorageClassSections({ obj }: SectionProps) {
  i18n.useLocale();
  const params = asObject(field(obj, 'parameters'));
  return (
    <Section title={i18n.t('Storage class')}>
      <Rows>
        <Row label={i18n.t('Provisioner')}>
          <MonoText>{asString(field(obj, 'provisioner'))}</MonoText>
        </Row>
        <Row label={i18n.t('Default')}>
          {obj.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
            ? i18n.t('Yes')
            : i18n.t('No')}
        </Row>
        <Row label={i18n.t('Reclaim policy')}>
          {asString(field(obj, 'reclaimPolicy')) || 'Delete'}
        </Row>
        <Row label={i18n.t('Binding mode')}>{asString(field(obj, 'volumeBindingMode'))}</Row>
        <Row label={i18n.t('Volume expansion')}>
          {field(obj, 'allowVolumeExpansion') === true ? i18n.t('Allowed') : i18n.t('Not allowed')}
        </Row>
        <Row label={i18n.t('Parameters')}>
          {Object.keys(params).length > 0 && (
            <ChipList
              entries={Object.entries(params).map(([k, v]) => [k, asString(v)] as [string, string])}
            />
          )}
        </Row>
      </Rows>
    </Section>
  );
}
