import * as i18n from '@/i18n';
import { asString, field } from '@/lib/kube/accessors';
import { Row, Rows, Section } from '../primitives';
import { DataEditor } from './DataEditor';
import type { SectionProps } from './types';

export function ConfigMapSections({ obj, gvk, ctx, readOnly }: SectionProps) {
  return (
    <DataEditor
      key={obj.metadata.uid}
      obj={obj}
      gvk={gvk}
      clusterId={ctx.clusterId}
      readOnly={readOnly}
    />
  );
}

export function SecretSections({ obj, gvk, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  return (
    <>
      <Section title={i18n.t('Secret')}>
        <Rows>
          <Row label={i18n.t('Type')}>
            <span className="font-mono text-[11.5px]">
              {asString(field(obj, 'type')) || 'Opaque'}
            </span>
          </Row>
          <Row label={i18n.t('Immutable')}>
            {field(obj, 'immutable') === true ? i18n.t('Yes') : null}
          </Row>
        </Rows>
      </Section>
      <DataEditor
        key={obj.metadata.uid}
        obj={obj}
        gvk={gvk}
        clusterId={ctx.clusterId}
        readOnly={readOnly}
        secret
      />
    </>
  );
}
