import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useMonacoReady } from '@/lib/monacoRuntime';
import { useMonacoTheme } from '@/lib/monacoTheme';
import { NERD_FONT_STACK, useIsDark } from '../shared/xtermUtils';
import { yamlIssues } from './documents';

type MonacoApi = Parameters<OnMount>[1];

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl+S. */
  onSave: () => void;
  readOnly: boolean;
  fontSize: number;
}

/**
 * Monaco YAML editor with RunHQ's theme plumbing, inline syntax markers and
 * Cmd/Ctrl+S. Falls back to a monospace textarea when Monaco cannot load.
 */
export function YamlEditor({ value, onChange, onSave, readOnly, fontSize }: Props) {
  i18n.useLocale();
  const isDark = useIsDark();
  const theme = useMonacoTheme(isDark ? 'dark' : 'light');
  const monaco = useMonacoReady();
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const [mounted, setMounted] = useState(false);

  const onMount: OnMount = useCallback((editor, api) => {
    editorRef.current = editor;
    monacoRef.current = api;
    // An action (not addCommand) keeps the binding scoped to this editor
    // instance when several dock editors are mounted at once.
    editor.addAction({
      id: 'kubepit.dock.save',
      label: i18n.t('Save / apply manifest'),
      keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyS],
      run: () => saveRef.current(),
    });
    setMounted(true);
  }, []);

  // Syntax markers, debounced so typing stays smooth on large manifests.
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => {
      const api = monacoRef.current;
      const model = editorRef.current?.getModel();
      if (!api || !model) return;
      api.editor.setModelMarkers(
        model,
        'kubepit-yaml',
        yamlIssues(value).map((issue) => ({
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
  }, [value, mounted]);

  if (monaco.error) {
    return (
      <FallbackEditor
        value={value}
        onChange={onChange}
        onSave={onSave}
        readOnly={readOnly}
        fontSize={fontSize}
      />
    );
  }
  if (!monaco.ready) {
    return (
      <div className="text-fg-dim flex h-full items-center justify-center text-[12px]">
        {i18n.t('Loading editor…')}
      </div>
    );
  }
  return (
    <Editor
      value={value}
      onChange={(next) => onChange(next ?? '')}
      onMount={onMount}
      language="yaml"
      theme={theme}
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: false },
        fontSize,
        fontFamily: NERD_FONT_STACK,
        lineHeight: Math.round(fontSize * 1.5),
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 16 },
        wordWrap: 'off',
        automaticLayout: true,
        stickyScroll: { enabled: false },
        quickSuggestions: false,
        wordBasedSuggestions: 'off',
        smoothScrolling: true,
        fixedOverflowWidgets: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      }}
    />
  );
}

function FallbackEditor({ value, onChange, onSave, readOnly, fontSize }: Props) {
  return (
    <textarea
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          onSave();
        } else if (e.key === 'Tab' && !readOnly) {
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: start, selectionEnd: end } = el;
          onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
          requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
        }
      }}
      className="bg-surface text-fg h-full w-full resize-none p-3 font-mono leading-relaxed outline-none"
      style={{ fontSize, tabSize: 2 }}
    />
  );
}
