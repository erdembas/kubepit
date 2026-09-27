import type { PathSegment } from './fields';

/**
 * Line-based YAML structure for editor positions. Completion runs while
 * the document is half typed (a key without its colon, a dangling dash),
 * where a real parser gives up; block-style Kubernetes manifests are
 * fully described by indentation, dashes and `key:` markers, which is all
 * this module looks at. Flow style (`{a: b}`) yields no context.
 */

export interface DocBounds {
  /** 0-based first and last line of the document (separators excluded). */
  start: number;
  end: number;
}

const SEPARATOR = /^(---|\.\.\.)(\s|$)/;

/** The `---`-separated document around a 0-based line. */
export function documentAt(lines: readonly string[], line: number): DocBounds {
  let start = 0;
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--)
    if (SEPARATOR.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  let end = lines.length - 1;
  for (let i = Math.max(line + 1, start); i < lines.length; i++)
    if (SEPARATOR.test(lines[i] ?? '')) {
      end = i - 1;
      break;
    }
  return { start, end: Math.max(start, end) };
}

const unquote = (s: string) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
};

/** `apiVersion` and `kind` of a document (top-level keys only). */
export function documentHeader(
  lines: readonly string[],
  bounds: DocBounds,
): { apiVersion: string | null; kind: string | null } {
  let apiVersion: string | null = null;
  let kind: string | null = null;
  for (let i = bounds.start; i <= bounds.end; i++) {
    const m = /^(apiVersion|kind):[ \t]*("[^"]*"|'[^']*'|[^\s#]+)?/.exec(lines[i] ?? '');
    if (!m?.[2]) continue;
    if (m[1] === 'apiVersion') apiVersion ??= unquote(m[2]);
    else kind ??= unquote(m[2]);
  }
  return { apiVersion, kind };
}

export interface LineInfo {
  blank: boolean;
  /** Leading spaces. */
  indent: number;
  /** Columns of the `- ` markers, outermost first. */
  dashes: number[];
  /** Column where the content after the dashes starts. */
  keyCol: number;
  key: string | null;
  /** Text after `key:` (comment stripped, trimmed), or the scalar when there is no key. */
  value: string;
}

