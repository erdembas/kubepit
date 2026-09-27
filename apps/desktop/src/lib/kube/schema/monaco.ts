import * as i18n from '@/i18n/core';
import type * as Monaco from 'monaco-editor';
import { IS_MAC } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import { openExplain } from '@/store/useExplainStore';
import type { ClusterId } from '@/types';
import {
  apiVersionSuggestions,
  headerSuggestions,
  kindSuggestions,
  propertySuggestions,
  valueSuggestions,
  type Suggestion,
} from './complete';
import { fieldMarkdown, kindMarkdown } from './describe';
import { fieldInfo, fieldPathOf, schemaAt, type PathSegment } from './fields';
import { loadIndex, resolveKind, servedResources, type KindResolution } from './loader';
import { isArrayNode, isObjectNode } from './openapi';
import { validateManifest } from './validate';
import {
  documentAtOffset,
  parseDocuments,
  parsedHeader,
  pathAtOffset,
  topLevelValueRange,
  type ParsedDoc,
} from './yamlAst';
import { contextAt, documentAt, documentHeader, keyPathAt, parseLine } from './yamlContext';

/**
 * Kubernetes language features for Monaco YAML models, driven by the
 * connected cluster's OpenAPI v3 schemas: completion, hovers, diagnostics
 * and "Explain field at cursor". Providers are registered once for the
 * `yaml` language and only answer for models an editor attached with
 * `attachKubeYaml` (the model → cluster mapping), so Helm values and other
 * YAML editors are unaffected. Everything fails soft: without a schema
 * there are no suggestions or markers, and nothing ever blocks editing.
 */

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

export const SCHEMA_MARKER_OWNER = 'kubepit-schema';
export const EXPLAIN_ACTION_ID = 'kubepit.yaml.explain';
/** Keybinding of "Explain field at cursor", as shown in tooltips. */
export const EXPLAIN_SHORTCUT = IS_MAC ? '⌘⇧E' : 'Ctrl+Shift+E';
const DIAGNOSTICS_DELAY = 450;

interface Binding {
  clusterId: ClusterId;
}

const bindings = new Map<string, Binding>();
let registered = false;

const bindingOf = (model: Model) => bindings.get(model.uri.toString()) ?? null;

// Parsing is shared by hovers and explain within one model version.
const parsed = new WeakMap<Model, { version: number; docs: ParsedDoc[] }>();
function docsOf(model: Model): ParsedDoc[] {
  const version = model.getVersionId();
  const hit = parsed.get(model);
  if (hit?.version === version) return hit.docs;
  const docs = parseDocuments(model.getValue());
  parsed.set(model, { version, docs });
  return docs;
}

/**
 * Editor options that let schema completion pop up while typing. Editors
 * merge them into their own `options` prop (the React wrapper re-applies
 * that prop on every render, so setting them imperatively would not stick).
 */
export const KUBE_YAML_EDITOR_OPTIONS = {
  quickSuggestions: { other: true, strings: true, comments: false },
  suggestOnTriggerCharacters: true,
} satisfies Monaco.editor.IEditorOptions;

export interface KubeYamlOptions {
  clusterId: ClusterId;
  /** Schema markers (off for read-only views). */
  diagnostics?: boolean;
}

/**
 * Enable Kubernetes features on an editor's model for `clusterId`. Returns
 * a disposable that removes the binding, the markers and the action.
 */
export function attachKubeYaml(
  monaco: MonacoApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  { clusterId, diagnostics = true }: KubeYamlOptions,
): Monaco.IDisposable {
  registerProviders(monaco);
  let modelKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const run = async () => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return;
    const current = ++generation;
    const markers = await computeMarkers(monaco, model, clusterId);
    if (current !== generation || !markers || model.isDisposed()) return;
    monaco.editor.setModelMarkers(model, SCHEMA_MARKER_OWNER, markers);
  };
  const schedule = (delay = DIAGNOSTICS_DELAY) => {
    if (!diagnostics) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  };
  const bind = () => {
    if (modelKey) bindings.delete(modelKey);
    const model = editor.getModel();
    modelKey = model?.uri.toString() ?? null;
    if (modelKey) bindings.set(modelKey, { clusterId });
    schedule(0);
  };

  const subscriptions = [
    editor.onDidChangeModelContent(() => schedule()),
    editor.onDidChangeModel(bind),
    editor.addAction({
      id: EXPLAIN_ACTION_ID,
      label: i18n.t('Explain field at cursor'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: (ed) => void explainAtCursor(ed, clusterId),
    }),
  ];
  bind();

  return {
    dispose() {
      clearTimeout(timer);
      generation++;
      subscriptions.forEach((d) => d.dispose());
      if (modelKey) bindings.delete(modelKey);
      const model = editor.getModel();
      if (model && !model.isDisposed())
        monaco.editor.setModelMarkers(model, SCHEMA_MARKER_OWNER, []);
    },
  };
}

// -- Diagnostics --------------------------------------------------------------

