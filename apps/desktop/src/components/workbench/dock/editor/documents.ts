import { parseAllDocuments, type YAMLError } from 'yaml';

export interface YamlIssue {
  message: string;
  /** 1-based, absolute in the editor text. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface YamlDocument {
  /** 1-based position among non-empty documents. */
  index: number;
  /** Source slice sent to the API server on its own. */
  source: string;
  kind: string | null;
  name: string | null;
  namespace: string | null;
  issues: YamlIssue[];
}

function toIssue(err: YAMLError): YamlIssue {
  const [from, to] = err.linePos ?? [];
  return {
    message: err.message.split('\n')[0]?.trim() ?? err.message,
    line: from?.line ?? 1,
    col: from?.col ?? 1,
    endLine: to?.line ?? from?.line ?? 1,
    endCol: to?.col ?? (from?.col ?? 1) + 1,
  };
}

/**
 * Split a multi-document manifest into the documents that carry content.
 * Each is applied separately so the editor can report per-document results
 * (and objects are created in order, e.g. a Namespace before its workloads).
 */
export function splitDocuments(text: string): YamlDocument[] {
  const docs: YamlDocument[] = [];
  for (const doc of parseAllDocuments(text)) {
    const [start, , end] = doc.range;
    const issues = doc.errors.map(toIssue);
    let value: unknown = null;
    if (issues.length === 0) {
      try {
        value = doc.toJS();
      } catch (err) {
        issues.push({ message: String(err), line: 1, col: 1, endLine: 1, endCol: 2 });
      }
      if (issues.length === 0 && (value === null || value === undefined)) continue;
    }
    const obj = (value && typeof value === 'object' ? value : {}) as {
      kind?: unknown;
      metadata?: { name?: unknown; namespace?: unknown };
    };
    docs.push({
      index: docs.length + 1,
      source: text.slice(start, end),
      kind: typeof obj.kind === 'string' ? obj.kind : null,
      name: typeof obj.metadata?.name === 'string' ? obj.metadata.name : null,
      namespace: typeof obj.metadata?.namespace === 'string' ? obj.metadata.namespace : null,
      issues,
    });
  }
  return docs;
}

/** Syntax problems of the whole text, for editor markers. */
export function yamlIssues(text: string): YamlIssue[] {
  try {
    return parseAllDocuments(text).flatMap((doc) => doc.errors.map(toIssue));
  } catch {
    return [];
  }
}

export function isConflictError(message: string): boolean {
  return /\bconflict\b|the object has been modified|\b409\b/i.test(message);
}
