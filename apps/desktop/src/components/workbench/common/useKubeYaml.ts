import { useEffect, type RefObject } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { attachKubeYaml } from '@/lib/kube/schema/monaco';

type MonacoApi = Parameters<OnMount>[1];

/**
 * Bind a mounted Monaco editor's model to a cluster's schemas (completion,
 * hovers, markers, "Explain field at cursor"). No cluster, no binding: the
 * editor stays a plain YAML editor.
 */
export function useKubeYaml(
  mounted: boolean,
  editorRef: RefObject<MonacoEditor.IStandaloneCodeEditor | null>,
  monacoRef: RefObject<MonacoApi | null>,
  clusterId: string | null | undefined,
  diagnostics: boolean,
) {
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !editor || !monaco || !clusterId) return;
    const handle = attachKubeYaml(monaco, editor, { clusterId, diagnostics });
    return () => handle.dispose();
  }, [mounted, clusterId, diagnostics, editorRef, monacoRef]);
}
