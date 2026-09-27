import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useMonacoReady } from '@/lib/monacoRuntime';
import { useMonacoTheme } from '@/lib/monacoTheme';
import { cn } from '@/lib/cn';
import { yamlIssues } from '../dock/editor/documents';
import { scrollParent, useIsDark } from '../util';

type MonacoApi = Parameters<OnMount>[1];

const LINE_HEIGHT = 18;
const PADDING = 12;

/**
 * Monaco surface that grows with its content (between `minLines` and
 * `maxHeight`), for editing values inline in the details panel. Cmd/Ctrl+S
 * calls `onSave`. Falls back to a plain textarea while Monaco loads.
 */
export function InlineCodeEditor({
  value,
  onChange,
  onSave,
  language,
  ariaLabel,
  autoFocus,
  minLines = 4,
  maxHeight = 440,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  language: string;
  ariaLabel: string;
  autoFocus?: boolean;
  minLines?: number;
  maxHeight?: number;
}) {
  i18n.useLocale();
  const monaco = useMonacoReady();
  const theme = useMonacoTheme(useIsDark() ? 'dark' : 'light');
  const minHeight = minLines * LINE_HEIGHT + PADDING;
  const [height, setHeight] = useState(() =>
    Math.min(maxHeight, Math.max(minHeight, value.split('\n').length * LINE_HEIGHT + PADDING)),
  );
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const [mounted, setMounted] = useState(false);

  const onMount: OnMount = useCallback(
    (editor, api) => {
      editorRef.current = editor;
      monacoRef.current = api;
      editor.addAction({
        id: 'kubepit.details.save',
        label: i18n.t('Save'),
        keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyS],
        run: () => saveRef.current?.(),
      });
      // Keep the caret visible in the surrounding scroll area (the editor
      // grows instead of scrolling), minus its scroll padding (sticky bars).
      const reveal = () => {
        const node = editor.getDomNode();
        const pos = editor.getPosition();
        const scroller = node && scrollParent(node);
        const caret = pos && editor.getScrolledVisiblePosition(pos);
        if (!editor.hasTextFocus() || !node || !scroller || !caret) return;
        const view = scroller.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(scroller).scrollPaddingBottom) || 0;
        const top = node.getBoundingClientRect().top + caret.top;
        const bottom = top + caret.height;
        if (bottom > view.bottom - pad) scroller.scrollBy({ top: bottom - view.bottom + pad + 4 });
        else if (top < view.top) scroller.scrollBy({ top: top - view.top - 4 });
      };
      const fit = () =>
        setHeight(Math.min(maxHeight, Math.max(minHeight, editor.getContentHeight())));
      editor.onDidContentSizeChange(() => {
        fit();
        requestAnimationFrame(reveal);
      });
      editor.onDidChangeCursorPosition(() => requestAnimationFrame(reveal));
      fit();
      if (autoFocus) editor.focus();
      setMounted(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // YAML has no Monaco language service; mark syntax errors ourselves.
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => {
      const api = monacoRef.current;
      const model = editorRef.current?.getModel();
      if (!api || !model) return;
      api.editor.setModelMarkers(
        model,
        'kubepit-data',
        language !== 'yaml'
          ? []
          : yamlIssues(value).map((issue) => ({
              severity: api.MarkerSeverity.Error,
              message: issue.message,
              startLineNumber: issue.line,
              startColumn: issue.col,
              endLineNumber: issue.endLine,
              endColumn: Math.max(issue.endCol, issue.col + 1),
            })),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [value, language, mounted]);

  if (!monaco.ready || monaco.error)
    return (
      <PlainTextEditor
        value={value}
        onChange={onChange}
        onSave={onSave}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        minRows={minLines}
      />
    );
  return (
    <div
      className="border-border/60 focus-within:border-accent/70 overflow-hidden rounded-md border transition-colors"
      style={{ height: height + 2 }}
    >
      <Editor
        value={value}
        language={language}
        theme={theme}
        onChange={(v) => onChange(v ?? '')}
        onMount={onMount}
        loading={<span className="text-fg-dim p-3 text-[12px]">{i18n.t('Loading editor…')}</span>}
        options={{
          ariaLabel,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
          fontSize: 11.5,
          lineHeight: LINE_HEIGHT,
          tabSize: 2,
          insertSpaces: true,
          detectIndentation: true,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          automaticLayout: true,
          lineNumbersMinChars: 3,
          folding: true,
          wordWrap: 'off',
          padding: { top: PADDING / 2, bottom: PADDING / 2 },
          stickyScroll: { enabled: false },
          quickSuggestions: false,
          wordBasedSuggestions: 'off',
          fixedOverflowWidgets: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
            alwaysConsumeMouseWheel: false,
          },
        }}
      />
    </div>
  );
}

/** Auto-growing monospace textarea for plain values; Cmd/Ctrl+S saves. */
export function PlainTextEditor({
  value,
  onChange,
  onSave,
  ariaLabel,
  autoFocus,
  minRows = 3,
  maxRows = 24,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  ariaLabel: string;
  autoFocus?: boolean;
  minRows?: number;
  maxRows?: number;
  className?: string;
}) {
  const rows = Math.min(maxRows, Math.max(minRows, value.split('\n').length));
  return (
    <textarea
      value={value}
      rows={rows}
      autoFocus={autoFocus}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          onSave?.();
        }
      }}
      className={cn(
        'bg-fg/[0.035] border-border/60 text-fg focus:border-accent/70 block w-full resize-y rounded-md border p-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre transition-colors outline-none',
        className,
      )}
      style={{ tabSize: 2 }}
    />
  );
}
