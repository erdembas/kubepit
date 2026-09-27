import * as i18n from '@/i18n';
import { useLocaleMemo } from '@/i18n';
import { useState } from 'react';
import { CircleHelp, Loader2, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { kubectlCanI, parseResourceRef, resourceRef } from '@/lib/kube/access';
import { BUILTIN_KINDS } from '@/lib/kube/catalog';
import type { SearchableOption } from '@/lib/selectSearch';
import { reviewNow } from '@/store/useAccessStore';
import type { AccessCheck, AccessDecision, ApiResourceInfo } from '@/types';
import { CodeBlock } from '../details/primitives';
import { errorText } from '../util';

const VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection',
  'impersonate',
  'bind',
  'escalate',
  'approve',
  'use',
];

/** Subresources worth asking about directly (`kubectl auth can-i create pods --subresource=exec`). */
const SUBRESOURCES = [
  'pods/log',
  'pods/exec',
  'pods/attach',
  'pods/portforward',
  'pods/eviction',
  'pods/ephemeralcontainers',
  'deployments.apps/scale',
  'statefulsets.apps/scale',
  'replicasets.apps/scale',
  'serviceaccounts/token',
  'nodes/proxy',
  'services/proxy',
];

interface Kind {
  ref: string;
  kind: string;
  namespaced: boolean;
  terms: string;
}

function kindsOf(apiResources: readonly ApiResourceInfo[] | null): Kind[] {
  const source = apiResources?.length
    ? apiResources.map((r) => ({ ...r, shortNames: r.short_names }))
    : BUILTIN_KINDS;
  const seen = new Set<string>();
  const out: Kind[] = [];
  for (const r of source) {
    const ref = resourceRef({ group: r.group, resource: r.plural, subresource: null });
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      ref,
      kind: r.kind,
      namespaced: r.namespaced,
      terms: `${r.kind} ${r.shortNames.join(' ')}`,
    });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** `kubectl auth can-i` as a form: one fresh SelfSubjectAccessReview per question. */
export function CanIForm({
  clusterId,
  namespaces,
  defaultNamespace,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  defaultNamespace: string;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [verb, setVerb] = useState('get');
  const [resource, setResource] = useState('pods');
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    check: AccessCheck;
    namespaced: boolean;
    decision: AccessDecision;
  } | null>(null);

  const kinds = useLocaleMemo(() => kindsOf(apiResources), [apiResources]);
  const resourceOptions = useLocaleMemo((): SearchableOption[] => {
    const group = i18n.t('Resources');
    const subgroup = i18n.t('Subresources');
    return [
      ...kinds.map((k) => ({
        value: k.ref,
        label: k.ref,
        description: k.kind,
        keywords: k.terms,
        group,
      })),
      ...SUBRESOURCES.map((ref) => ({ value: ref, label: ref, group: subgroup })),
    ];
  }, [kinds]);
  const namespaceOptions = useLocaleMemo((): SearchableOption[] => {
    const names = [...new Set([...namespaces, defaultNamespace])].sort((a, b) =>
      a.localeCompare(b),
    );
    return [
      { value: '', label: i18n.t('Cluster-wide (all namespaces)') },
      ...names.map((n) => ({ value: n, label: n })),
    ];
  }, [namespaces, defaultNamespace]);

  const parsed = parseResourceRef(resource);
  const base = resourceRef({ ...parsed, subresource: null });
  const namespaced = kinds.find((k) => k.ref === base)?.namespaced ?? true;

  const ask = async () => {
    if (!verb || !parsed.resource) return;
    const check: AccessCheck = {
      verb,
      group: parsed.group,
      resource: parsed.resource,
      subresource: parsed.subresource,
      namespace: namespaced ? namespace || null : null,
      name: name.trim() || null,
    };
    setBusy(true);
    try {
      const [decision] = await reviewNow(clusterId, [check]);
      if (decision) setResult({ check, namespaced, decision });
    } catch (e) {
      setResult({
        check,
        namespaced,
        decision: { allowed: false, denied: false, reason: null, error: errorText(e) },
      });
    } finally {
      setBusy(false);
    }
  };

  const d = result?.decision;
  const Icon = !d ? CircleHelp : d.error ? ShieldQuestion : d.allowed ? ShieldCheck : ShieldX;

  return (
    <section className="border-border bg-surface-raised/40 flex flex-col rounded-lg border">
      <header className="border-border/60 flex h-10 items-center gap-2 border-b px-3">
        <CircleHelp className="text-fg-dim h-3.5 w-3.5" />
        <h3 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Can I…?')}
        </h3>
      </header>
      <form
        className="grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Field label={i18n.t('Verb')}>
          <Select
            value={verb}
            onChange={setVerb}
            options={VERBS.map((v) => ({ value: v, label: v }))}
            ariaLabel={i18n.t('Verb')}
            className="h-8 w-full font-mono"
          />
        </Field>
        <Field label={i18n.t('Resource')}>
          <SearchableSelect
            value={resource}
            onChange={setResource}
            options={resourceOptions}
            label={i18n.t('Resource')}
            compact
            className="border-border bg-surface-raised w-full border font-mono"
            createOption={(q) => {
              const text = q.trim();
              return text ? { value: text, label: text, description: i18n.t('Custom') } : null;
            }}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <SearchableSelect
            value={namespaced ? namespace : ''}
            onChange={setNamespace}
            options={namespaceOptions}
            label={i18n.t('Namespace')}
            disabled={!namespaced}
            compact
            className="border-border bg-surface-raised w-full border font-mono"
          />
        </Field>
        <Field label={i18n.t('Name (optional)')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={i18n.t('Any object')}
            aria-label={i18n.t('Object name')}
            mono
            className="h-8"
          />
        </Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" size="sm" variant="primary" disabled={busy || !parsed.resource}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {i18n.t('Check')}
          </Button>
          <span className="text-fg-dim truncate font-mono text-[11px]">
            {kubectlCanI(
              {
                verb,
                group: parsed.group,
                resource: parsed.resource,
                subresource: parsed.subresource,
                namespace: namespaced ? namespace || null : null,
                name: name.trim() || null,
              },
              namespaced,
            )}
          </span>
        </div>
      </form>
      {result && d && (
        <div className="border-border/60 border-t px-3 py-3" aria-live="polite">
          <div className="flex items-start gap-2.5">
            <Icon
              className={
                d.error
                  ? 'text-status-starting mt-0.5 h-5 w-5 shrink-0'
                  : d.allowed
                    ? 'text-status-running mt-0.5 h-5 w-5 shrink-0'
                    : 'text-status-error mt-0.5 h-5 w-5 shrink-0'
              }
            />
            <div className="min-w-0 flex-1">
              <p className="text-fg text-[13px] font-semibold">
                {d.error
                  ? i18n.t('The API server could not answer')
                  : d.allowed
                    ? i18n.t('Yes, you can')
                    : i18n.t("No, you can't")}
              </p>
              <p className="text-fg-muted mt-0.5 text-[12px] break-words">
                {d.error ??
                  d.reason ??
                  (d.allowed
                    ? i18n.t('Allowed.')
                    : d.denied
                      ? i18n.t('Explicitly denied by an authorizer.')
                      : i18n.t('No RBAC rule grants this permission.'))}
              </p>
            </div>
          </div>
          <div className="mt-2.5">
            <CodeBlock text={kubectlCanI(result.check, result.namespaced)} />
          </div>
        </div>
      )}
    </section>
  );
}
