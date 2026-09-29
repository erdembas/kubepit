import { describe, expect, it } from 'vitest';
import { explainable, nlRequest, querySection, yamlKindSection } from './intents';

describe('assistant entry points', () => {
  it('offers explanations only for pods and supported workloads', () => {
    expect(['Pod', 'Deployment', 'CronJob', 'StatefulSet'].every(explainable)).toBe(true);
    expect(explainable('Secret')).toBe(false);
  });
  it('preserves the requested YAML identity independently of schema availability', () => {
    const section = yamlKindSection('example.io/v1', 'Widget', 'shop');
    expect(section).toMatchObject({ kind: 'scope', format: 'json', priority: 0 });
    expect(JSON.parse(section.content)).toEqual({
      apiVersion: 'example.io/v1',
      kind: 'Widget',
      namespace: 'shop',
    });
  });
  it('keeps query source verbatim and sends identity-only natural language context', () => {
    const query = '{app="web"} |= "error"';
    expect(querySection('logql', query)).toMatchObject({
      kind: 'query',
      content: query,
      priority: 0,
    });
    const r = nlRequest('kubectl', 'restart web', {
      cluster_id: 'c',
      namespace: 'shop',
      object: null,
    });
    expect(r.sections.map((s) => s.kind)).toEqual(['scope']);
    expect(JSON.parse(r.sections[0]!.content)).toEqual({
      cluster_id: 'c',
      namespace: 'shop',
      object: null,
    });
  });
});
