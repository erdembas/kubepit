import { describe, expect, it } from 'vitest';
import { SchemaSet } from '@/lib/kube/schema/openapi';
import { validateDocuments } from './validateGenerated';
import { schemaOutline } from './context/schema';

const set = SchemaSet.fromJsonSchema({
  type: 'object',
  properties: {
    apiVersion: { type: 'string' },
    kind: { type: 'string' },
    spec: {
      type: 'object',
      properties: {
        replicas: { type: 'integer' },
        containers: {
          type: 'array',
          items: { type: 'object', required: ['image'], properties: { image: { type: 'string' } } },
        },
      },
    },
  },
  required: ['apiVersion', 'kind'],
});
const root = set.rootNode();

describe('generated YAML validation', () => {
  it('outlines array fields and caps output', () => {
    expect(schemaOutline(set, root)).toContain('spec.containers[].image: string (required)');
    expect(schemaOutline(set, root, { maxLines: 2 })).toMatch(/more fields$/);
  });
  it('attributes syntax and schema failures to documents and lines', async () => {
    const result = await validateDocuments(
      'apiVersion: v1\nkind: Pod\nspec:\n  replicas: nope\n---\napiVersion: v1\nkind: Pod\nspec: [\n',
      async () => ({
        status: 'ok',
        set,
        root,
        name: 'Pod',
        gvk: { group: '', version: 'v1', kind: 'Pod' },
      }),
    );
    expect(result.documents).toBe(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document: 1, severity: 'error', line: 4 }),
        expect.objectContaining({ document: 2, severity: 'error' }),
      ]),
    );
  });
  it('reports missing schemas without claiming the manifest is valid', async () => {
    const result = await validateDocuments('apiVersion: example.io/v1\nkind: Widget', async () => ({
      status: 'unknown-kind',
    }));
    expect(result.unresolved).toEqual(['example.io/v1 Widget']);
  });
});
