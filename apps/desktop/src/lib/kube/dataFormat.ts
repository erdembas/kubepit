import { isMap, isSeq, parseAllDocuments } from 'yaml';

/**
 * Syntax detection for ConfigMap / Secret values: the key name wins
 * (`application.yaml`, `.dockerconfigjson`), content sniffing decides the rest.
 * `code` formats open in Monaco; everything else is edited as plain text.
 */

export type DataFormatId =
  | 'yaml'
  | 'json'
  | 'toml'
  | 'ini'
  | 'properties'
  | 'xml'
  | 'html'
  | 'css'
  | 'shell'
  | 'dockerfile'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'lua'
  | 'sql'
  | 'markdown'
  | 'hcl'
  | 'pem'
  | 'text';

export interface DataFormat {
  id: DataFormatId;
  /** Format name; technical identifier, not translated (except plain text). */
  label: string;
  /** Monaco language id. */
  language: string;
  code: boolean;
}

const FORMATS: Record<DataFormatId, DataFormat> = {
  yaml: { id: 'yaml', label: 'YAML', language: 'yaml', code: true },
  json: { id: 'json', label: 'JSON', language: 'json', code: true },
  // Monaco ships no TOML grammar; INI highlighting covers tables and keys.
  toml: { id: 'toml', label: 'TOML', language: 'ini', code: true },
  ini: { id: 'ini', label: 'INI', language: 'ini', code: true },
  properties: { id: 'properties', label: 'Properties', language: 'ini', code: true },
  xml: { id: 'xml', label: 'XML', language: 'xml', code: true },
  html: { id: 'html', label: 'HTML', language: 'html', code: true },
  css: { id: 'css', label: 'CSS', language: 'css', code: true },
  shell: { id: 'shell', label: 'Shell', language: 'shell', code: true },
  dockerfile: { id: 'dockerfile', label: 'Dockerfile', language: 'dockerfile', code: true },
  python: { id: 'python', label: 'Python', language: 'python', code: true },
  javascript: { id: 'javascript', label: 'JavaScript', language: 'javascript', code: true },
  typescript: { id: 'typescript', label: 'TypeScript', language: 'typescript', code: true },
  lua: { id: 'lua', label: 'Lua', language: 'lua', code: true },
  sql: { id: 'sql', label: 'SQL', language: 'sql', code: true },
  markdown: { id: 'markdown', label: 'Markdown', language: 'markdown', code: true },
  hcl: { id: 'hcl', label: 'HCL', language: 'hcl', code: true },
  pem: { id: 'pem', label: 'PEM', language: 'plaintext', code: false },
  text: { id: 'text', label: 'Text', language: 'plaintext', code: false },
};

/** Every format, in picker order. */
export const DATA_FORMATS: readonly DataFormat[] = [
  FORMATS.text,
  FORMATS.yaml,
  FORMATS.json,
  FORMATS.toml,
  FORMATS.ini,
  FORMATS.properties,
  FORMATS.xml,
  FORMATS.html,
  FORMATS.css,
  FORMATS.shell,
  FORMATS.dockerfile,
  FORMATS.python,
  FORMATS.javascript,
  FORMATS.typescript,
  FORMATS.lua,
  FORMATS.sql,
  FORMATS.markdown,
  FORMATS.hcl,
  FORMATS.pem,
];

export function dataFormat(id: DataFormatId): DataFormat {
  return FORMATS[id];
}

/** Suffix after `.`, `-` or `_` (`config.yaml`, `ldap-toml`), or the whole key. */
const BY_NAME: Array<[RegExp, DataFormatId]> = [
  [/(?:^|[._-])ya?ml$/i, 'yaml'],
  [/(?:^|[._-])json$|^\.docker(?:config|cfg)(?:json)?$/i, 'json'],
  [/(?:^|[._-])toml$/i, 'toml'],
  [/\.(?:ini|cfg|cnf)$/i, 'ini'],
  [/\.(?:properties|env)$/i, 'properties'],
  [/\.(?:xml|xsd|xsl|xslt|svg|plist)$/i, 'xml'],
  [/\.html?$/i, 'html'],
  [/\.css$/i, 'css'],
  [/\.(?:sh|bash|zsh)$/i, 'shell'],
  [/(?:^|\.)dockerfile$|^dockerfile\./i, 'dockerfile'],
  [/\.py$/i, 'python'],
  [/\.(?:js|mjs|cjs)$/i, 'javascript'],
  [/\.ts$/i, 'typescript'],
  [/\.lua$/i, 'lua'],
  [/\.sql$/i, 'sql'],
  [/\.(?:md|markdown)$/i, 'markdown'],
  [/\.(?:tf|tfvars|hcl)$/i, 'hcl'],
  [/\.(?:pem|crt|cer|key|csr)$/i, 'pem'],
];