const KEY =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]},&*!|>%@`-][^#]*?|-[^\s#][^#]*?)[ \t]*:(?=[ \t]|$)(.*)$/;

function stripComment(value: string): string {
  if (value.startsWith('#')) return '';
  // A comment starts at " #" outside quotes; quoted values are left alone.
  if (/^["']/.test(value)) return value;
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

export function parseLine(text: string): LineInfo {
  const indent = /^ */.exec(text)?.[0].length ?? 0;
  const rest = text.slice(indent);
  if (!rest.trim() || rest.trimStart().startsWith('#'))
    return { blank: true, indent, dashes: [], keyCol: indent, key: null, value: '' };
  const dashes: number[] = [];
  let col = indent;
  let body = rest;
  for (let m = /^-( +|$)/.exec(body); m; m = /^-( +|$)/.exec(body)) {
    dashes.push(col);
    col += m[0].length;
    body = body.slice(m[0].length);
  }
  const km = KEY.exec(body);
  if (km)
    return {
      blank: false,
      indent,
      dashes,
      keyCol: col,
      key: unquote(km[1]!),
      value: stripComment(km[2]!.trim()),
    };
  return { blank: false, indent, dashes, keyCol: col, key: null, value: stripComment(body.trim()) };
}

/** Block scalar indicators (`|`, `>-`, `|2+`), optionally after an anchor or tag. */
function isBlockScalar(value: string): boolean {
  return /^(?:[&!]\S+\s+)*[|>][-+0-9]*$/.test(value);
}

/** Values that still let the key hold nested content on the following lines. */
function opensBlock(value: string): boolean {
  return value === '' || /^(?:[&!]\S+\s*)+$/.test(value);
}

type Entry = 'key' | 'item';

/**
 * Path of the node that holds an entry starting at `col` on `line`: a map
 * key (`entry: 'key'`) or a sequence item dash (`entry: 'item'`). Returns
 * `null` inside block scalars or malformed structure.
 */
export function parentPath(
  lines: readonly string[],
  line: number,
  col: number,
  entry: Entry,
  docStart = 0,
): PathSegment[] | null {
  const path: PathSegment[] = [];
  const enterItem = (info: LineInfo) => {
    for (let i = 0; i < info.dashes.length; i++) path.unshift(0);
    entry = 'item';
    col = info.dashes[0]!;
  };
  for (let i = line - 1; i >= docStart; i--) {
    const info = parseLine(lines[i] ?? '');
    if (info.blank) continue;
    if (entry === 'key') {
      if (info.indent >= col) continue;
      // Inside the list item this line opens (`- name: a` with siblings at `col`).
      if (info.dashes.length && info.keyCol === col) {
        enterItem(info);
        continue;
      }
      if (info.key !== null && info.keyCol < col) {
        if (!opensBlock(info.value)) return null;
        path.unshift(info.key);
        if (info.dashes.length) enterItem(info);
        else col = info.keyCol;
        continue;
      }
      if (info.dashes.length && info.key === null && info.value === '' && info.keyCol <= col) {
        enterItem(info);
        continue;
      }
      return null;
    }
    // entry === 'item': find the key that owns the sequence at `col`.
    if (info.indent > col) continue;
    if (info.dashes[0] === col) continue; // a sibling item
    if (info.key !== null && info.keyCol <= col) {
      if (!opensBlock(info.value)) return null;
      path.unshift(info.key);
      if (info.dashes.length) enterItem(info);
      else {
        entry = 'key';
        col = info.keyCol;
      }
      continue;
    }
    if (info.dashes.length && info.key === null && info.value === '' && info.keyCol <= col) {
      enterItem(info);
      continue;
    }
    return null;
  }
  // A document that is itself a sequence is not a manifest.
  return entry === 'key' ? path : null;
}

/**
 * Whether content at `col` on `line` lies inside a block scalar
 * (`script: |`) of an earlier key. Scalar text may look like YAML, so
 * plain lines are skipped until a key decides.
 */
export function inBlockScalar(
  lines: readonly string[],
  line: number,
  col: number,
  docStart = 0,
): boolean {
  for (let i = line - 1; i >= docStart; i--) {
    const info = parseLine(lines[i] ?? '');
    if (info.blank || info.indent >= col) continue;
    if (info.key !== null && isBlockScalar(info.value)) return true;
    if (info.key === null && info.dashes.length === 0) continue;
    col = info.indent;
    if (col === 0) break;
  }
  return false;
}

export type YamlContext =
  | {
      type: 'key';
      /** Path of the mapping the key belongs to. */
      path: PathSegment[];
      /** What was typed of the key so far. */
      prefix: string;
      /** Keys already present in that mapping. */
      siblings: string[];
    }
  | {
      type: 'value';
      /** Path of the key whose value is being typed. */
      path: PathSegment[];
      key: string;
      prefix: string;
    };

/** Keys of the mapping whose keys start at `col`, around `line`. */
export function siblingKeys(
  lines: readonly string[],
  line: number,
  col: number,
  bounds: DocBounds,
): string[] {
  const keys: string[] = [];
  // Upwards until a shallower line; `- name: a` opening the item still counts.
  for (let i = line - 1; i >= bounds.start; i--) {
    const info = parseLine(lines[i] ?? '');
    if (info.blank) continue;
    if (info.key !== null && info.keyCol === col) keys.push(info.key);
    if (info.indent < col) break;
  }
  for (let i = line + 1; i <= bounds.end; i++) {
    const info = parseLine(lines[i] ?? '');
    if (info.blank) continue;
    if (info.indent < col) break;
    if (info.key !== null && info.keyCol === col && !info.dashes.length) keys.push(info.key);
  }
  return keys;
}

/**
 * What is being typed at a 0-based `line`/`col`: a key of some mapping, or
 * the value of a key. `null` in comments, block scalars, flow collections
 * and malformed structure.
 */
export function contextAt(lines: readonly string[], line: number, col: number): YamlContext | null {
  const text = lines[line] ?? '';
  const before = text.slice(0, col);
  if (/(^|\s)#/.test(before)) return null;
  if (SEPARATOR.test(text)) return null;
  const bounds = documentAt(lines, line);

  const m = /^( *)((?:- +)*)(.*)$/.exec(before);
  if (!m) return null;
  const indent = m[1]!.length;
  if (inBlockScalar(lines, line, indent, bounds.start)) return null;
  const dashText = m[2]!;
  const rest = m[3]!;
  const dashes: number[] = [];
  for (let i = 0, c = indent; i < dashText.length;) {
    dashes.push(c);
    const step = /^- +/.exec(dashText.slice(i))![0].length;
    i += step;
    c += step;
  }
  const keyCol = indent + dashText.length;
  const parent = (): PathSegment[] | null => {
    if (!dashes.length) return parentPath(lines, line, keyCol, 'key', bounds.start);
    const outer = parentPath(lines, line, dashes[0]!, 'item', bounds.start);
    return outer && [...outer, ...dashes.map(() => 0)];
  };

  const vm =
    /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]},&*!|>%@`][^#]*?)[ \t]*:[ \t]+(.*)$/.exec(rest);
  if (vm) {
    const value = vm[2]!;
    if (/^[{[|>&*!]/.test(value)) return null;
    const path = parent();
    if (!path) return null;
    const key = unquote(vm[1]!);
    return { type: 'value', path: [...path, key], key, prefix: value.replace(/^["']/, '') };
  }
  if (!/^[\w.\-/"'$]*$/.test(rest)) return null;
  const path = parent();
  if (!path) return null;
  // A dash opens a new item: its mapping has no keys yet.
  const siblings = dashes.length ? [] : siblingKeys(lines, line, keyCol, bounds);
  return { type: 'key', path, prefix: rest.replace(/^["']/, ''), siblings };
}

/** Path of the key on `line` (the whole line, independent of the cursor), for hovers and explain. */
export function keyPathAt(lines: readonly string[], line: number): PathSegment[] | null {
  const info = parseLine(lines[line] ?? '');
  if (info.blank || info.key === null) return null;
  const bounds = documentAt(lines, line);
  if (inBlockScalar(lines, line, info.indent, bounds.start)) return null;
  const parent = info.dashes.length
    ? parentPath(lines, line, info.dashes[0]!, 'item', bounds.start)?.concat(
        info.dashes.map(() => 0),
      )
    : parentPath(lines, line, info.keyCol, 'key', bounds.start);
  return parent ? [...parent, info.key] : null;
}
