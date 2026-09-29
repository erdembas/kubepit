import YAML from 'yaml';
import { parseMarkdown, type Block } from '@/lib/markdown';
import { placeholdersIn, unrestorableMarkers } from './placeholders';

/**
 * Suggestions in an assistant answer (spec D9): fenced code blocks the UI
 * offers actions for. ```` ```yaml ```` holds complete or partial manifests
 * (each document with `apiVersion`, `kind` and `metadata.name`), which go
 * through the create editor's dry-run review; ```` ```sh ```` /
 * ```` ```kubectl ```` / ```` ```console ```` holds kubectl commands (shown
 * and copied, never run); ```` ```promql ```` and ```` ```logql ```` open
 * their dock tabs. Anything else stays plain code.
 *
 * Model output is untrusted: nothing here throws (aliases are capped and
 * every parse is guarded), and a manifest that could carry a secret the
 * model never saw is blocked.
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
      /**
       * Never applied: it carries a `__SECRET__` / `__TOKEN__` marker, or it
       * is a Secret-like object with values (the model never saw real ones).
       */
      blocked: 'secret' | null;
      /** `__IP_n__` / `__HOST_n__` to restore before use. */
      placeholders: string[];
    }
  | { kind: 'kubectl'; command: string; blocked: 'secret' | null; placeholders: string[] }
  | { kind: 'promql'; query: string }
  | { kind: 'logql'; query: string };

const YAML_LANGS = new Set(['yaml', 'yml']);
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'kubectl']);
/** Aliases resolved per document; more is an alias bomb, not a manifest. */
const MAX_ALIASES = 20;
/** Secret values: the backend redacts them all, so any value is a guess. */
const SECRET_FIELDS = ['data', 'stringData', 'binaryData', 'encryptedData'] as const;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `Secret`, `SealedSecret`, `ExternalSecret`, … (like `history/redact.rs::secret_like`). */
export function secretLike(kind: string): boolean {
  return kind.toLowerCase().endsWith('secret');
}

function hasValues(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) ? Object.keys(value).length > 0 : true;
}

/** A Secret-like object with any `data` / `stringData` / `binaryData` / `encryptedData`. */
function carriesSecretValues(obj: Json): boolean {
  const spec = isRecord(obj.spec) ? obj.spec : {};
  return SECRET_FIELDS.some((field) => hasValues(obj[field]) || hasValues(spec[field]));
}

function manifest(text: string): AiSuggestion | null {
  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(text) as YAML.Document.Parsed[];
  } catch {
    return null;
  }
  if (!Array.isArray(docs)) return null;
  const objects: SuggestedObject[] = [];
  let secretValues = false;
  for (const doc of docs) {
    if (doc.errors.length) return null;
    let value: unknown;
    try {
      // Unresolved aliases, cross-document merge keys and alias bombs throw here.
      value = doc.toJS({ maxAliasCount: MAX_ALIASES });
    } catch {
      return null;
    }
    if (value === null || value === undefined) continue;
    if (!isRecord(value)) return null;
    const meta = isRecord(value.metadata) ? value.metadata : {};
    const { apiVersion, kind } = value;
    if (
      typeof apiVersion !== 'string' ||
      typeof kind !== 'string' ||
      typeof meta.name !== 'string' ||
      !apiVersion ||
      !kind ||
      !meta.name
    )
      return null;
    if (secretLike(kind) && carriesSecretValues(value)) secretValues = true;
    objects.push({
      apiVersion,
      kind,
      namespace: typeof meta.namespace === 'string' && meta.namespace ? meta.namespace : null,
      name: meta.name,
    });
  }
  if (!objects.length) return null;
  return {
    kind: 'manifest',
    yaml: text,
    objects,
    blocked: secretValues || unrestorableMarkers(text).length ? 'secret' : null,
    placeholders: placeholdersIn(text),
  };
}

const PROMPT_RE = /^\s*\$ /;
const HEREDOC_RE = /<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/;

/**
 * The lines to copy: the block as written, minus `$ ` prompts. In a
 * `console` block only prompted lines (and their `\` continuations and
 * heredoc bodies) are commands; the rest is output. Heredoc bodies are
 * kept verbatim.
 */
function commandLines(text: string, console: boolean): string[] {
  const out: string[] = [];
  let heredoc: string | null = null;
  let continued = false;
  for (const line of text.split('\n')) {
    if (heredoc !== null) {
      out.push(line);
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const prompt = PROMPT_RE.exec(line);
    if (!prompt && console && !continued) continue;
    const command = prompt ? line.slice(prompt[0].length) : line;
    out.push(command);
    continued = /\\\s*$/.test(command);
    heredoc = HEREDOC_RE.exec(command)?.[1] ?? null;
  }
  while (out.length && !out[0]!.trim()) out.shift();
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

function kubectl(text: string, language: string): AiSuggestion | null {
  const lines = commandLines(text, language === 'console');
  // Comments and blank lines only matter for detection: the first command must be kubectl.
  const first = lines.find((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (!first || !/^kubectl(?:\s|$)/.test(first.trimStart())) return null;
  const command = lines.join('\n');
  return {
    kind: 'kubectl',
    command,
    blocked: unrestorableMarkers(command).length ? 'secret' : null,
    placeholders: placeholdersIn(command),
  };
}

function suggestion(lang: string, text: string): AiSuggestion | null {
  const language = lang.trim().toLowerCase();
  const body = text.replace(/\s+$/, '');
  if (YAML_LANGS.has(language)) return manifest(body);
  if (SHELL_LANGS.has(language)) return kubectl(body, language);
  if (language === 'promql' || language === 'logql') {
    const query = body.trim();
    return query ? { kind: language, query } : null;
  }
  return null;
}

/** The suggestion a fenced code block of `lang` holds, or null. Never throws. */
export function suggestionForCode(lang: string, text: string): AiSuggestion | null {
  try {
    return suggestion(lang, text);
  } catch {
    return null;
  }
}

function codeBlocks(blocks: Block[], out: { lang: string; v: string }[]) {
  for (const block of blocks) {
    if (block.t === 'code') out.push(block);
    else if (block.t === 'quote') codeBlocks(block.c, out);
    else if (block.t === 'list') for (const item of block.items) codeBlocks(item.c, out);
  }
  return out;
}

/** Every suggestion of a Markdown answer, in order. Never throws. */
export function extractSuggestions(markdown: string): AiSuggestion[] {
  let blocks: { lang: string; v: string }[];
  try {
    blocks = codeBlocks(parseMarkdown(markdown), []);
  } catch {
    return [];
  }
  return blocks.flatMap((block) => {
    const found = suggestionForCode(block.lang, block.v);
    return found ? [found] : [];
  });
}
