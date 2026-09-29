import YAML from 'yaml';
import { parseMarkdown, type Block } from '@/lib/markdown';
import { placeholdersIn, unrestorableMarkers } from './placeholders';

/**
 * Suggestions in an assistant answer (spec D9): fenced code blocks the UI
 * offers actions for. ```` ```yaml ```` holds complete or partial manifests
 * (each document with `apiVersion`, `kind` and `metadata.name`), which go
 * through the create editor's dry-run review; ```` ```sh ```` /
 * ```` ```kubectl ```` holds kubectl commands (shown and copied, never run);
 * ```` ```promql ```` and ```` ```logql ```` open their dock tabs. Anything
 * else stays plain code.
 */

export interface SuggestedObject {
  apiVersion: string;
  kind: string;
  namespace: string | null;
  name: string;
}

export type AiSuggestion =
  | {
      kind: 'manifest';
      yaml: string;
      objects: SuggestedObject[];
      /** Carries `__SECRET__` / `__TOKEN__`: never applied. */
      blocked: 'secret' | null;
      /** `__IP_n__` / `__HOST_n__` to restore before use. */
      placeholders: string[];
    }
  | { kind: 'kubectl'; command: string; blocked: 'secret' | null; placeholders: string[] }
  | { kind: 'promql'; query: string }
  | { kind: 'logql'; query: string };

const YAML_LANGS = new Set(['yaml', 'yml']);
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'kubectl']);

function manifest(text: string): AiSuggestion | null {
  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(text) as YAML.Document.Parsed[];
  } catch {
    return null;
  }
  const objects: SuggestedObject[] = [];
  for (const doc of docs) {
    if (doc.errors.length) return null;
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) continue;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const obj = value as { apiVersion?: unknown; kind?: unknown; metadata?: unknown };
    const meta = (obj.metadata ?? {}) as { name?: unknown; namespace?: unknown };
    if (
      typeof obj.apiVersion !== 'string' ||
      typeof obj.kind !== 'string' ||
      typeof meta.name !== 'string' ||
      !obj.apiVersion ||
      !obj.kind ||
      !meta.name
    )
      return null;
    objects.push({
      apiVersion: obj.apiVersion,
      kind: obj.kind,
      namespace: typeof meta.namespace === 'string' && meta.namespace ? meta.namespace : null,
      name: meta.name,
    });
  }
  if (!objects.length) return null;
  return {
    kind: 'manifest',
    yaml: text,
    objects,
    blocked: unrestorableMarkers(text).length ? 'secret' : null,
    placeholders: placeholdersIn(text),
  };
}

function kubectl(text: string): AiSuggestion | null {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd().replace(/^\s*\$\s+/, ''))
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (!lines.length || !/^kubectl(?:\s|$)/.test(lines[0]!.trimStart())) return null;
  const command = lines.join('\n');
  return {
    kind: 'kubectl',
    command,
    blocked: unrestorableMarkers(command).length ? 'secret' : null,
    placeholders: placeholdersIn(command),
  };
}

/** The suggestion a fenced code block of `lang` holds, or null. */
export function suggestionForCode(lang: string, text: string): AiSuggestion | null {
  const language = lang.trim().toLowerCase();
  const body = text.replace(/\s+$/, '');
  if (YAML_LANGS.has(language)) return manifest(body);
  if (SHELL_LANGS.has(language)) return kubectl(body);
  if (language === 'promql' || language === 'logql') {
    const query = body.trim();
    return query ? { kind: language, query } : null;
  }
  return null;
}

function codeBlocks(blocks: Block[], out: { lang: string; v: string }[]) {
  for (const block of blocks) {
    if (block.t === 'code') out.push(block);
    else if (block.t === 'quote') codeBlocks(block.c, out);
    else if (block.t === 'list') for (const item of block.items) codeBlocks(item.c, out);
  }
  return out;
}

/** Every suggestion of a Markdown answer, in order. */
export function extractSuggestions(markdown: string): AiSuggestion[] {
  return codeBlocks(parseMarkdown(markdown), []).flatMap((block) => {
    const suggestion = suggestionForCode(block.lang, block.v);
    return suggestion ? [suggestion] : [];
  });
}
