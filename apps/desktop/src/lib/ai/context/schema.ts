import { isArrayNode, typeLabel, type SchemaNode, type SchemaSet } from '@/lib/kube/schema/openapi';

/** Technical schema text sent as context, never an app-owned display label. */
export function schemaOutline(
  set: SchemaSet,
  root: SchemaNode,
  opts: { maxDepth?: number; maxLines?: number } = {},
): string {
  const maxDepth = Math.max(0, Math.min(12, opts.maxDepth ?? 4));
  const maxLines = Math.max(1, Math.min(2000, opts.maxLines ?? 400));
  const lines: string[] = [];
  let omitted = 0;
  let visited = 0;
  const visit = (node: SchemaNode, path: string, depth: number, parents: Set<SchemaNode>) => {
    if (depth > maxDepth || parents.has(node) || ++visited > 10000) return;
    const next = new Set(parents).add(node);
    for (const [name, raw] of Object.entries(node.properties)) {
      const child = set.node(raw);
      const field = path ? `${path}.${name}` : name;
      const line = `${field}: ${typeLabel(set, child)}${node.required.includes(name) ? ' (required)' : ''}${child.enum ? ` {${child.enum.join('|')}}` : ''}`;
      if (lines.length < maxLines) lines.push(line);
      else omitted++;
      if (isArrayNode(child) && child.items)
        visit(set.node(child.items), `${field}[]`, depth, next);
      else visit(child, field, depth + 1, next);
    }
  };
  visit(root, '', 0, new Set());
  if (omitted) lines.push(`… ${omitted} more fields`);
  return lines.join('\n');
}
