import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Field, Input } from '@/components/ui/Input';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import {
  buildIngress,
  ingressBlocked,
  ingressDefaults,
  validateIngress,
  type IngressInput,
} from '@/lib/kube/wizards/ingress';
import { GVK } from './data';
import { FieldGrid, NamespaceSelect } from './fields';
import { IngressFields } from './IngressFields';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

/** `kubectl create ingress NAME --class=… --rule=host/path=service:port[,tls=secret]`. */
export function IngressWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'ingress' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [input, setInput] = useState<IngressInput>(() =>
    ingressDefaults(request.namespace, request.service),
  );
  const patch = (p: Partial<IngressInput>) => setInput((s) => ({ ...s, ...p }));
  const errors = useMemo(() => validateIngress(input), [input]);
  const yaml = useMemo(() => manifestYaml([buildIngress(input)]), [input]);

  return (
    <WizardShell
      request={request}
      title={i18n.t('Create Ingress')}
      subtitle="kubectl create ingress"
      yaml={yaml}
      namespace={input.namespace}
      blocked={ingressBlocked(errors)}
      errors={errors}
      creates={[{ gvk: GVK.ingress, namespace: input.namespace }]}
      onClose={onClose}
    >
      <FieldGrid>
        <Field label={i18n.t('Name')} error={input.name ? errors.name : null}>
          <Input
            mono
            autoFocus
            value={input.name}
            placeholder="web"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            disabled={!!request.service}
            onChange={(namespace) =>
              setInput((s) => ({
                ...s,
                namespace,
                // Services and Secrets are namespaced: drop picks from the old namespace.
                rules: s.rules.map((r) => ({
                  ...r,
                  paths: r.paths.map((p) => ({ ...p, service: '', port: '' })),
                })),
                tls: { ...s.tls, secretName: s.tls.mode === 'secret' ? '' : s.tls.secretName },
              }))
            }
          />
        </Field>
      </FieldGrid>
      <IngressFields clusterId={request.clusterId} input={input} errors={errors} onChange={patch} />
    </WizardShell>
  );
}
