/**
 * Small, safe Markdown parser for chart READMEs (CommonMark + GFM subset):
 * ATX/setext headings, paragraphs, emphasis, strikethrough, inline code,
 * fenced and indented code, nested ordered/bullet/task lists, blockquotes,
 * pipe tables, horizontal rules, inline/reference/auto links and images.
 *
 * It produces a plain AST; the renderer turns it into React elements, so
 * nothing is ever injected as HTML. Raw HTML is not rendered: comments are
 * dropped, tags are stripped (their text stays), `<br>` becomes a line
 * break and `<img>` an image node (shown as an alt-text link).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'em' | 'strong' | 'del'; c: Inline[] }
  | { t: 'link'; href: string | null; title: string | null; c: Inline[] }
  | { t: 'image'; src: string; alt: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** `true`/`false` for task items (`- [x]`), `null` otherwise. */
  task: boolean | null;
  c: Block[];
}

export type Block =
  | { t: 'heading'; level: number; c: Inline[]; id: string }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

interface Ref {
  href: string;
  title: string | null;
}

interface Ctx {
  refs: Map<string, Ref>;
  slugs: Map<string, number>;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const REF_DEF =
  /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

interface Marker {
  indent: number;
  ordered: boolean;
  start: number;
  /** Column where the item's content starts. */
  content: number;
  rest: string;
}

function listMarker(line: string): Marker | null {
  const m = /^( *)([-+*]|\d{1,9}[.)])( +|$)(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1]!.length;
  const marker = m[2]!;
  const spaces = m[3]!.length;
  const rest = m[4]!;
  if (!rest.trim() && !spaces) {
    // A bare marker ("-") is an empty item only when nothing follows.
    if (line.trim() !== marker) return null;
  }
  const gap = !rest.trim() ? 1 : spaces > 4 ? 1 : spaces;
  const ordered = /\d/.test(marker);
  return {
    indent,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    content: indent + marker.length + gap,
    rest: spaces > 4 ? `${' '.repeat(spaces - 1)}${rest}` : rest,
  };
}

/** Lines that end a paragraph (without a blank line in between). */
function interrupts(line: string): boolean {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const marker = listMarker(line);
  return (
    !!marker && marker.indent < 4 && !!marker.rest.trim() && (!marker.ordered || marker.start === 1)
  );
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '`') {
      inCode = inCode ? 0 : 1;
      cell += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function slugify(ctx: Ctx, inlines: Inline[]): string {
  const base =
    plainText(inlines)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-') || 'section';
  const seen = ctx.slugs.get(base) ?? 0;
  ctx.slugs.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

export function plainText(inlines: Inline[]): string {
  return inlines
    .map((n) =>
      n.t === 'text' || n.t === 'code'
        ? n.v
        : n.t === 'image'
          ? n.alt
          : n.t === 'br'
            ? ' '
            : plainText(n.c),
    )
    .join('');
}

function parseBlocks(lines: string[], ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marks = fence[2]!;
      const close = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      i++;
      blocks.push({ t: 'code', lang: fence[3] ?? '', v: body.join('\n') });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      const c = parseInline(atx[2] ?? '', ctx);
      blocks.push({ t: 'heading', level: atx[1]!.length, c, id: slugify(ctx, c) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const q = QUOTE.exec(l);
        if (q) inner.push(q[1]!);
        else if (l.trim() && inner.length && inner[inner.length - 1]!.trim() && !interrupts(l))
          inner.push(l); // lazy continuation of a quoted paragraph
        else break;
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(inner, ctx) });
      continue;
    }
    const marker = listMarker(line);
    if (marker && marker.indent < 4) {
      i = parseList(lines, i, marker, ctx, blocks);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]!).map((cell) =>
        cell.startsWith(':') && cell.endsWith(':')
          ? 'center'
          : cell.endsWith(':')
            ? 'right'
            : cell.startsWith(':')
              ? 'left'
              : null,
      );
      if (align.length === head.length) {
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, col) => parseInline(cells[col] ?? '', ctx)));
          i++;
        }
        blocks.push({ t: 'table', align, head: head.map((h) => parseInline(h, ctx)), rows });
        continue;
      }
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (!lines[i]!.trim() || indentOf(lines[i]!) >= 4)) {
        body.push(lines[i]!.slice(4));
        i++;
      }
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      blocks.push({ t: 'code', lang: '', v: body.join('\n') });
      continue;
    }
    const para: string[] = [line.trimStart()];
    i++;
    let setext = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) break;
      const s = SETEXT.exec(l);
      if (s) {
        setext = s[1]![0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(l) || (l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? ''))) break;
      para.push(l.trimStart());
      i++;
    }
    const c = parseInline(para.join('\n').replace(/[ \t]+$/, ''), ctx);
    if (setext) blocks.push({ t: 'heading', level: setext, c, id: slugify(ctx, c) });
    else if (plainText(c).trim() || c.some((n) => n.t === 'image'))
      blocks.push({ t: 'paragraph', c });
  }
  return blocks;
}

