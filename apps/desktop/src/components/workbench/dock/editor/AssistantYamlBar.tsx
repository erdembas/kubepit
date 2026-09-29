import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { servedResources, resolveKind } from '@/lib/kube/schema/loader';
import { yamlKindSection } from '@/lib/ai/intents';
import { schemaOutline } from '@/lib/ai/context/schema';
import { validateGenerated, type GeneratedValidation } from '@/lib/ai/validateGenerated';
import { useAssistantStore } from '@/store/useAssistantStore';
import type { AiContextSection, ApiResourceInfo, ClusterId } from '@/types';

export function AssistantYamlBar({
  clusterId,
  tabId,
  yaml,
  namespace,
}: {
  clusterId: ClusterId;
  tabId: string;
  yaml: string;
  namespace: string;
}) {
  i18n.useLocale();
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('');
  const [resources, setResources] = useState<ApiResourceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState<{
    yaml: string;
    clusterId: string;
    result: GeneratedValidation;
  } | null>(null);
  const validation =
    validated?.yaml === yaml && validated.clusterId === clusterId ? validated.result : null;
  const validationGeneration = useRef(0);
  useEffect(() => {
    ++validationGeneration.current;
    setValidated(null);
    return () => {
      ++validationGeneration.current;
    };
  }, [yaml, clusterId]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void servedResources(clusterId)
      .then((r) => {
        if (active) setResources(r);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clusterId]);
  const scope = { cluster_id: clusterId, namespace, object: null };
  const origin = { kind: 'editor' as const, clusterId, tabId };
  const ask = async (complete: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const sections: AiContextSection[] = [];
      if (yaml.trim())
        sections.push({
          id: 'editor',
          kind: 'editor',
          label: 'YAML',
          priority: 1,
          format: 'yaml',
          content: yaml,
        });
      const header = parseDocument(yaml);
      const selected = resources.find((r) => `${r.api_version}/${r.kind}` === kind);
      const apiVersion = selected?.api_version ?? header.get('apiVersion');
      const resourceKind = selected?.kind ?? header.get('kind');
      if (typeof apiVersion === 'string' && typeof resourceKind === 'string') {
        sections.push(yamlKindSection(apiVersion, resourceKind, namespace));
        const schema = await resolveKind(clusterId, apiVersion, resourceKind);
        if (schema.status === 'ok')
          sections.push({
            id: 'schema',
            kind: 'schema',
            label: `${apiVersion} ${resourceKind}`,
            priority: 2,
            format: 'text',
            content: schemaOutline(schema.set, schema.root),
          });
      }
      await useAssistantStore.getState().ask({
        intent: 'yaml',
        message:
          prompt.trim() ||
          (complete
            ? i18n.t('Complete the current YAML manifest.')
            : i18n.t('Generate a resource manifest for the selected kind.')),
        sections,
        scope,
        origin,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    const ticket = ++validationGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const result = await validateGenerated(clusterId, yaml);
      if (ticket === validationGeneration.current) setValidated({ yaml, clusterId, result });
    } catch (e) {
      if (ticket === validationGeneration.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-border/60 @container space-y-2 border-b p-2 text-[11px]">
      <div className="flex flex-wrap gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label={i18n.t('Describe the YAML to generate')}
          placeholder={i18n.t('Describe the YAML to generate')}
          className="bg-surface-raised border-border min-w-32 flex-1 rounded border px-2 py-1"
        />
        <Select
          value={kind}
          onChange={setKind}
          ariaLabel={i18n.t('Resource kind')}
          options={[
            { value: '', label: i18n.t('Kind from editor') },
            ...resources
              .filter((r) => !r.plural.includes('/'))
              .map((r) => ({
                value: `${r.api_version}/${r.kind}`,
                label: `${r.kind} (${r.api_version})`,
              })),
          ]}
        />
        <Button
          size="xs"
          disabled={busy || (!prompt.trim() && !kind)}
          onClick={() => void ask(false)}
        >
          {i18n.t('Generate')}
        </Button>
        <Button size="xs" disabled={busy || !yaml.trim()} onClick={() => void ask(true)}>
          {i18n.t('Complete YAML')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || !yaml.trim()}
          onClick={() => void validate()}
        >
          {i18n.t('Validate YAML')}
        </Button>
      </div>
      {validation && (
        <div>
          <span>
            {i18n.plural(
              '{count} validation issue',
              '{count} validation issues',
              validation.issues.length,
            )}
          </span>
          {!!validation.unresolved.length && (
            <p>
              {i18n.t('Schema unavailable for: {kinds}', {
                kinds: validation.unresolved.join(', '),
              })}
            </p>
          )}
          {!!validation.issues.length && (
            <button
              type="button"
              className="text-accent ml-2"
              onClick={() =>
                void useAssistantStore.getState().ask({
                  intent: 'yaml',
                  message: i18n.t('Fix the validation issues in this manifest.'),
                  sections: [
                    {
                      id: 'editor',
                      kind: 'editor',
                      label: 'YAML',
                      priority: 0,
                      format: 'yaml',
                      content: yaml,
                    },
                    {
                      id: 'issues',
                      kind: 'schema',
                      label: 'validation',
                      priority: 1,
                      format: 'json',
                      content: JSON.stringify(validation.issues),
                    },
                  ],
                  scope,
                  origin,
                })
              }
            >
              {i18n.t('Ask to fix issues')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
