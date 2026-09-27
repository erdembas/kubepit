import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
  type ParsedNode,
} from 'yaml';
import type { PathSegment } from './fields';

/**
 * Parsed-YAML helpers with source ranges (absolute offsets into the text
 * given to `parseDocuments`), for hovers, explain-at-cursor and
 * diagnostics on documents the parser accepts.
 */

export type ParsedDoc = Document.Parsed<ParsedNode, true>;

export function parseDocuments(text: string): ParsedDoc[] {
  try {
    return [...parseAllDocuments(text)] as ParsedDoc[];
  } catch {
    return [];
  }
}

export interface PathHit {
  path: PathSegment[];
  /** Over the key itself, or over a scalar value. */
  on: 'key' | 'value';
  /** Offsets of the hovered token. */
  start: number;
  end: number;
}

function keyText(node: unknown): string | null {
  if (isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value);
  return null;
}

const within = (offset: number, range: readonly number[] | null | undefined, endIndex = 1) =>
  !!range && offset >= range[0]! && offset <= range[endIndex]!;

function search(node: Node | null, offset: number, path: PathSegment[]): PathHit | null {
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const key = keyText(pair.key);
      if (key === null) continue;
      const keyNode = pair.key as Node;
      if (within(offset, keyNode.range)) {
        return {
          path: [...path, key],
          on: 'key',
          start: keyNode.range![0],
          end: keyNode.range![1],
        };
      }
      const value = pair.value as Node | null;
      if (value && within(offset, value.range, 2)) {
        const hit = search(value, offset, [...path, key]);
        if (hit) return hit;
      }
    }
    return null;
  }
  if (isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i] as Node | null;
      if (item && within(offset, item.range, 2)) return search(item, offset, [...path, i]);
    }
    return null;
  }
  if (isScalar(node) && within(offset, node.range)) {
    return { path, on: 'value', start: node.range![0], end: node.range![1] };
  }
  return null;
}

/** The key or scalar under `offset`, with its YAML path. */
export function pathAtOffset(docs: readonly ParsedDoc[], offset: number): PathHit | null {
  for (const doc of docs) {
    const [start, , end] = doc.range;
    if (offset < start || offset > end) continue;
    return search(doc.contents as Node | null, offset, []);
  }
  return null;
}

/** The parsed document containing `offset`. */
export function documentAtOffset(docs: readonly ParsedDoc[], offset: number): ParsedDoc | null {
  return docs.find((d) => offset >= d.range[0] && offset <= d.range[2]) ?? null;
}

/** Top-level `apiVersion` / `kind` of a parsed document. */
export function parsedHeader(doc: ParsedDoc): { apiVersion: string | null; kind: string | null } {
  const contents = doc.contents;
  if (!isMap(contents)) return { apiVersion: null, kind: null };
  const read = (key: string) => {
    const value = contents.get(key, true);
    return isScalar(value) && typeof value.value === 'string' ? value.value : null;
  };
  return { apiVersion: read('apiVersion'), kind: read('kind') };
}

/** Source range of a top-level scalar value (`kind: Deployment` → `Deployment`). */
export function topLevelValueRange(doc: ParsedDoc, key: string): [number, number] | null {
  const contents = doc.contents;
  if (!isMap(contents)) return null;
  const value = contents.get(key, true);
  return isScalar(value) && value.range ? [value.range[0], value.range[1]] : null;
}