function parseList(lines: string[], start: number, first: Marker, ctx: Ctx, out: Block[]) {
  const items: ListItem[] = [];
  let loose = false;
  let i = start;
  let gapBefore = false;
  while (i < lines.length) {
    const marker = listMarker(lines[i]!);
    if (!marker || marker.ordered !== first.ordered || marker.indent >= first.content) break;
    if (gapBefore) loose = true;
    const body: string[] = [marker.rest];
    i++;
    let blank = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        body.push('');
        blank = true;
        i++;
        continue;
      }
      const indent = indentOf(l);
      if (indent >= marker.content) {
        body.push(l.slice(marker.content));
        i++;
        continue;
      }
      const nested = listMarker(l);
      if (nested && nested.indent > marker.indent && !blank) {
        // Sloppily indented sub-list (less than the content column).
        body.push(l.slice(indent));
        i++;
        continue;
      }
      if (!nested && !blank && !interrupts(l)) {
        body.push(l.trimStart()); // lazy paragraph continuation
        i++;
        continue;
      }
      break;
    }
    let trailing = 0;
    while (body.length && !body[body.length - 1]!.trim()) {
      body.pop();
      trailing++;
    }
    if (body.some((l, idx) => !l.trim() && idx > 0 && idx < body.length - 1)) loose = true;
    gapBefore = trailing > 0;
    let task: boolean | null = null;
    const check = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
    if (check) {
      task = check[1] !== ' ';
      body[0] = body[0]!.slice(check[0].length);
    }
    items.push({ task, c: parseBlocks(body, ctx) });
  }
  out.push({ t: 'list', ordered: first.ordered, start: first.start, loose, items });
  return i;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  larr: '←',
  rarr: '→',
  check: '✓',
};

function decodeEntity(text: string, at: number): [string, number] | null {
  const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/.exec(text.slice(at, at + 12));
  if (!m) return null;
  const name = m[1]!;
  let value: string | undefined;
  if (name.startsWith('#')) {
    const code =
      name[1] === 'x' || name[1] === 'X'
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
    value = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
  } else value = ENTITIES[name];
  return value === undefined ? null : [value, m[0].length];
}

/** Keep only link targets that are safe to open externally or scroll to. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith('#')) return href;
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** `(dest "title")` right after `]`. Returns the parsed parts and the end index. */
function linkTail(
  text: string,
  at: number,
): { href: string; title: string | null; end: number } | null {
  if (text[at] !== '(') return null;
  let i = at + 1;
  while (text[i] === ' ' || text[i] === '\n') i++;
  let href = '';
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close < 0) return null;
    href = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\\' && i + 1 < text.length) {
        href += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (!depth) break;
        depth--;
      } else if (ch === ' ' || ch === '\n') break;
      href += ch;
      i++;
    }
  }
  while (text[i] === ' ' || text[i] === '\n') i++;
  let title: string | null = null;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closeCh = quote === '(' ? ')' : quote;
    const close = text.indexOf(closeCh, i + 1);
    if (close < 0) return null;
    title = text.slice(i + 1, close);
    i = close + 1;
    while (text[i] === ' ' || text[i] === '\n') i++;
  }
  if (text[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

/** Index of the `]` matching the `[` at `at`, skipping code spans. */
function closingBracket(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > 0) i = close;
    } else if (ch === '[') depth++;
    else if (ch === ']' && !--depth) return i;
  }
  return -1;
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