async function computeMarkers(
  monaco: MonacoApi,
  model: Model,
  clusterId: ClusterId,
): Promise<Monaco.editor.IMarkerData[] | null> {
  const version = model.getVersionId();
  const docs = docsOf(model);
  const found: Array<{
    severity: 'error' | 'warning';
    message: string;
    start: number;
    end: number;
  }> = [];
  for (const doc of docs) {
    // Syntax errors have their own markers; judge only what parses.
    if (doc.errors.length || !doc.contents) continue;
    const { apiVersion, kind } = parsedHeader(doc);
    if (!apiVersion || !kind) continue;
    const resolution = await resolveKind(clusterId, apiVersion, kind);
    if (resolution.status === 'unknown-version') {
      const range = topLevelValueRange(doc, 'apiVersion');
      if (range)
        found.push({
          severity: 'warning',
          message: i18n.t('{apiVersion} is not served by this cluster.', { apiVersion }),
          start: range[0],
          end: range[1],
        });
    } else if (resolution.status === 'unknown-kind') {
      const range = topLevelValueRange(doc, 'kind');
      if (range)
        found.push({
          severity: 'warning',
          message: i18n.t('{apiVersion} has no kind {kind} on this cluster.', { apiVersion, kind }),
          start: range[0],
          end: range[1],
        });
    } else if (resolution.status === 'ok') {
      found.push(...validateManifest(resolution.set, resolution.root, doc.contents));
    }
  }
  // Positions must come from the text the offsets were computed on.
  if (model.isDisposed() || model.getVersionId() !== version) return null;
  return found.map((issue) => {
    const start = model.getPositionAt(issue.start);
    const end = model.getPositionAt(Math.max(issue.end, issue.start + 1));
    return {
      severity:
        issue.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: issue.message,
      source: 'kubernetes',
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    };
  });
}

// -- Completion ---------------------------------------------------------------

async function headerResolution(
  clusterId: ClusterId,
  apiVersion: string | null,
  kind: string | null,
): Promise<KindResolution | null> {
  if (!apiVersion || !kind) return null;
  return resolveKind(clusterId, apiVersion, kind);
}

