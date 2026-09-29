import * as i18n from '@/i18n';
import { Fragment, useMemo, useRef, type ReactNode } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { parseMarkdown, safeHref, type Block, type Inline } from '@/lib/markdown';
import { openExternal } from '../actions/openExternal';
import { CodeBlock } from '../details/primitives';

/**
 * Safe Markdown view (chart READMEs). The source is parsed into an AST by
 * `lib/markdown.ts` and rendered as React elements only — no HTML is ever
 * injected. External links open in the system browser, `#anchor` links
 * scroll within the document, images are shown as alt-text links (remote
 * images are blocked by the CSP anyway).
 */
type RenderCode = (lang: string, text: string) => ReactNode | null;
export function Markdown({
  source,
  className,
  renderCode,
  variant = 'readme',
}: {
  source: string;
  className?: string;
  renderCode?: RenderCode;
  variant?: 'readme' | 'chat';
}) {
  i18n.useLocale();
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const root = useRef<HTMLDivElement>(null);
  const follow = (href: string) => {
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      root.current
        ?.querySelector<HTMLElement>(`[data-md-anchor="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    void openExternal(href);
  };
  return (
    <div ref={root} className={cn('text-fg-muted min-w-0 text-[12.5px] leading-[1.65]', className)}>
      <Blocks
        blocks={blocks}
        follow={follow}
        tight={false}
        renderCode={renderCode}
        chat={variant === 'chat'}
      />
    </div>
  );
}

type Follow = (href: string) => void;

const HEADING = [
  '',
  'text-fg mt-6 mb-3 border-border/60 border-b pb-2 text-[17px] font-semibold first:mt-0',
  'text-fg mt-6 mb-2.5 border-border/50 border-b pb-1.5 text-[15px] font-semibold first:mt-0',
  'text-fg mt-5 mb-2 text-[13.5px] font-semibold first:mt-0',
  'text-fg mt-4 mb-1.5 text-[12.5px] font-semibold first:mt-0',
  'text-fg mt-4 mb-1.5 text-[12px] font-semibold first:mt-0',
  'text-fg-dim mt-4 mb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase first:mt-0',
];

function Blocks({
  blocks,
  follow,
  tight,
  renderCode,
  chat,
}: {
  blocks: Block[];
  follow: Follow;
  tight: boolean;
  renderCode?: RenderCode;
  chat?: boolean;
}) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          follow={follow}
          tight={tight}
          renderCode={renderCode}
          chat={chat}
        />
      ))}
    </>
  );
}

function BlockView({
  block,
  follow,
  tight,
  renderCode,
  chat,
}: {
  block: Block;
  follow: Follow;
  tight: boolean;
  renderCode?: RenderCode;
  chat?: boolean;
}) {
  switch (block.t) {
    case 'heading': {
      const Tag = `h${Math.min(block.level, 6)}` as 'h1';
      return (
        <Tag
          data-md-anchor={block.id}
          className={cn(
            chat ? 'text-fg mt-3 mb-1 text-[13px] font-semibold first:mt-0' : HEADING[block.level],
            'scroll-mt-3',
          )}
        >
          <Inlines nodes={block.c} follow={follow} />
        </Tag>
      );
    }
    case 'paragraph':
      return tight ? (
        <div className="my-0.5">
          <Inlines nodes={block.c} follow={follow} />
        </div>
      ) : (
        <p className="my-2.5 break-words">
          <Inlines nodes={block.c} follow={follow} />
        </p>
      );
    case 'code':
      return (
        <div className="my-3">
          {renderCode?.(block.lang, block.v) ?? (
            <CodeBlock text={block.v} maxHeight="max-h-[480px]" />
          )}
        </div>
      );
    case 'quote':
      return (
        <blockquote className="border-border-strong/70 bg-fg/[0.02] text-fg-muted my-3 rounded-r-md border-l-2 py-0.5 pr-3 pl-3 [&>*:first-child]:mt-1.5 [&>*:last-child]:mb-1.5">
          <Blocks
            blocks={block.c}
            follow={follow}
            tight={false}
            renderCode={renderCode}
            chat={chat}
          />
        </blockquote>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      const task = block.items.some((item) => item.task !== null);
      return (
        <Tag
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn(
            'my-2 pl-5',
            block.ordered ? 'list-decimal' : task ? 'list-none pl-1' : 'list-disc',
            'marker:text-fg-dim [&_ol]:my-1 [&_ul]:my-1',
          )}
        >
          {block.items.map((item, i) => (
            <li key={i} className={cn('pl-0.5', block.loose && 'my-1')}>
              {item.task !== null ? (
                <span className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={item.task}
                    readOnly
                    disabled
                    aria-label={item.task ? i18n.t('Done') : i18n.t('Not done')}
                    className="accent-accent mt-[5px]"
                  />
                  <span className="min-w-0 flex-1">
                    <Blocks
                      blocks={item.c}
                      follow={follow}
                      tight={!block.loose}
                      renderCode={renderCode}
                      chat={chat}
                    />
                  </span>
                </span>
              ) : (
                <Blocks
                  blocks={item.c}
                  follow={follow}
                  tight={!block.loose}
                  renderCode={renderCode}
                  chat={chat}
                />
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div className="border-border/60 my-3 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-left text-[11.5px]">
            <thead>
              <tr className="border-border/60 bg-fg/[0.03] border-b">
                {block.head.map((cell, i) => (
                  <th
                    key={i}
                    scope="col"
                    style={{ textAlign: block.align[i] ?? undefined }}
                    className="text-fg px-2.5 py-1.5 font-semibold whitespace-nowrap"
                  >
                    <Inlines nodes={cell} follow={follow} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-border/40 border-b last:border-b-0">
                  {row.map((cell, i) => (
                    <td
                      key={i}
                      style={{ textAlign: block.align[i] ?? undefined }}
                      className="px-2.5 py-1.5 align-top"
                    >
                      <Inlines nodes={cell} follow={follow} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr className="border-border/70 my-5" />;
  }
}

function Inlines({
  nodes,
  follow,
  inLink = false,
}: {
  nodes: Inline[];
  follow: Follow;
  inLink?: boolean;
}): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'code':
        return (
          <code
            key={i}
            className="bg-fg/[0.06] text-fg rounded px-1 py-px font-mono text-[11.5px] break-words"
          >
            {n.v}
          </code>
        );
      case 'br':
        return <br key={i} />;
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={n.c} follow={follow} inLink={inLink} />
          </em>
        );
      case 'strong':
        return (
          <strong key={i} className="text-fg font-semibold">
            <Inlines nodes={n.c} follow={follow} inLink={inLink} />
          </strong>
        );
      case 'del':
        return (
          <del key={i} className="text-fg-dim">
            <Inlines nodes={n.c} follow={follow} inLink={inLink} />
          </del>
        );
      case 'image':
        return <ImageRef key={i} src={n.src} alt={n.alt} follow={inLink ? null : follow} />;
      case 'link':
        if (inLink || !n.href)
          return (
            <span key={i} title={n.title ?? undefined} className={cn(!inLink && 'text-fg')}>
              <Inlines nodes={n.c} follow={follow} inLink />
            </span>
          );
        return (
          <a
            key={i}
            href={n.href}
            title={n.title ?? n.href}
            onClick={(e) => {
              e.preventDefault();
              follow(n.href!);
            }}
            className="text-accent break-words hover:underline"
          >
            <Inlines nodes={n.c} follow={follow} inLink />
          </a>
        );
    }
  });
}

/** Remote images are blocked by the CSP: show the alt text as a link instead. */
function ImageRef({ src, alt, follow }: { src: string; alt: string; follow: Follow | null }) {
  i18n.useLocale();
  const href = safeHref(src);
  const label = alt.trim() || src.split('/').pop() || i18n.t('Image');
  const content = (
    <>
      <ImageIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  const chip =
    'bg-fg/[0.04] ring-border/60 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-px align-middle text-[11px] ring-1';
  if (!href || !follow)
    return (
      <span className={cn(chip, 'text-fg-dim')} title={src}>
        {content}
      </span>
    );
  return (
    <a
      href={href}
      title={i18n.t('Image: {src}', { src })}
      onClick={(e) => {
        e.preventDefault();
        follow(href);
      }}
      className={cn(chip, 'text-fg-muted hover:text-accent')}
    >
      {content}
    </a>
  );
}
