import * as i18n from '@/i18n';
import { asArray, asObject, asString, field, isObject } from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { ChipList, MiniTable, MonoText, Row, Rows, Section } from '../primitives';
import type { SectionProps } from './types';

const list = (v: unknown) => asArray(v).map((x) => asString(x));

export function RoleSections({ obj }: SectionProps) {
  i18n.useLocale();
  const rules = asArray(field(obj, 'rules')).filter(isObject);
  const aggregation = asObject(field(obj, 'aggregationRule'));
  return (
    <>
      <Section title={i18n.t('Rules')}>
        <MiniTable
          rows={rules}
          rowKey={(_, i) => String(i)}
          empty={i18n.t('No rules')}
          columns={[
            {
              label: i18n.t('API groups'),
              cell: (r) => (
                <MonoText>
                  {list(r.apiGroups)
                    .map((g) => g || '""')
                    .join(', ') || '—'}
                </MonoText>
              ),
            },
            {
              label: i18n.t('Resources'),
              cell: (r) => (
                <MonoText>
                  {[...list(r.resources), ...list(r.nonResourceURLs)].join(', ') || '—'}
                </MonoText>
              ),
            },
            {
              label: i18n.t('Names'),
              cell: (r) => <MonoText>{list(r.resourceNames).join(', ') || '*'}</MonoText>,
            },
            {
              label: i18n.t('Verbs'),
              cell: (r) => <span className="text-fg">{list(r.verbs).join(', ')}</span>,
            },
          ]}
        />
      </Section>
      {Object.keys(aggregation).length > 0 && (
        <Section title={i18n.t('Aggregation')}>
          <ChipList
            entries={asArray(aggregation.clusterRoleSelectors)
              .filter(isObject)
              .flatMap((s) =>
                Object.entries(asObject(s.matchLabels)).map(([k, v]) => `${k}=${asString(v)}`),
              )}
          />
        </Section>
      )}
    </>
  );
}

export function BindingSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const role = asObject(field(obj, 'roleRef'));
  const subjects = asArray(field(obj, 'subjects')).filter(isObject);
  return (
    <>
      <Section title={i18n.t('Role reference')}>
        <Rows>
          <Row label={i18n.t('Kind')}>{asString(role.kind)}</Row>
          <Row label={i18n.t('Name')}>
            <RefLink
              target={{
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: asString(role.kind),
                name: asString(role.name),
                namespace: asString(role.kind) === 'Role' ? (obj.metadata.namespace ?? null) : null,
              }}
              ctx={ctx}
            />
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Subjects')}>
        <MiniTable
          rows={subjects}
          rowKey={(s, i) => `${asString(s.kind)}:${asString(s.name)}:${i}`}
          empty={i18n.t('No subjects')}
          columns={[
            { label: i18n.t('Kind'), cell: (s) => asString(s.kind) },
            {
              label: i18n.t('Name'),
              cell: (s) =>
                asString(s.kind) === 'ServiceAccount' ? (
                  <RefLink
                    target={{
                      apiVersion: 'v1',
                      kind: 'ServiceAccount',
                      name: asString(s.name),
                      namespace: asString(s.namespace) || (obj.metadata.namespace ?? null),
                    }}
                    ctx={ctx}
                  />
                ) : (
                  <MonoText>{asString(s.name)}</MonoText>
                ),
            },
            { label: i18n.t('Namespace'), lang: 'en', cell: (s) => asString(s.namespace) || '—' },
          ]}
        />
      </Section>
    </>
  );
}

export function ServiceAccountSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const ns = obj.metadata.namespace ?? null;
  const secrets = asArray(field(obj, 'secrets')).filter(isObject);
  const pull = asArray(field(obj, 'imagePullSecrets')).filter(isObject);
  return (
    <Section title={i18n.t('Service account')}>
      <Rows>
        <Row label={i18n.t('Automount token')}>
          {field(obj, 'automountServiceAccountToken') === false ? i18n.t('No') : i18n.t('Yes')}
        </Row>
        <Row label={i18n.t('Secrets')}>
          {secrets.length > 0 && (
            <span className="flex flex-col">
              {secrets.map((s) => (
                <RefLink
                  key={asString(s.name)}
                  target={{
                    apiVersion: 'v1',
                    kind: 'Secret',
                    name: asString(s.name),
                    namespace: ns,
                  }}
                  ctx={ctx}
                />
              ))}
            </span>
          )}
        </Row>
        <Row label={i18n.t('Image pull secrets')}>
          {pull.length > 0 && (
            <span className="flex flex-col">
              {pull.map((s) => (
                <RefLink
                  key={asString(s.name)}
                  target={{
                    apiVersion: 'v1',
                    kind: 'Secret',
                    name: asString(s.name),
                    namespace: ns,
                  }}
                  ctx={ctx}
                />
              ))}
            </span>
          )}
        </Row>
      </Rows>
    </Section>
  );
}