async function suggestionsAt(
  model: Model,
  position: Monaco.Position,
  clusterId: ClusterId,
  triggeredBySpace: boolean,
): Promise<{ items: Suggestion[]; prefix: string; suffix: string; docStart: number } | null> {
  const lines = model.getLinesContent();
  const line = position.lineNumber - 1;
  const ctx = contextAt(lines, line, position.column - 1);
  if (!ctx) return null;
  const bounds = documentAt(lines, line);
  const header = documentHeader(lines, bounds);
  const after = lines[line]!.slice(position.column - 1);
  // Accepting a suggestion inside a word replaces the whole word.
  const suffix = (ctx.type === 'key' ? /^[\w.\-/]*/ : /^[^\s#]*/).exec(after)?.[0] ?? '';
  const result = (items: Suggestion[]) => ({
    items,
    prefix: ctx.prefix,
    suffix,
    docStart: bounds.start,
  });

  if (ctx.type === 'value') {
    if (ctx.path.length === 1 && ctx.key === 'apiVersion') {
      const [resources, index] = await Promise.all([
        servedResources(clusterId).catch(() => []),
        loadIndex(clusterId).catch(() => null),
      ]);
      return result(apiVersionSuggestions(resources, index, header.kind));
    }
    if (ctx.path.length === 1 && ctx.key === 'kind') {
      const resources = await servedResources(clusterId).catch(() => []);
      return result(kindSuggestions(resources, header.apiVersion));
    }
    const resolution = await headerResolution(clusterId, header.apiVersion, header.kind);
    if (resolution?.status !== 'ok') return null;
    const at = schemaAt(resolution.set, resolution.root, ctx.path);
    return at ? result(valueSuggestions(at.node)) : null;
  }

  // A space while indenting should not pop up a list of keys.
  if (triggeredBySpace) return null;
  // The key's colon is already there: complete the name only.
  const bare = /^[\w.\-/]*\s*:/.test(after);
  const resolution = await headerResolution(clusterId, header.apiVersion, header.kind);
  if (resolution?.status !== 'ok') {
    if (ctx.path.length) return null;
    const items = headerSuggestions(ctx.siblings);
    return result(
      bare ? items.map((i) => ({ ...i, insertText: i.label, retrigger: false })) : items,
    );
  }
  const at = schemaAt(resolution.set, resolution.root, ctx.path);
  if (!at) return null;
  // `- ` in a list of enum values.
  if (at.node.enum?.length && !isObjectNode(at.node) && !isArrayNode(at.node))
    return result(valueSuggestions(at.node));
  return result(propertySuggestions(resolution.set, at.node, ctx.siblings, bare));
}

function completionKind(monaco: MonacoApi, kind: Suggestion['kind']) {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'property':
      return K.Property;
    case 'enum':
      return K.EnumMember;
    case 'kind':
      return K.Class;
    case 'apiVersion':
      return K.Module;
    default:
      return K.Value;
  }
}

// -- Hover & explain ----------------------------------------------------------

interface CursorTarget {
  path: PathSegment[];
  on: 'key' | 'value';
  range: Monaco.IRange | null;
  apiVersion: string | null;
  kind: string | null;
}

/** The YAML path under a position: parsed when possible, by indentation otherwise. */
function targetAt(model: Model, position: Monaco.Position): CursorTarget | null {
  const lines = model.getLinesContent();
  const line = position.lineNumber - 1;
  const offset = model.getOffsetAt(position);
  const docs = docsOf(model);
  const hit = pathAtOffset(docs, offset);
  const doc = documentAtOffset(docs, offset);
  const header =
    doc && !doc.errors.length ? parsedHeader(doc) : documentHeader(lines, documentAt(lines, line));
  if (hit && hit.path.length) {
    const start = model.getPositionAt(hit.start);
    const end = model.getPositionAt(hit.end);
    return {
      path: hit.path,
      on: hit.on,
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      ...header,
    };
  }
  const path = keyPathAt(lines, line);
  if (!path) return null;
  const info = parseLine(lines[line] ?? '');
  return {
    path,
    on: 'key',
    range: {
      startLineNumber: position.lineNumber,
      startColumn: info.keyCol + 1,
      endLineNumber: position.lineNumber,
      endColumn: info.keyCol + 1 + (info.key?.length ?? 0),
    },
    ...header,
  };
}

async function hoverAt(
  model: Model,
  position: Monaco.Position,
  clusterId: ClusterId,
): Promise<Monaco.languages.Hover | null> {
  const target = targetAt(model, position);
  if (!target?.apiVersion || !target.kind) return null;
  const resolution = await resolveKind(clusterId, target.apiVersion, target.kind);
  if (resolution.status !== 'ok') return null;
  const { set, root } = resolution;
  const range = target.range ?? undefined;
  const top = target.path.length === 1 ? target.path[0] : null;
  if (target.on === 'value' && (top === 'kind' || top === 'apiVersion'))
    return {
      range,
      contents: [{ value: kindMarkdown(target.kind, target.apiVersion, root.description) }],
    };
  // An item of a list explains the list's field.
  const path = [...target.path];
  while (typeof path[path.length - 1] === 'number') path.pop();
  const at = schemaAt(set, root, path);
  if (!at?.name) return null;
  const info = fieldInfo(set, at.name, at.node, at.required, at.fieldPath);
  return { range, contents: [{ value: fieldMarkdown(info) }] };
}

async function explainAtCursor(editor: Monaco.editor.ICodeEditor, clusterId: ClusterId) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;
  const lines = model.getLinesContent();
  const line = position.lineNumber - 1;
  let target = targetAt(model, position);
  if (!target) {
    // An empty line: explain the mapping being typed into.
    const ctx = contextAt(lines, line, position.column - 1);
    const header = documentHeader(lines, documentAt(lines, line));
    target = ctx ? { path: ctx.path, on: 'key', range: null, ...header } : null;
  }
  const header = target ?? documentHeader(lines, documentAt(lines, line));
  if (!header.apiVersion || !header.kind) {
    useAppStore
      .getState()
      .pushToast('info', i18n.t('Explain works in a manifest with apiVersion and kind.'));
    return;
  }
  const resolution = await resolveKind(clusterId, header.apiVersion, header.kind);
  const yamlPath = target?.path ?? [];
  const fieldPath =
    resolution.status === 'ok'
      ? fieldPathOf(resolution.set, resolution.root, yamlPath)
      : yamlPath.filter((seg): seg is string => typeof seg === 'string');
  openExplain(clusterId, { apiVersion: header.apiVersion, kind: header.kind }, fieldPath);
}

// -- Registration -------------------------------------------------------------

function registerProviders(monaco: MonacoApi) {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [' '],
    async provideCompletionItems(model, position, context) {
      const binding = bindingOf(model);
      if (!binding) return undefined;
      const bySpace =
        context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter &&
        context.triggerCharacter === ' ';
      const found = await suggestionsAt(model, position, binding.clusterId, bySpace).catch(
        () => null,
      );
      if (!found || model.isDisposed()) return { suggestions: [] };
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - found.prefix.length,
        endColumn: position.column + found.suffix.length,
      };
      return {
        suggestions: found.items.map((item) => ({
          label: item.label,
          kind: completionKind(monaco, item.kind),
          detail: item.detail || undefined,
          documentation: item.documentation ? { value: item.documentation } : undefined,
          insertText: item.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: item.sortText,
          range,
          tags: item.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
          command: item.retrigger
            ? { id: 'editor.action.triggerSuggest', title: item.label }
            : undefined,
          additionalTextEdits: item.apiVersion
            ? [
                {
                  range: {
                    startLineNumber: found.docStart + 1,
                    startColumn: 1,
                    endLineNumber: found.docStart + 1,
                    endColumn: 1,
                  },
                  text: `apiVersion: ${item.apiVersion}\n`,
                },
              ]
            : undefined,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider('yaml', {
    async provideHover(model, position) {
      const binding = bindingOf(model);
      if (!binding) return null;
      return hoverAt(model, position, binding.clusterId).catch(() => null);
    },
  });
}
