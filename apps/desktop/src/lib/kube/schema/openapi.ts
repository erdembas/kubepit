import type { OpenApiDocument, OpenApiGvk, OpenApiSchema } from '@/types';

/**
 * OpenAPI v3 schema resolution for one group-version document, the way
 * Kubernetes publishes it: definitions under `components.schemas`, fields
 * that point at a definition wrapped as `{allOf: [{$ref}], description}`,
 * union types as `oneOf`/`anyOf` of plain types (Quantity, IntOrString) and
 * `x-kubernetes-*` extensions. Resolution is lazy and per level: a node
 * resolves its own `$ref`/`allOf` chain, children stay raw until visited,
 * so recursive definitions (JSONSchemaProps) cost nothing.
 *
 * `SchemaSet.fromJsonSchema` reads a JSON Schema (draft-07, as Helm's
 * `values.schema.json`) with the same machinery. Where the dialects differ:
 * `$ref` is a JSON pointer into the document (`#/definitions/x`, `#/$defs/x`,
 * `#`), `type` may be a list (`[string, 'null']`), objects accept unknown
 * keys unless `additionalProperties: false`, the properties of `oneOf` /
 * `anyOf` branches are offered as the object's own, and `const`,
 * `exclusiveMinimum` / `exclusiveMaximum` and `deprecated` are understood.
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
  exclusiveMinimum: number | null;
  exclusiveMaximum: number | null;
  /** `additionalProperties: false` somewhere in the chain. */
  closed: boolean;
  /** Any key is allowed next to `properties` (JSON Schema objects, `patternProperties`). */
  openKeys: boolean;
  /** JSON Schema `deprecated: true`. */
  deprecated: boolean;
  gvk: OpenApiGvk[];
}

export type SchemaDialect = 'openapi' | 'jsonschema';

const REF_PREFIX = '#/components/schemas/';

/** `io.k8s.api.core.v1.Container` → `Container`; `#/definitions/image` → `image`. */
export function shortName(ref: string): string {
  if (!ref.startsWith(REF_PREFIX) && ref.startsWith('#')) {
    const last = ref.slice(ref.lastIndexOf('/') + 1);
    return decodePointerSegment(last) || 'Object';
  }
  const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
  return name.slice(name.lastIndexOf('.') + 1) || name;
}

function decodePointerSegment(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    /* keep the raw segment */
  }
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Resolve a local JSON pointer (`#`, `#/definitions/image`) against a document. */
function resolvePointer(root: OpenApiSchema, ref: string): OpenApiSchema | null {
  if (ref === '#' || ref === '#/') return root;
  if (!ref.startsWith('#/')) return null;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[decodePointerSegment(raw)];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as OpenApiSchema)
    : null;
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
    exclusiveMinimum: null,
    exclusiveMaximum: null,
    closed: false,
    openKeys: false,
    deprecated: false,
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
  readonly dialect: SchemaDialect;
  /** The document itself (JSON Schema: `$ref`s are pointers into it). */
  readonly root: OpenApiSchema | null;
  private readonly nodes = new WeakMap<OpenApiSchema, SchemaNode>();
  /** Nodes being resolved (a union branch pointing back at its parent). */
  private readonly resolving = new Set<OpenApiSchema>();
  private kinds: Map<string, string> | null = null;

  constructor(
    doc: OpenApiDocument | null | undefined,
    dialect: SchemaDialect = 'openapi',
    root: OpenApiSchema | null = null,
  ) {
    this.schemas = doc?.components?.schemas ?? {};
    this.dialect = dialect;
    this.root = root;
  }

  /** A JSON Schema document (Helm `values.schema.json`); `rootNode()` is its top. */
  static fromJsonSchema(schema: OpenApiSchema): SchemaSet {
    return new SchemaSet(null, 'jsonschema', schema);
  }

  /** The resolved top of a JSON Schema document (`ANY_NODE` for OpenAPI sets). */
  rootNode(): SchemaNode {
    return this.node(this.root);
  }

  lookup(ref: string): OpenApiSchema | null {
    if (this.root && ref.startsWith('#') && !ref.startsWith(REF_PREFIX))
      return resolvePointer(this.root, ref);
    const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
    return this.schemas[name] ?? (this.root ? resolvePointer(this.root, ref) : null);
  }

  /** The resolved node of a raw schema (memoised per schema object). */
  node(schema: OpenApiSchema | null | undefined): SchemaNode {
    if (!schema) return ANY_NODE;
    const cached = this.nodes.get(schema);
    if (cached) return cached;
    if (this.resolving.has(schema)) return ANY_NODE;
    this.resolving.add(schema);
    const node = emptyNode();
    try {
      this.collect(schema, node, new Set(), true);
    } finally {
      this.resolving.delete(schema);
    }
    finish(node, this.dialect);
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

    const declared = Array.isArray(schema.type)
      ? schema.type
      : typeof schema.type === 'string'
        ? [schema.type]
        : [];
    if (declared.includes('null')) node.nullable = true;
    const types = declared.filter((t): t is JsonType => JSON_TYPES.includes(t));
    const branches = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].map((branch) =>
      this.node(branch),
    );
    if (types.length) node.types = types;
    else if (!declared.length && node.types.length === 0) {
      // Union types: `oneOf: [{type: string}, {type: number}]` (Quantity).
      const union = branches.map((branch) => branch.types).flat();
      if (union.length) node.types = [...new Set(union)];
    }
    // Keys any branch declares are offered on the object itself (never required).
    for (const branch of branches)
      for (const [key, value] of Object.entries(branch.properties))
        if (!(key in node.properties)) node.properties[key] = value;
    if (schema.description) node.description = schema.description;
    else if ((top || this.dialect === 'jsonschema') && schema.title && !node.description)
      node.description = schema.title;
    if (schema.format) node.format = schema.format;
    if (schema.properties) node.properties = { ...node.properties, ...schema.properties };
    if (schema.required) node.required = [...new Set([...node.required, ...schema.required])];
    if (schema.additionalProperties === true) node.additionalAny = true;
    else if (schema.additionalProperties === false) node.closed = true;
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      node.additional = schema.additionalProperties;
    if (schema.patternProperties && Object.keys(schema.patternProperties).length)
      node.openKeys = true;
    if (schema.items && !Array.isArray(schema.items)) node.items = schema.items;
    if (schema.enum) node.enum = schema.enum;
    else if ('const' in schema) node.enum = [schema.const];
    if (schema.deprecated === true) node.deprecated = true;
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
    if (typeof schema.exclusiveMinimum === 'number')
      node.exclusiveMinimum = schema.exclusiveMinimum;
    else if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number')
      node.exclusiveMinimum = schema.minimum;
    if (typeof schema.exclusiveMaximum === 'number')
      node.exclusiveMaximum = schema.exclusiveMaximum;
    else if (schema.exclusiveMaximum === true && typeof schema.maximum === 'number')
      node.exclusiveMaximum = schema.maximum;
  }
}

function finish(node: SchemaNode, dialect: SchemaDialect) {
  if (node.intOrString && node.types.length === 0) node.types = ['integer', 'string'];
  // Objects described only by their properties.
  if (node.types.length === 0 && (Object.keys(node.properties).length || node.additional))
    node.types = ['object'];
  // JSON Schema objects take unknown keys unless they say otherwise.
  if (
    dialect === 'jsonschema' &&
    !node.closed &&
    !node.additional &&
    (node.types.length === 0 || node.types.includes('object'))
  )
    node.openKeys = true;
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
    node.openKeys ||
    node.preserveUnknown ||
    (!hasProperties(node) && !node.closed)
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