function parseInline(text: string, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '\n') {
        flush();
        out.push({ t: 'br' });
        i += 2;
        continue;
      }
      if (/[!-/:-@[-`{-~]/.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        out.push({ t: 'br' });
      } else buf = `${buf.replace(/ +$/, '')} `;
      i++;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close >= 0 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close >= 0) {
        let code = text.slice(i + run, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        flush();
        out.push({ t: 'code', v: code });
        i = close + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }
    if (ch === '&') {
      const entity = decodeEntity(text, i);
      if (entity) {
        buf += entity[0];
        i += entity[1];
        continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) {
        flush();
        const href = auto[1]!;
        out.push({
          t: 'link',
          href: safeHref(href),
          title: null,
          c: [{ t: 'text', v: href.replace(/^mailto:/i, '') }],
        });
        i += auto[0].length;
        continue;
      }
      const tag = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/.exec(text.slice(i));
      if (tag) {
        const name = tag[1]!.toLowerCase();
        if (name === 'br') {
          flush();
          out.push({ t: 'br' });
        } else if (name === 'img') {
          const src = attr(tag[0], 'src');
          if (src) {
            flush();
            out.push({ t: 'image', src, alt: attr(tag[0], 'alt') ?? '' });
          }
        }
        i += tag[0].length;
        continue;
      }
    }
    if (
      (ch === '[' || (ch === '!' && text[i + 1] === '[')) &&
      !(ch === '[' && text[i - 1] === '!')
    ) {
      const open = ch === '!' ? i + 1 : i;
      const close = closingBracket(text, open);
      if (close > open) {
        const label = text.slice(open + 1, close);
        let target: Ref | null = null;
        let end = close + 1;
        const tail = linkTail(text, close + 1);
        if (tail) {
          target = { href: tail.href, title: tail.title };
          end = tail.end;
        } else {
          const ref = /^\[([^\]]*)\]/.exec(text.slice(close + 1));
          const key = normalizeLabel(ref && ref[1] ? ref[1] : label);
          const def = ctx.refs.get(key);
          if (def) {
            target = def;
            end = ref ? close + 1 + ref[0].length : close + 1;
          }
        }
        if (target) {
          flush();
          if (ch === '!')
            out.push({ t: 'image', src: target.href, alt: plainText(parseInline(label, ctx)) });
          else
            out.push({
              t: 'link',
              href: safeHref(target.href),
              title: target.title,
              c: parseInline(label, ctx),
            });
          i = end;
          continue;
        }
      }
    }
    if (ch === '*' || ch === '_' || (ch === '~' && text[i + 1] === '~')) {
      let run = 1;
      while (text[i + run] === ch) run++;
      const size = ch === '~' ? 2 : Math.min(run, 3);
      const delim = ch.repeat(size);
      const after = text[i + run];
      const before = text[i - 1];
      const canOpen =
        after !== undefined && !/\s/.test(after) && !(ch === '_' && isWordChar(before));
      if (canOpen && (ch !== '~' || run === 2)) {
        let close = -1;
        for (let j = i + run; j < text.length; j++) {
          if (text[j] === '\\') {
            j++;
            continue;
          }
          if (text[j] === '`') {
            const skip = text.indexOf('`', j + 1);
            if (skip > 0) j = skip;
            continue;
          }
          if (
            text.startsWith(delim, j) &&
            !/\s/.test(text[j - 1] ?? ' ') &&
            text[j - 1] !== ch &&
            text[j + size] !== ch
          ) {
            if (ch === '_' && isWordChar(text[j + size])) continue;
            close = j;
            break;
          }
        }
        if (close > 0) {
          if (run > size) buf += ch.repeat(run - size);
          flush();
          const inner = parseInline(text.slice(i + run, close), ctx);
          const node: Inline =
            ch === '~'
              ? { t: 'del', c: inner }
              : size === 1
                ? { t: 'em', c: inner }
                : size === 2
                  ? { t: 'strong', c: inner }
                  : { t: 'strong', c: [{ t: 'em', c: inner }] };
          out.push(node);
          i = close + size;
          continue;
        }
      }
      buf += ch.repeat(run);
      i += run;
      continue;
    }
    if (ch === 'h' && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const url = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/.exec(text.slice(i));
      if (url) {
        flush();
        out.push({ t: 'link', href: url[0], title: null, c: [{ t: 'text', v: url[0] }] });
        i += url[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const ctx: Ctx = { refs: new Map(), slugs: new Map() };
  const text = source.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines: string[] = [];
  let fenced: RegExp | null = null;
  for (const raw of text.split('\n')) {
    const line = expandTabs(raw);
    // Reference definitions are collected up front (outside code fences).
    if (fenced) {
      if (fenced.test(line)) fenced = null;
    } else {
      const fence = FENCE.exec(line);
      if (fence) {
        const marks = fence[2]!;
        fenced = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}[ \\t]*$`);
      } else {
        const def = REF_DEF.exec(line);
        if (def) {
          const key = normalizeLabel(def[1]!);
          if (!ctx.refs.has(key))
            ctx.refs.set(key, { href: def[2]!, title: def[3] ?? def[4] ?? def[5] ?? null });
          continue;
        }
      }
    }
    lines.push(line);
  }
  return parseBlocks(lines, ctx);
}
