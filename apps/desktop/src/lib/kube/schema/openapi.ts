import type { OpenApiDocument, OpenApiGvk, OpenApiSchema } from '@/types';

/**
 * OpenAPI v3 schema resolution for one group-version document, the way
 * Kubernetes publishes it: definitions under `components.schemas`, fields
 * that point at a definition wrapped as `{allOf: [{$ref}], description}`,
 * union types as `oneOf`/`anyOf` of plain types (Quantity, IntOrString) and
 * `x-kubernetes-*` extensions. Resolution is lazy and per level: a node
 * resolves its own `$ref`/`allOf` chain, children stay raw until visited,
 * so recursive definitions (JSONSchemaProps) cost nothing.
 */

export type JsonType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

const JSON_TYPES: readonly string[] = ['string', 'integer', 'number', 'boolean', 'object', 'array'];

/** A schema with its own `$ref`/`allOf` chain merged in. */
export interface SchemaNode {
  /** Full name of the definition this node refers to (`io.k8s.api.core.v1.Container`). */
  ref: string | null;
  /** Short type name of that definition (`Container`). */
  refName: string | null;
  /** Allowed JSON types; empty = anything. */
  types: JsonType[];
  format: string | null;
  description: string;
  properties: Record<string, OpenApiSchema>;
  required: string[];
  /** Value schema of a map (`additionalProperties: {...}`). */
  additional: OpenApiSchema | null;
  /** `additionalProperties: true`: any key, any value. */
  additionalAny: boolean;
  items: OpenApiSchema | null;
  enum: unknown[] | null;
  hasDefault: boolean;
  default: unknown;
  nullable: boolean;
  intOrString: boolean;
  preserveUnknown: boolean;
  embeddedResource: boolean;
  listType: string | null;
  listMapKeys: string[];
  mapType: string | null;
  patchStrategy: string | null;
  patchMergeKey: string | null;
  validations: Array<{ rule: string; message?: string }>;
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  minItems: number | null;
  maxItems: number | null;
  pattern: string | null;
  gvk: OpenApiGvk[];
}

const REF_PREFIX = '#/components/schemas/';

/** `io.k8s.api.core.v1.Container` → `Container`. */
export function shortName(ref: string): string {
  const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
  return name.slice(name.lastIndexOf('.') + 1) || name;
}

function emptyNode(): SchemaNode {
  return {
    ref: null,
    refName: null,
    types: [],
    format: null,
    description: '',
    properties: {},
    required: [],
    additional: null,
    additionalAny: false,
    items: null,
    enum: null,
    hasDefault: false,
    default: undefined,
    nullable: false,
    intOrString: false,
    preserveUnknown: false,
    embeddedResource: false,
    listType: null,
    listMapKeys: [],
    mapType: null,
    patchStrategy: null,
    patchMergeKey: null,
    validations: [],
    minimum: null,
    maximum: null,
    minLength: null,
    maxLength: null,
    minItems: null,
    maxItems: null,
    pattern: null,
    gvk: [],
  };
}

/** Matches anything (preserve-unknown-fields content, free-form maps, unknown schemas). */
export const ANY_NODE: SchemaNode = Object.freeze(emptyNode()) as SchemaNode;

export function isAny(node: SchemaNode): boolean {
  return node === ANY_NODE;
}

const gvkKey = (g: OpenApiGvk) => `${g.group}/${g.version}/${g.kind}`;

export class SchemaSet {
  readonly schemas: Record<string, OpenApiSchema>;
  private readonly nodes = new WeakMap<OpenApiSchema, SchemaNode>();
  private kinds: Map<string, string> | null = null;

  constructor(doc: OpenApiDocument | null | undefined) {
    this.schemas = doc?.components?.schemas ?? {};
  }

  lookup(ref: string): OpenApiSchema | null {
    const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
    return this.schemas[name] ?? null;
  }

  /** The resolved node of a raw schema (memoised per schema object). */
  node(schema: OpenApiSchema | null | undefined): SchemaNode {
    if (!schema) return ANY_NODE;
    const cached = this.nodes.get(schema);
    if (cached) return cached;
    const node = emptyNode();
    this.collect(schema, node, new Set(), true);
    finish(node);
    this.nodes.set(schema, node);
    return node;
  }

  /** Definition name + node of a kind, via `x-kubernetes-group-version-kind`. */
  findKind(gvk: OpenApiGvk): { name: string; node: SchemaNode } | null {
    if (!this.kinds) {
      this.kinds = new Map();
      for (const [name, schema] of Object.entries(this.schemas))
        for (const g of schema['x-kubernetes-group-version-kind'] ?? [])
          if (!this.kinds.has(gvkKey(g))) this.kinds.set(gvkKey(g), name);
    }
    const name = this.kinds.get(gvkKey(gvk));
    const schema = name ? this.schemas[name] : undefined;
    return name && schema ? { name, node: this.node(schema) } : null;
  }

  /** Every kind this document describes. */
  listKinds(): OpenApiGvk[] {
    this.findKind({ group: '', version: '', kind: '' });
    return [...(this.kinds?.keys() ?? [])].map((key) => {
      const [group = '', version = '', kind = ''] = key.split('/');
      return { group, version, kind };
    });
  }

