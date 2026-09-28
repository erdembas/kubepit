import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Field, Input } from '@/components/ui/Input';
import { Checkbox, Radio } from '@/components/ui/Choice';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { field } from '@/lib/kube/accessors';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import {
  bindingName,
  buildServiceAccount,
  serviceAccountBlocked,
  serviceAccountDefaults,
  validateServiceAccount,
  type RoleKind,
  type ServiceAccountInput,
} from '@/lib/kube/wizards/rbac';
import { GVK, useLiveList } from './data';
import { FieldGrid, NamespaceSelect, Notice, Section } from './fields';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

/** Cluster roles most bindings use, listed first. */
const COMMON_CLUSTER_ROLES = ['view', 'edit', 'admin'];

/**
 * `kubectl create serviceaccount` (+ an optional RoleBinding) and
 * `kubectl create rolebinding --serviceaccount=…` for an existing one.
 */
export function ServiceAccountWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'serviceaccount' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [input, setInput] = useState<ServiceAccountInput>(() =>
    serviceAccountDefaults(request.namespace, {
      mode: request.mode,
      name: request.name,
      role: request.role ?? null,
    }),
  );
  const patch = (p: Partial<ServiceAccountInput>) => setInput((s) => ({ ...s, ...p }));
  const setBinding = (p: Partial<ServiceAccountInput['binding']>) =>
    setInput((s) => ({ ...s, binding: { ...s.binding, ...p } }));
  const bind = input.mode === 'bind';

  const accounts = useLiveList(request.clusterId, GVK.serviceAccount, input.namespace);
  const roles = useLiveList(request.clusterId, GVK.role, input.namespace, input.binding.enabled);
  const clusterRoles = useLiveList(request.clusterId, GVK.clusterRole, null, input.binding.enabled);
  const secrets = useLiveList(request.clusterId, GVK.secret, input.namespace, !bind);
  const pullSecrets = useMemo(
    () =>
      secrets.items
        .filter((s) =>
          ['kubernetes.io/dockerconfigjson', 'kubernetes.io/dockercfg'].includes(
            String(field(s, 'type') ?? ''),
          ),
        )
        .map((s) => s.metadata.name),
    [secrets.items],
  );
  const existing = useMemo(() => accounts.items.map((a) => a.metadata.name), [accounts.items]);
  const errors = useMemo(() => validateServiceAccount(input, existing), [input, existing]);
  const objects = useMemo(() => buildServiceAccount(input), [input]);
  const yaml = useMemo(() => manifestYaml(objects), [objects]);

  const roleOptions = useMemo(() => {
    if (input.binding.roleKind === 'Role')
      return roles.items.map((r) => ({ value: r.metadata.name, label: r.metadata.name }));
    const names = clusterRoles.items
      .map((r) => r.metadata.name)
      // System roles are rarely bound by hand; keep them searchable but last.
      .sort((a, b) => {
        const rank = (n: string) =>
          COMMON_CLUSTER_ROLES.includes(n)
            ? COMMON_CLUSTER_ROLES.indexOf(n)
            : n.startsWith('system:')
              ? 100
              : 10;
        return rank(a) - rank(b) || a.localeCompare(b);
      });
    return names.map((n) => ({
      value: n,
      label: n,
      description: COMMON_CLUSTER_ROLES.includes(n) ? i18n.t('Built-in role') : undefined,
    }));
  }, [input.binding.roleKind, roles.items, clusterRoles.items]);

  const creates = [
    ...(bind ? [] : [{ gvk: GVK.serviceAccount, namespace: input.namespace }]),
    ...(input.binding.enabled ? [{ gvk: GVK.roleBinding, namespace: input.namespace }] : []),
  ];

  return (
    <WizardShell
      request={request}
      title={bind ? i18n.t('Create RoleBinding') : i18n.t('Create ServiceAccount')}
      subtitle={bind ? 'kubectl create rolebinding' : 'kubectl create serviceaccount'}
      yaml={yaml}
      namespace={input.namespace}
      blocked={serviceAccountBlocked(errors)}
      errors={errors}
      creates={creates}
      onClose={onClose}
    >
      <FieldGrid>
        <Field
          label={<span lang="en">ServiceAccount</span>}
          error={input.name || bind ? (errors.name ?? errors.exists) : null}
        >
          {bind ? (
            <SearchableSelect
              value={input.name}
              onChange={(name) => patch({ name })}
              options={accounts.items.map((a) => ({
                value: a.metadata.name,
                label: a.metadata.name,
              }))}
              label="ServiceAccount"
              placeholder={i18n.t('Pick a ServiceAccount…')}
              className="w-full font-mono"
            />
          ) : (
            <Input
              mono
              autoFocus
              value={input.name}
              placeholder="ci-deployer"
              onChange={(e) => patch({ name: e.target.value })}
            />
          )}
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            onChange={(namespace) =>
              setInput((s) => ({
                ...s,
                namespace,
                ...(bind ? { name: '' } : {}),
                imagePullSecrets: [],
                binding: {
                  ...s.binding,
                  roleName: s.binding.roleKind === 'Role' ? '' : s.binding.roleName,
                },
              }))
            }
          />
        </Field>
      </FieldGrid>

      {!bind && (
        <Section title={i18n.t('Options')}>
          <Field
            label={i18n.t('Mount the API token into pods')}
            hint={i18n.t('Turn it off for workloads that never call the Kubernetes API.')}
          >
            <Select<string>
              value={input.automount === null ? 'default' : String(input.automount)}
              onChange={(v) => patch({ automount: v === 'default' ? null : v === 'true' })}
              options={[
                { value: 'default', label: i18n.t('Cluster default (mounted)') },
                { value: 'true', label: i18n.t('Always') },
                { value: 'false', label: i18n.t('Never') },
              ]}
              size="md"
              ariaLabel={i18n.t('Mount the API token into pods')}
              className="w-full"
            />
          </Field>
          {pullSecrets.length > 0 && (
            <Field label={<span lang="en">imagePullSecrets</span>}>
              <div className="space-y-0.5">
                {pullSecrets.map((name) => (
                  <label
                    key={name}
                    className="hover:bg-fg/4 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-[12px]"
                  >
                    <Checkbox
                      className="mt-0"
                      checked={input.imagePullSecrets.includes(name)}
                      onChange={(e) =>
                        patch({
                          imagePullSecrets: e.target.checked
                            ? [...input.imagePullSecrets, name]
                            : input.imagePullSecrets.filter((n) => n !== name),
                        })
                      }
                    />
                    <span className="text-fg font-mono">{name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
        </Section>
      )}

      <Section
        title={i18n.t('Role binding')}
        action={
          bind ? undefined : (
            <Switch
              bare
              checked={input.binding.enabled}
              onChange={(enabled) => setBinding({ enabled })}
            />
          )
        }
        hint={i18n.t('Grants the ServiceAccount a Role or ClusterRole in this namespace.')}
      >
        {input.binding.enabled && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup">
              {(['ClusterRole', 'Role'] as RoleKind[]).map((kind) => (
                <label
                  key={kind}
                  className="flex cursor-pointer items-center gap-2 text-[12px]"
                  lang="en"
                >
                  <Radio
                    name="role-kind"
                    className="mt-0"
                    checked={input.binding.roleKind === kind}
                    onChange={() => setBinding({ roleKind: kind, roleName: '' })}
                  />
                  <span className="text-fg">{kind}</span>
                </label>
              ))}
            </div>
            <FieldGrid>
              <Field label={i18n.t('Role')}>
                <SearchableSelect
                  value={input.binding.roleName}
                  onChange={(roleName) => setBinding({ roleName })}
                  options={roleOptions}
                  label={i18n.t('Role')}
                  placeholder={i18n.t('Pick a role…')}
                  className="w-full font-mono"
                />
              </Field>
              <Field
                label={i18n.rich('{kind} name', { kind: <span lang="en">RoleBinding</span> })}
                error={errors.bindingName}
              >
                <Input
                  mono
                  value={input.binding.name}
                  placeholder={
                    bindingName({ ...input, binding: { ...input.binding, name: '' } }) ||
                    'my-binding'
                  }
                  onChange={(e) => setBinding({ name: e.target.value })}
                />
              </Field>
            </FieldGrid>
            {input.binding.roleKind === 'Role' && roles.synced && roles.items.length === 0 && (
              <Notice tone="warning">
                {i18n.t('There are no Roles in {namespace}.', { namespace: input.namespace })}
              </Notice>
            )}
            {input.binding.roleKind === 'ClusterRole' && (
              <Notice>
                {i18n.t(
                  'A RoleBinding to a ClusterRole grants its permissions in this namespace only.',
                )}
              </Notice>
            )}
          </>
        )}
      </Section>
    </WizardShell>
  );
}
