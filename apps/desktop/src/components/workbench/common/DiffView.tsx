import * as i18n from '@/i18n';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { DiffEditor, type MonacoDiffEditor } from '@monaco-editor/react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Columns2,
  FoldVertical,
  Rows2,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { diffLines, diffStats, type DiffOp } from '@/lib/diff';
import { useMonacoReady } from '@/lib/monacoRuntime';
import { useMonacoTheme } from '@/lib/monacoTheme';
import { usePersistentBoolean } from '@/lib/usePersistentBoolean';
import { useIsDark } from '../util';

/**
 * Read-only two-sided diff (Monaco diff editor, with a unified-diff
 * fallback while Monaco loads or when it cannot load). Used for apply
 * previews, rollout revisions, Helm revisions and cross-cluster compare.
 *
 * Layout (side by side / inline) and "collapse unchanged regions" are
 * viewer preferences shared by every diff in the app.
 */
export function DiffView({
  original,
  modified,
  originalLabel,
  modifiedLabel,
  language = 'yaml',
  actions,
  identicalHint,
  className,
}: {
  original: string;
  modified: string;
  /** Short label of the left side, e.g. "Live" or "prod-eu · revision 4". */
  originalLabel: string;
  modifiedLabel: string;
  language?: string;
  /** Extra toolbar controls, rendered right-aligned before the view toggles. */
  actions?: ReactNode;
  /** Replaces the default "no differences" sentence. */
  identicalHint?: string;
  className?: string;
}) {
  i18n.useLocale();
  const { ready, error } = useMonacoReady();
  const theme = useMonacoTheme(useIsDark() ? 'dark' : 'light');
  const [inline, setInline] = usePersistentBoolean('kp.diff.inline', false);
  const [collapse, setCollapse] = usePersistentBoolean('kp.diff.collapse', true);
  const editorRef = useRef<MonacoDiffEditor | null>(null);
  const ops = useMemo(() => diffLines(original, modified), [original, modified]);
  const stats = useMemo(() => diffStats(ops), [ops]);
  const monaco = ready && !error;

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <SideLabel tone="removed">{originalLabel}</SideLabel>
          <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" />
          <SideLabel tone="added">{modifiedLabel}</SideLabel>
        </div>
        {!stats.identical && (
          <span
            className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums"
            aria-label={i18n.t('{added} lines added, {removed} lines removed', {
              added: stats.added,
              removed: stats.removed,
            })}
          >
            <span className="text-status-running">+{stats.added}</span>
            <span className="text-status-error">−{stats.removed}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {actions}
          {monaco && !stats.identical && (
            <>
              <IconButton
                size="xs"
                label={i18n.t('Previous change')}
                icon={<ChevronUp />}
                onClick={() => editorRef.current?.goToDiff('previous')}
              />
              <IconButton
                size="xs"
                label={i18n.t('Next change')}
                icon={<ChevronDown />}
                onClick={() => editorRef.current?.goToDiff('next')}
              />
              <IconButton
                size="xs"
                label={
                  collapse ? i18n.t('Show unchanged lines') : i18n.t('Collapse unchanged lines')
                }
                icon={<FoldVertical />}
                aria-pressed={collapse}
                className={cn(collapse && 'text-accent')}
                onClick={() => setCollapse((v) => !v)}
              />
              <IconButton
                size="xs"
                label={inline ? i18n.t('Side by side') : i18n.t('Inline')}
                icon={inline ? <Columns2 /> : <Rows2 />}
                onClick={() => setInline((v) => !v)}
              />
            </>
          )}
        </div>
      </div>
      {stats.identical ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <span className="bg-status-running/10 text-status-running flex h-9 w-9 items-center justify-center rounded-xl">
            <CircleCheck className="h-4.5 w-4.5" />
          </span>
          <p className="text-fg text-[12.5px] font-medium">{i18n.t('No differences')}</p>
          <p className="text-fg-dim max-w-sm text-[11.5px]">
            {identicalHint ?? i18n.t('Both sides are identical.')}
          </p>
        </div>
      ) : monaco ? (
        <div className="relative min-h-0 flex-1">
          <DiffEditor
            original={original}
            modified={modified}
            language={language}
            theme={theme}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            loading={
              <span className="text-fg-dim p-3 text-[12px]">{i18n.t('Loading editor…')}</span>
            }
            options={{
              readOnly: true,
              domReadOnly: true,
              originalEditable: false,
              renderSideBySide: !inline,
              useInlineViewWhenSpaceIsLimited: true,
              hideUnchangedRegions: {
                enabled: collapse,
                contextLineCount: 3,
                minimumLineCount: 4,
                revealLineCount: 20,
              },
              ignoreTrimWhitespace: false,
              renderOverviewRuler: false,
              minimap: { enabled: false },
              fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
              fontSize: 12,
              lineHeight: 19,
              scrollBeyondLastLine: false,
              renderLineHighlight: 'none',
              automaticLayout: true,
              lineNumbersMinChars: 3,
              folding: false,
              wordWrap: 'off',
              padding: { top: 8, bottom: 8 },
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
              contextmenu: false,
            }}
          />
        </div>
      ) : (
        <UnifiedDiff ops={ops} />
      )}
    </div>
  );
}

function SideLabel({ tone, children }: { tone: 'added' | 'removed'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'max-w-[260px] truncate rounded px-1.5 py-0.5 font-mono',
        tone === 'added'
          ? 'bg-status-running/10 text-status-running'
          : 'bg-status-error/10 text-status-error',
      )}
    >
      {children}
    </span>
  );
}

/** Context lines kept around each change in the fallback view. */
const CONTEXT = 3;

/** Plain unified diff, used until Monaco is available. */
function UnifiedDiff({ ops }: { ops: DiffOp[] }) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState<Record<number, true>>({});
  return (
    <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[11.5px] leading-[1.6]">
      {ops.map((op, index) => {
        if (op.type !== 'equal')
          return op.lines.map((line, i) => (
            <div
              key={`${index}-${i}`}
              className={cn(
                'px-3 whitespace-pre',
                op.type === 'insert'
                  ? 'bg-status-running/10 text-status-running'
                  : 'bg-status-error/10 text-status-error',
              )}
            >
              {op.type === 'insert' ? '+ ' : '- '}
              {line}
            </div>
          ));
        const first = index === 0;
        const last = index === ops.length - 1;
        const keepHead = first ? 0 : CONTEXT;
        const keepTail = last ? 0 : CONTEXT;
        if (expanded[index] || op.lines.length <= keepHead + keepTail + 1)
          return op.lines.map((line, i) => <ContextLine key={`${index}-${i}`} line={line} />);
        const hidden = op.lines.length - keepHead - keepTail;
        return (
          <div key={index}>
            {op.lines.slice(0, keepHead).map((line, i) => (
              <ContextLine key={i} line={line} />
            ))}
            <button
              type="button"
              onClick={() => setExpanded((e) => ({ ...e, [index]: true }))}
              className="text-fg-dim hover:bg-fg/4 hover:text-fg w-full px-3 py-0.5 text-left text-[10.5px]"
            >
              {i18n.plural('… {count} unchanged line', '… {count} unchanged lines', hidden)}
            </button>
            {op.lines.slice(op.lines.length - keepTail).map((line, i) => (
              <ContextLine key={`t${i}`} line={line} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ContextLine({ line }: { line: string }) {
  return <div className="text-fg-muted px-3 whitespace-pre">{`  ${line}`}</div>;
}