  /**
   * Merge `schema` into `node`: referenced parts first, so the wrapper's own
   * keys (a field's description, default) win over the definition's.
   */
  private collect(schema: OpenApiSchema, node: SchemaNode, seen: Set<OpenApiSchema>, top: boolean) {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (schema.$ref) {
      const target = this.lookup(schema.$ref);
      if (!node.ref) {
        node.ref = schema.$ref.startsWith(REF_PREFIX)
          ? schema.$ref.slice(REF_PREFIX.length)
          : schema.$ref;
        node.refName = shortName(schema.$ref);
      }
      if (target) this.collect(target, node, seen, false);
    }
    for (const part of schema.allOf ?? []) this.collect(part, node, seen, false);

    if (typeof schema.type === 'string' && JSON_TYPES.includes(schema.type))
      node.types = [schema.type as JsonType];
    else if (!schema.type && node.types.length === 0) {
      // Union types: `oneOf: [{type: string}, {type: number}]` (Quantity).
      const union = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]
        .map((branch) => this.node(branch).types)
        .flat();
      if (union.length) node.types = [...new Set(union)];
    }
    if (schema.description) node.description = schema.description;
    else if (top && schema.title && !node.description) node.description = schema.title;
    if (schema.format) node.format = schema.format;
    if (schema.properties) node.properties = { ...node.properties, ...schema.properties };
    if (schema.required) node.required = [...new Set([...node.required, ...schema.required])];
    if (schema.additionalProperties === true) node.additionalAny = true;
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      node.additional = schema.additionalProperties;
    if (schema.items) node.items = schema.items;
    if (schema.enum) node.enum = schema.enum;
    if ('default' in schema) {
      node.hasDefault = true;
      node.default = schema.default;
    }
    if (schema.nullable) node.nullable = true;
    if (schema['x-kubernetes-int-or-string']) node.intOrString = true;
    if (schema['x-kubernetes-preserve-unknown-fields']) node.preserveUnknown = true;
    if (schema['x-kubernetes-embedded-resource']) node.embeddedResource = true;
    if (schema['x-kubernetes-list-type']) node.listType = schema['x-kubernetes-list-type'];
    if (schema['x-kubernetes-list-map-keys'])
      node.listMapKeys = schema['x-kubernetes-list-map-keys'];
    if (schema['x-kubernetes-map-type']) node.mapType = schema['x-kubernetes-map-type'];
    if (schema['x-kubernetes-patch-strategy'])
      node.patchStrategy = schema['x-kubernetes-patch-strategy'];
    if (schema['x-kubernetes-patch-merge-key'])
      node.patchMergeKey = schema['x-kubernetes-patch-merge-key'];
    if (schema['x-kubernetes-validations'])
      node.validations = [...node.validations, ...schema['x-kubernetes-validations']];
    if (schema['x-kubernetes-group-version-kind'])
      node.gvk = schema['x-kubernetes-group-version-kind'];
    if (typeof schema.minimum === 'number') node.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') node.maximum = schema.maximum;
    if (typeof schema.minLength === 'number') node.minLength = schema.minLength;
    if (typeof schema.maxLength === 'number') node.maxLength = schema.maxLength;
    if (typeof schema.minItems === 'number') node.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') node.maxItems = schema.maxItems;
    if (schema.pattern) node.pattern = schema.pattern;
  }
}

function finish(node: SchemaNode) {
  if (node.intOrString && node.types.length === 0) node.types = ['integer', 'string'];
  // Objects described only by their properties.
  if (node.types.length === 0 && (Object.keys(node.properties).length || node.additional))
    node.types = ['object'];
}

export function hasProperties(node: SchemaNode): boolean {
  return Object.keys(node.properties).length > 0;
}

export function isObjectNode(node: SchemaNode): boolean {
  return node.types.length === 1 && node.types[0] === 'object';
}

export function isArrayNode(node: SchemaNode): boolean {
  return node.types.length === 1 && node.types[0] === 'array';
}

/** A map (`additionalProperties`) rather than a struct. */
export function isMapNode(node: SchemaNode): boolean {
  return !hasProperties(node) && (node.additional !== null || node.additionalAny);
}

/** Any key is accepted below this node (no unknown-field checks). */
export function acceptsAnyKey(node: SchemaNode): boolean {
  return (
    isAny(node) ||
    node.additional !== null ||
    node.additionalAny ||
    node.preserveUnknown ||
    !hasProperties(node)
  );
}

function isIntOrString(node: SchemaNode): boolean {
  return (
    node.intOrString ||
    (node.types.length === 2 && node.types.includes('integer') && node.types.includes('string'))
  );
}

/**
 * `kubectl explain`-style type label: `string`, `[]Container`,
 * `map[string]string`, `ObjectMeta`, `Object`, `IntOrString`, `Quantity`.
 */
export function typeLabel(set: SchemaSet, node: SchemaNode, depth = 0): string {
  if (isAny(node)) return 'any';
  if (isIntOrString(node)) return 'IntOrString';
  if (node.refName === 'Quantity') return 'Quantity';
  if (depth > 4) return node.refName ?? 'Object';
  if (isArrayNode(node))
    return `[]${node.items ? typeLabel(set, set.node(node.items), depth + 1) : 'any'}`;
  if (isObjectNode(node) || node.types.length === 0) {
    if (isMapNode(node))
      return `map[string]${node.additional ? typeLabel(set, set.node(node.additional), depth + 1) : 'any'}`;
    if (hasProperties(node)) return node.refName ?? 'Object';
    return node.types.length ? 'Object' : node.preserveUnknown ? 'Object' : 'any';
  }
  return node.types.join(' | ');
}

/** The node whose properties are the children of `node` (arrays and maps are transparent). */
export function childContainer(set: SchemaSet, node: SchemaNode): SchemaNode {
  let current = node;
  for (let i = 0; i < 4; i++) {
    if (isArrayNode(current) && current.items) current = set.node(current.items);
    else if (isMapNode(current) && current.additional) current = set.node(current.additional);
    else break;
  }
  return current;
}
