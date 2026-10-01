const sourceBase = 'https://github.com/erdembas/kubepit/blob/main/';

/** Release prose is rendered as React nodes, never HTML. Relative document
 * links refer to the source repository rather than arbitrary site routes. */
export function changelogHref(raw) {
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw) || raw.startsWith('//')) return null;
  if (/^#[A-Za-z0-9_.%-]+$/.test(raw)) return raw;
  try {
    const url = new URL(raw, sourceBase);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function changelogInlines(source, depth = 0) {
  if (depth > 4) return [{ type: 'text', text: source }];
  const nodes = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) nodes.push({ type: 'text', text: source.slice(cursor, match.index) });
    if (match[1] !== undefined) nodes.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined)
      nodes.push({ type: 'strong', children: changelogInlines(match[2], depth + 1) });
    else {
      const href = changelogHref(match[4]);
      const children = changelogInlines(match[3], depth + 1);
      nodes.push(href ? { type: 'link', href, children } : { type: 'span', children });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push({ type: 'text', text: source.slice(cursor) });
  return nodes;
}

/** The changelog deliberately uses a small document vocabulary: paragraphs,
 * section headings and flat bullet lists, with wrapped lines preserved. */
export function changelogBlocks(source) {
  const blocks = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line.trim()) {
      cursor++;
      continue;
    }
    const heading = /^#{3,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', children: changelogInlines(heading[1]) });
      cursor++;
    } else if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (cursor < lines.length && /^[-*]\s+/.test(lines[cursor])) {
        let text = lines[cursor++].replace(/^[-*]\s+/, '');
        while (cursor < lines.length && /^\s+\S/.test(lines[cursor]))
          text += ` ${lines[cursor++].trim()}`;
        items.push(changelogInlines(text));
      }
      blocks.push({ type: 'list', items });
    } else {
      const paragraph = [lines[cursor++].trim()];
      while (
        cursor < lines.length &&
        lines[cursor].trim() &&
        !/^(?:#{3,6}\s|[-*]\s)/.test(lines[cursor])
      )
        paragraph.push(lines[cursor++].trim());
      blocks.push({ type: 'paragraph', children: changelogInlines(paragraph.join(' ')) });
    }
  }
  return blocks;
}
