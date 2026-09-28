import {
  ANY_NODE,
  acceptsAnyKey,
  childContainer,
  hasProperties,
  isAny,
  isArrayNode,
  isMapNode,
  isObjectNode,
  typeLabel,
  type SchemaNode,
  type SchemaSet,
} from './openapi';

/** A step of a YAML path: a mapping key or a sequence index. */
export type PathSegment = string | number;

/** Everything the editor and the explorer show about one field. */
export interface FieldInfo {
  name: string;
  /** Explorer path (property names only; arrays and maps are transparent). */
  path: string[];
  type: string;
  required: boolean;
  deprecated: boolean;
  description: string;
  enum: unknown[] | null;
  hasDefault: boolean;
  default: unknown;
  format: string | null;
  /** Kubernetes markers and constraints (`int-or-string`, `list-map-keys: name`, `minimum: 0`). */
  hints: string[];
  /** Has fields of its own (directly, or through array items / map values). */
  expandable: boolean;
  node: SchemaNode;
}

const DEPRECATED = /^(deprecated|deprecated:|this field is deprecated)\b/i;

export function isDeprecated(description: string): boolean {
  return DEPRECATED.test(description.trim());
}

/** Raw Kubernetes markers and constraints of a node; never translated (they are identifiers). */
export function schemaHints(node: SchemaNode): string[] {
  const hints: string[] = [];
  if (node.intOrString) hints.push('int-or-string');
  if (node.preserveUnknown) hints.push('preserve-unknown-fields');
  if (node.embeddedResource) hints.push('embedded-resource');
  if (node.nullable) hints.push('nullable');
  if (node.listType) hints.push(`list-type: ${node.listType}`);
  if (node.listMapKeys.length) hints.push(`list-map-keys: ${node.listMapKeys.join(', ')}`);
  if (node.mapType) hints.push(`map-type: ${node.mapType}`);
  if (node.patchStrategy) hints.push(`patch-strategy: ${node.patchStrategy}`);
  if (node.patchMergeKey) hints.push(`patch-merge-key: ${node.patchMergeKey}`);
  if (node.minimum !== null) hints.push(`minimum: ${node.minimum}`);
  if (node.maximum !== null) hints.push(`maximum: ${node.maximum}`);
  if (node.minLength !== null) hints.push(`minLength: ${node.minLength}`);
  if (node.maxLength !== null) hints.push(`maxLength: ${node.maxLength}`);
  if (node.minItems !== null) hints.push(`minItems: ${node.minItems}`);
  if (node.maxItems !== null) hints.push(`maxItems: ${node.maxItems}`);
  if (node.pattern) hints.push(`pattern: ${node.pattern}`);
  if (node.exclusiveMinimum !== null) hints.push(`exclusiveMinimum: ${node.exclusiveMinimum}`);
  if (node.exclusiveMaximum !== null) hints.push(`exclusiveMaximum: ${node.exclusiveMaximum}`);
  return hints;
}

export function fieldInfo(
  set: SchemaSet,
  name: string,
  node: SchemaNode,
  required: boolean,
  path: string[],
): FieldInfo {
  const container = childContainer(set, node);
  return {
    name,
    path,
    type: typeLabel(set, node),
    required,
    deprecated: node.deprecated || isDeprecated(node.description),
    description: node.description,
    enum: node.enum ?? (isArrayNode(node) && node.items ? set.node(node.items).enum : null),
    hasDefault: node.hasDefault,
    default: node.default,
    format: node.format,
    hints: schemaHints(node),
    expandable: !isAny(container) && hasProperties(container),
    node,
  };
}

/** Sort: required first, then by name. */
export function compareFields(a: FieldInfo, b: FieldInfo): number {
  return Number(b.required) - Number(a.required) || a.name.localeCompare(b.name);
}

/** Direct fields of an object node (not unwrapping arrays or maps). */
export function propertiesOf(set: SchemaSet, node: SchemaNode, parentPath: string[] = []) {
  return Object.entries(node.properties)
    .map(([name, schema]) =>
      fieldInfo(set, name, set.node(schema), node.required.includes(name), [...parentPath, name]),
    )
    .sort(compareFields);
}

/** Explorer children: fields of the node, of its array items or of its map values. */
export function childrenOf(set: SchemaSet, field: FieldInfo): FieldInfo[] {
  return propertiesOf(set, childContainer(set, field.node), field.path);
}

export interface SchemaAt {
  node: SchemaNode;
  /** Last property name on the path (map keys and indices resolve to their container). */
  name: string | null;
  required: boolean;
  /** Explorer path of the field. */
  fieldPath: string[];
  /** The last step was a key of a map (`labels.app`) rather than a declared field. */
  mapKey: boolean;
}

/**
 * Walk a YAML path from the kind's root schema. Stops at the deepest point
 * the schema describes; `null` when a step leaves the schema (an unknown
 * field). Content below preserve-unknown-fields resolves to `ANY_NODE`.
 */
export function schemaAt(set: SchemaSet, root: SchemaNode, path: PathSegment[]): SchemaAt | null {
  let node = root;
  let name: string | null = null;
  let required = false;
  let mapKey = false;
  const fieldPath: string[] = [];
  for (const seg of path) {
    if (isAny(node)) return { node, name, required: false, fieldPath, mapKey };
    if (typeof seg === 'number') {
      if (node.items) node = set.node(node.items);
      else if (node.types.length === 0 || node.preserveUnknown) node = ANY_NODE;
      else return null;
      continue;
    }
    const child = node.properties[seg];
    if (child) {
      required = node.required.includes(seg);
      node = set.node(child);
      name = seg;
      mapKey = false;
      fieldPath.push(seg);
    } else if (node.additional) {
      node = set.node(node.additional);
      name = seg;
      required = false;
      mapKey = true;
    } else if (acceptsAnyKey(node) && !isArrayNode(node)) {
      node = ANY_NODE;
      name = seg;
      required = false;
      mapKey = true;
    } else return null;
  }
  return { node, name, required, fieldPath, mapKey };
}

/** Explorer path of the field a YAML path points at (as deep as the schema goes). */
export function fieldPathOf(set: SchemaSet, root: SchemaNode, path: PathSegment[]): string[] {
  let node = root;
  const out: string[] = [];
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (!node.items) break;
      node = set.node(node.items);
      continue;
    }
    const child = node.properties[seg];
    if (child) {
      out.push(seg);
      node = set.node(child);
    } else if (node.additional) node = set.node(node.additional);
    else break;
  }
  return out;
}

/** Resolve an explorer path (property names) to its field. */
export function fieldAtPath(set: SchemaSet, root: SchemaNode, path: string[]): FieldInfo | null {
  let node = root;
  let info: FieldInfo | null = null;
  for (let i = 0; i < path.length; i++) {
    const container = childContainer(set, node);
    const name = path[i]!;
    const child = container.properties[name];
    if (!child) return null;
    node = set.node(child);
    info = fieldInfo(set, name, node, container.required.includes(name), path.slice(0, i + 1));
  }
  return info;
}

/** Whether a value of this node can hold nested fields in YAML (object, map, array of objects). */
export function isStructured(node: SchemaNode): boolean {
  return isObjectNode(node) || isArrayNode(node) || isMapNode(node);
}