const PEM = /^-----BEGIN [A-Z0-9 ]+-----/;
const INI_SECTION = /^\s*\[[^\]\n]+\]\s*$/m;
const INI_PAIR = /^\s*[\w.-]+\s*=/m;
const PROPERTY_LINE = /^\s*[\w.\-/]+\s*[=]/;

function isJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

function isYaml(text: string): boolean {
  try {
    const docs = parseAllDocuments(text);
    if (!Array.isArray(docs) || !docs.length) return false;
    return (
      docs.every((d) => !d.errors.length) &&
      docs.some((d) => isMap(d.contents) || isSeq(d.contents))
    );
  } catch {
    return false;
  }
}

function sniff(value: string): DataFormatId {
  const text = value.trim();
  if (!text) return 'text';
  if (PEM.test(text)) return 'pem';
  if (/^#!.*\b(?:ba|z|da)?sh\b/.test(text)) return 'shell';
  if (/^#!.*\bpython/.test(text)) return 'python';
  if (isJson(text)) return 'json';
  // Everything below needs structure spread over several lines.
  if (!text.includes('\n')) return 'text';
  if (/^<\?xml\b/i.test(text)) return 'xml';
  if (/^<!doctype html|^<html\b/i.test(text)) return 'html';
  if (/^</.test(text) && /<\/[\w:-]+>\s*$/.test(text)) return 'xml';
  if (INI_SECTION.test(text) && INI_PAIR.test(text)) return 'ini';
  const lines = text.split('\n').filter((l) => l.trim() && !/^\s*[#!;]/.test(l));
  if (lines.length > 1 && lines.every((l) => PROPERTY_LINE.test(l))) return 'properties';
  if (isYaml(text)) return 'yaml';
  return 'text';
}

export function detectDataFormat(key: string, value: string): DataFormat {
  const byName = BY_NAME.find(([re]) => re.test(key))?.[1];
  return FORMATS[byName ?? sniff(value)];
}

/** Pretty-print JSON for display, preserving every token in the original value. */
export function formatDataPreview(format: DataFormatId, text: string): string {
  if (format !== 'json') return text;
  try {
    // Validate only: reserializing would round large numbers and lose duplicate keys.
    JSON.parse(text);
  } catch {
    return text;
  }

  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const parts: string[] = [];
  let depth = 0;
  const newline = () => parts.push('\n', '  '.repeat(depth));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{' || token === '[') {
      parts.push(token);
      depth++;
      if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') newline();
      parts.push(token);
    } else if (token === ',') {
      parts.push(token);
      newline();
    } else {
      parts.push(token === ':' ? ': ' : token);
    }
  }
  return parts.join('');
}

/** First syntax problem for formats we can check, else null. */
export function validateData(format: DataFormatId, text: string): string | null {
  if (!text.trim()) return null;
  if (format === 'json') {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  if (format === 'yaml') {
    try {
      for (const doc of parseAllDocuments(text)) {
        const err = doc.errors[0];
        // First line only; the rest is a code frame.
        if (err) return err.message.split('\n')[0]!.replace(/:\s*$/, '');
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

/** Keys allowed in ConfigMap / Secret data (`[-._a-zA-Z0-9]+`, ≤ 253 chars). */
export function isValidDataKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 253 &&
    /^[-._a-zA-Z0-9]+$/.test(key) &&
    key !== '.' &&
    key !== '..'
  );
}

/** UTF-8 aware base64 for Secret values. */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Decoded Secret value, or null when it is not valid UTF-8 text (binary). */
export function decodeBase64Text(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control bytes other than whitespace mean a binary payload (gzip, keystores…).
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}
