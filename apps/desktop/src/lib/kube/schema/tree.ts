import { childrenOf, propertiesOf, type FieldInfo } from './fields';
import { childContainer, type SchemaNode, type SchemaSet } from './openapi';

/**
 * The API explorer's field tree (`kubectl explain --recursive`, browsable):
 * visible rows for a set of expanded paths, or every field whose path
 * matches a filter. Recursive definitions (JSONSchemaProps, …) stop at
 * their second occurrence on a branch, and traversal is bounded.
 */

export interface TreeRow {
  /** Dotted explorer path (`spec.template.spec.containers`). */
  id: string;
  field: FieldInfo;
  depth: number;
  expanded: boolean;
  /** The field's type already appears above it on this branch. */
  recursive: boolean;
  /** Matches the filter (filter mode only). */
  match: boolean;
}

export const MAX_DEPTH = 16;
const MAX_VISITED = 20000;

export const rowId = (path: readonly string[]) => path.join('.');

interface Step {
  field: FieldInfo;
  id: string;
  recursive: boolean;
  refs: string[];
}

function step(set: SchemaSet, field: FieldInfo, refs: string[]): Step {
  const ref = childContainer(set, field.node).ref;
  const recursive = !!ref && refs.includes(ref);
  return { field, id: rowId(field.path), recursive, refs: ref ? [...refs, ref] : refs };
}

/** Rows for the fields under `root`, descending into `expanded` paths. */
export function visibleRows(
  set: SchemaSet,
  root: SchemaNode,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (fields: FieldInfo[], depth: number, refs: string[]) => {
    for (const field of fields) {
      if (rows.length >= MAX_VISITED) return;
      const s = step(set, field, refs);
      const open = field.expandable && !s.recursive && expanded.has(s.id) && depth < MAX_DEPTH;
      rows.push({ id: s.id, field, depth, expanded: open, recursive: s.recursive, match: false });
      if (open) visit(childrenOf(set, field), depth + 1, s.refs);
    }
  };
  visit(propertiesOf(set, root), 0, root.ref ? [root.ref] : []);
  return rows;
}

/**
 * Rows matching `query`, with their ancestors (expanded). Words match the
 * field name; a word with a dot matches the whole path (`containers.image`).
 */
export function filteredRows(set: SchemaSet, root: SchemaNode, query: string): TreeRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  let budget = MAX_VISITED;
  const visit = (fields: FieldInfo[], depth: number, refs: string[]): TreeRow[] => {
    const out: TreeRow[] = [];
    for (const field of fields) {
      if (budget-- <= 0) break;
      const s = step(set, field, refs);
      const name = field.name.toLowerCase();
      const path = s.id.toLowerCase();
      const match = words.every((w) => (w.includes('.') ? path.includes(w) : name.includes(w)));
      const children =
        field.expandable && !s.recursive && depth < MAX_DEPTH
          ? visit(childrenOf(set, field), depth + 1, s.refs)
          : [];
      if (!match && !children.length) continue;
      out.push({
        id: s.id,
        field,
        depth,
        expanded: children.length > 0,
        recursive: s.recursive,
        match,
      });
      out.push(...children);
    }
    return out;
  };
  return visit(propertiesOf(set, root), 0, root.ref ? [root.ref] : []);
}

/** Every expandable path down to `maxDepth` ("Expand all"). */
export function expandableIds(set: SchemaSet, root: SchemaNode, maxDepth = 6): Set<string> {
  const ids = new Set<string>();
  const visit = (fields: FieldInfo[], depth: number, refs: string[]) => {
    for (const field of fields) {
      if (ids.size >= MAX_VISITED / 4) return;
      const s = step(set, field, refs);
      if (!field.expandable || s.recursive || depth >= maxDepth) continue;
      ids.add(s.id);
      visit(childrenOf(set, field), depth + 1, s.refs);
    }
  };
  visit(propertiesOf(set, root), 0, root.ref ? [root.ref] : []);
  return ids;
}

/** The ancestors of a path (`a.b.c` → `a`, `a.b`), to reveal it. */
export function ancestorIds(path: readonly string[]): string[] {
  return path.slice(0, -1).map((_, i) => rowId(path.slice(0, i + 1)));
}
