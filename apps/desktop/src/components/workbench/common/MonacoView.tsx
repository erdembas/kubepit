import * as i18n from '@/i18n';
import { useCallback, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useMonacoReady } from '@/lib/monacoRuntime';
import { useMonacoTheme } from '@/lib/monacoTheme';
import { useIsDark } from '../util';
import { useKubeYaml } from './useKubeYaml';

type MonacoApi = Parameters<OnMount>[1];

/**
 * Monaco YAML surface (read-only by default). Falls back to a plain <pre>
 * while Monaco loads or if it fails to load (e.g. a strict CSP). With a
 * `clusterId`, Kubernetes manifests get schema hovers and "Explain field at
 * cursor" (plus markers when editable).
 */
export function MonacoView({
  value,
  readOnly = true,
  onChange,
  language = 'yaml',
  clusterId,
}: {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  language?: string;
  clusterId?: string | null;
}) {
  i18n.useLocale();
  const { ready, error } = useMonacoReady();
  const theme = useMonacoTheme(useIsDark() ? 'dark' : 'light');
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const [mounted, setMounted] = useState(false);
  const onMount: OnMount = useCallback((editor, api) => {
    editorRef.current = editor;
    monacoRef.current = api;
    setMounted(true);
  }, []);
  useKubeYaml(mounted, editorRef, monacoRef, language === 'yaml' ? clusterId : null, !readOnly);
  if (!ready || error) {
    return readOnly || !onChange ? (
      <pre className="text-fg-muted min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-[1.6] whitespace-pre">
        {value}
      </pre>
    ) : (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={i18n.t('YAML editor')}
        className="bg-surface text-fg min-h-0 flex-1 resize-none p-3 font-mono text-[11.5px] leading-[1.6] outline-none"
      />
    );
  }
  return (
    <div className="relative min-h-0 flex-1">
      <Editor
        value={value}
        language={language}
        theme={theme}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={onMount}
        loading={<span className="text-fg-dim p-3 text-[12px]">{i18n.t('Loading editor…')}</span>}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
          fontSize: 12,
          lineHeight: 19,
          scrollBeyondLastLine: false,
          renderLineHighlight: readOnly ? 'none' : 'line',
          automaticLayout: true,
          lineNumbersMinChars: 3,
          folding: true,
          tabSize: 2,
          wordWrap: 'off',
          padding: { top: 8, bottom: 8 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          overviewRulerLanes: 0,
          contextmenu: !readOnly,
        }}
      />
    </div>
  );
}
