import { useEffect, type RefObject } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { attachKubeYaml, attachValuesSchema } from '@/lib/kube/schema/monaco';
import type { ValuesSchema } from '@/lib/kube/schema/values';

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

/**
 * Bind a mounted Helm values editor to its chart's `values.schema.json`
 * (completion, hovers, markers). No schema, no binding.
 */
export function useValuesSchema(
  mounted: boolean,
  editorRef: RefObject<MonacoEditor.IStandaloneCodeEditor | null>,
  monacoRef: RefObject<MonacoApi | null>,
  schema: ValuesSchema | null | undefined,
) {
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !editor || !monaco || !schema) return;
    const handle = attachValuesSchema(monaco, editor, schema);
    return () => handle.dispose();
  }, [mounted, schema, editorRef, monacoRef]);
}
