import YAML from 'yaml';
import { builtinExamples } from '@/lib/customActionExamples';
import { actionApplies } from '@/lib/customActions';
import { normalizeChord } from '@/lib/keymap';
import type {
  ClusterDef,
  CustomAction,
  CustomActionImport,
  CustomActionImportNote,
  CustomActionResult,
  CustomActionsState,
  CustomActionTarget,
  Gvk,
  KubeObject,
  ResolvedCustomAction,
  TerminalOutput,
} from '@/types';
import { mockEmit, mockEmitAllWindows, sleep } from './bus';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo custom actions: an in-memory `actions.json` (the examples, most of
 * them enabled so every surface has something to show), placeholder
 * resolution with POSIX quoting, plausible background output and terminal
 * runs that print a transcript and exit.
 */

const ENABLED_IN_DEMO = new Set([
  'example-describe',
  'example-wide',
  'example-neat',
  'example-grafana',
  'example-argocd',
  'example-annotate',
  'example-top-nodes',
]);

let state: CustomActionsState | null = null;
const current = (): CustomActionsState =>
  (state ??= {
    actions: builtinExamples().map((a) => ({ ...a, enabled: ENABLED_IN_DEMO.has(a.id) })),
    initialized: true,
  });

const clusterById = (id: string | null | undefined) =>
  ((handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? []).find((c) => c.id === id);

const SAFE = /^[A-Za-z0-9_.,:=@%+/-]+$/;
const quote = (v: string) => (SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
const TOKEN =
  /\{(cluster|context|kubeconfig|namespace|name|kind|group|version|resource|container|selection\.names|labels\.[\w./-]+|annotations\.[\w./-]+)\}/g;

function resolve(
  action: Pick<CustomAction, 'command' | 'mode'>,
  cluster: ClusterDef | undefined,
  target: CustomActionTarget,
): ResolvedCustomAction {
  const missing: string[] = [];
  const url = action.mode === 'open-url';
  const lookup = (token: string): string | string[] | null => {
    if (token === 'cluster') return cluster?.name ?? 'my-cluster';
    if (token === 'context') return cluster?.context ?? 'my-context';
    if (token === 'kubeconfig') return `~/.kubepit/run/${cluster?.id ?? 'example'}.kubeconfig`;
    if (token === 'group') return target.group ?? '';
    if (token === 'selection.names')
      return target.selection.length ? target.selection : target.name ? [target.name] : null;
    if (token.startsWith('labels.')) return target.labels[token.slice(7)] ?? null;
    if (token.startsWith('annotations.')) return target.annotations[token.slice(12)] ?? null;
    const value = target[token as keyof CustomActionTarget];
    return typeof value === 'string' && value ? value : null;
  };
  const command = action.command.trim().replace(TOKEN, (whole, token: string) => {
    const value = lookup(token);
    if (value === null) {
      if (!missing.includes(whole)) missing.push(whole);
      return url ? '' : "''";
    }
    if (url) return (Array.isArray(value) ? value : [value]).map(encodeURIComponent).join(',');
    return Array.isArray(value) ? value.map(quote).join(' ') : quote(value);
  });
  if (url && !/^https?:\/\/./i.test(command))
    throw new Error('the URL must start with http:// or https://');
  const unknown = [...action.command.matchAll(/\{([a-z]+(?:\.[\w./-]+)?)\}/g)]
    .map((m) => m[0])
    .filter((t, i, all) => !t.match(TOKEN) && all.indexOf(t) === i);
  return { command, missing, unknown };
}

function runnable(clusterId: string, actionId: string, target: CustomActionTarget) {
  const action = current().actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`custom action ${actionId} does not exist`);
  if (!action.enabled) throw new Error(`the custom action "${action.name}" is disabled`);
  const cluster = clusterById(clusterId);
  if (!cluster) throw new Error(`cluster ${clusterId} is not registered`);
  if (action.mutating && cluster.read_only)
    throw new Error(
      `Cluster "${cluster.name}" is read-only: running the custom action "${action.name}" is not allowed`,
    );
  const applies = actionApplies(action, {
    cluster,
    kind: target.kind,
    group: target.group ?? '',
    namespace: target.namespace,
  });
  if (!applies)
    throw new Error(
      `the custom action "${action.name}" does not apply to this ${target.kind ?? 'cluster'}`,
    );
  return { action, cluster };
}

const pad = (s: string, n: number) => s.padEnd(n);

async function objectYaml(clusterId: string, target: CustomActionTarget): Promise<string> {
  const gvk: Gvk = {
    group: target.group ?? '',
    version: target.version ?? 'v1',
    kind: target.kind ?? '',
    plural: target.resource ?? '',
    namespaced: !!target.namespace,
  };
  try {
    const obj = (await handlers.resource_get?.({
      clusterId,
      gvk,
      namespace: target.namespace,
      name: target.name,
    })) as KubeObject;
    const clean = structuredClone(obj) as KubeObject & { status?: unknown };
    delete clean.status;
    const meta = clean.metadata as unknown as Record<string, unknown>;
    for (const key of [
      'uid',
      'resourceVersion',
      'creationTimestamp',
      'generation',
      'managedFields',
    ])
      delete meta[key];
    return YAML.stringify(clean);
  } catch {
    return `apiVersion: ${gvk.group ? `${gvk.group}/` : ''}${gvk.version}\nkind: ${gvk.kind}\nmetadata:\n  name: ${target.name}\n  namespace: ${target.namespace}\n`;
  }
}

/** What a command "prints" in the demo. */
async function simulate(
  clusterId: string,
  command: string,
  target: CustomActionTarget,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  if (/kubectl top nodes/.test(command)) {
    const rows = ['ip-10-0-1-12', 'ip-10-0-2-34', 'ip-10-0-3-56'].map(
      (n, i) =>
        `${pad(n, 18)}${pad(`${420 + i * 180}m`, 12)}${pad(`${11 + i * 7}%`, 8)}${pad(`${5 + i}210Mi`, 16)}${34 + i * 9}%`,
    );
    return {
      stdout: `${pad('NAME', 18)}${pad('CPU(cores)', 12)}${pad('CPU%', 8)}${pad('MEMORY(bytes)', 16)}MEMORY%\n${rows.join('\n')}\n`,
      stderr: '',
      exit: 0,
    };
  }
  if (/-o wide/.test(command)) {
    const app = target.labels.app;
    if (!app) return { stdout: '', stderr: 'No resources found.\n', exit: 0 };
    const rows = [0, 1, 2].map(
      (i) =>
        `${pad(`${app}-7d9f8c6b5-${['x2x9k', 'q7m4d', 'lp8zt'][i]}`, 28)}${pad('1/1', 8)}${pad('Running', 10)}${pad('0', 10)}${pad(`${3 + i}d`, 6)}${pad(`10.244.${i}.${17 + i}`, 15)}ip-10-0-${i + 1}-12`,
    );
    return {
      stdout: `${pad('NAME', 28)}${pad('READY', 8)}${pad('STATUS', 10)}${pad('RESTARTS', 10)}${pad('AGE', 6)}${pad('IP', 15)}NODE\n${rows.join('\n')}\n`,
      stderr: '',
      exit: 0,
    };
  }
  if (/kubectl neat|-o yaml/.test(command))
    return { stdout: await objectYaml(clusterId, target), stderr: '', exit: 0 };
  if (/kubectl annotate/.test(command)) {
    const names = target.selection.length ? target.selection : [target.name ?? ''];
    const kind = `${(target.kind ?? '').toLowerCase()}${target.group ? `.${target.group}` : ''}`;
    return { stdout: names.map((n) => `${kind}/${n} annotated\n`).join(''), stderr: '', exit: 0 };
  }
  if (/kubectl describe/.test(command))
    return {
      stdout: `Name:         ${target.name}\nNamespace:    ${target.namespace ?? ''}\nLabels:       ${
        Object.entries(target.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n              ') || '<none>'
      }\nAnnotations:  <none>\nEvents:       <none>\n`,
      stderr: '',
      exit: 0,
    };
  const tool = command.split(/\s+/)[0] ?? command;
  return {
    stdout: '',
    stderr: `demo: ${tool}: commands do not run in the browser preview; the desktop app runs them through /bin/sh.\n`,
    exit: 127,
  };
}

// -- Import (a small subset of the backend's k9s mapping) ---------------------

const K9S_SCOPES: Record<string, string> = {
  pods: 'core/Pod',
  po: 'core/Pod',
  containers: 'core/Pod',
  deployments: 'apps/Deployment',
  deploy: 'apps/Deployment',
  dp: 'apps/Deployment',
  statefulsets: 'apps/StatefulSet',
  sts: 'apps/StatefulSet',
  daemonsets: 'apps/DaemonSet',
  ds: 'apps/DaemonSet',
  services: 'core/Service',
  svc: 'core/Service',
  nodes: 'core/Node',
  no: 'core/Node',
  namespaces: 'core/Namespace',
  ns: 'core/Namespace',
  jobs: 'batch/Job',
  cronjobs: 'batch/CronJob',
  cj: 'batch/CronJob',
  all: '*',
};
const K9S_VARS: Record<string, string> = {
  NAMESPACE: '{namespace}',
  NAME: '{name}',
  POD: '{name}',
  CONTEXT: '{context}',
  CLUSTER: '{cluster}',
  KUBECONFIG: '{kubeconfig}',
  RESOURCE_NAME: '{resource}',
  RESOURCE_GROUP: '{group}',
  RESOURCE_VERSION: '{version}',
};
const K9S_FIELDS = new Set([
  'shortCut',
  'description',
  'scopes',
  'command',
  'args',
  'background',
  'confirm',
  'dangerous',
]);

function importK9s(text: string): CustomActionImport {
  const doc = YAML.parse(text) as Record<string, unknown> | null;
  const plugins = (doc?.plugins ?? doc) as Record<string, Record<string, unknown>> | null;
  if (!plugins || typeof plugins !== 'object')
    throw new Error('the file is neither a Kubepit export nor a k9s plugins file');
  const actions: CustomAction[] = [];
  const notes: CustomActionImportNote[] = [];
  for (const [key, plugin] of Object.entries(plugins)) {
    const name = String(plugin?.description ?? key);
    const note = (code: CustomActionImportNote['code'], detail: string) =>
      notes.push({ action: name, code, detail });
    if (!plugin || typeof plugin !== 'object' || !plugin.command) {
      note('invalid-plugin', 'command is missing');
      continue;
    }
    for (const field of Object.keys(plugin))
      if (!K9S_FIELDS.has(field)) note('unsupported-field', field);
    const scopes: string[] = [];
    for (const raw of (plugin.scopes as string[] | undefined) ?? []) {
      const scope = K9S_SCOPES[String(raw).toLowerCase()];
      if (scope) scopes.push(scope);
      else note('unsupported-scope', String(raw));
    }
    if (!scopes.length) {
      note('no-scope', ((plugin.scopes as string[] | undefined) ?? []).join(', '));
      continue;
    }
    const args = ((plugin.args as unknown[] | undefined) ?? []).map(String);
    const shell = /(^|\/)(ba|z|da|k)?sh$/.test(String(plugin.command)) && args[0] === '-c';
    const words = shell ? [args[1] ?? ''] : [String(plugin.command), ...args];
    const command = words
      .map((w) =>
        w.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (whole, v: string) => {
          if (K9S_VARS[v]) return K9S_VARS[v]!;
          if (['FILTER', 'USER', 'GROUPS'].includes(v)) note('unsupported-variable', whole);
          return whole;
        }),
      )
      .join(' ');
    const raw = plugin.shortCut ? String(plugin.shortCut) : null;
    const shortcut = raw ? normalizeChord(raw.replace(/-/g, '+')) : null;
    if (raw && !shortcut) note('invalid-shortcut', raw);
    actions.push({
      id: `k9s-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      description: '',
      icon: 'terminal',
      enabled: true,
      scopes: [...new Set(scopes)],
      namespaces: [],
      cluster_tags: [],
      command,
      mode: plugin.background ? 'background' : 'terminal',
      confirm: !!plugin.confirm,
      mutating: !!plugin.dangerous,
      shortcut,
      timeout_secs: 30,
    });
  }
  return { format: 'k9s', actions, notes };
}

function importText(text: string): CustomActionImport {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return importK9s(text);
  }
  const items = Array.isArray(json)
    ? json
    : (json as { actions?: unknown }).actions instanceof Array
      ? ((json as { actions: unknown[] }).actions as unknown[])
      : null;
  if (!items) throw new Error('the file is not a Kubepit custom actions export');
  const actions: CustomAction[] = [];
  const notes: CustomActionImportNote[] = [];
  for (const item of items as Partial<CustomAction>[]) {
    if (!item.name?.trim() || !item.command?.trim()) {
      notes.push({
        action: item.name ?? '',
        code: 'invalid-action',
        detail: 'the name or command is empty',
      });
      continue;
    }
    actions.push({
      ...builtinExamples()[0]!,
      enabled: true,
      shortcut: null,
      ...item,
      id: item.id || crypto.randomUUID(),
    } as CustomAction);
  }
  return { format: 'kubepit', actions, notes };
}

// -- Terminal runs -----------------------------------------------------------

const encoder = new TextEncoder();
const b64 = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));

const createTerminal = handlers.terminal_create;
register({
  terminal_create: (args: MockArgs) => {
    if (args.spec?.kind !== 'custom-action') return createTerminal?.(args);
    const emit = args.onOutput as (o: TerminalOutput) => void;
    const { cluster_id, action_id, target } = args.spec as {
      cluster_id: string;
      action_id: string;
      target: CustomActionTarget;
    };
    const { action, cluster } = runnable(cluster_id, action_id, target);
    const { command } = resolve(action, cluster, target);
    const out = (text: string) =>
      emit({ stream_id: args.streamId, data: b64(text.replace(/\r?\n/g, '\r\n')) });
    void (async () => {
      await sleep(80);
      out(`\x1b[2m$ ${command}\x1b[0m\n\n`);
      await sleep(250);
      const result = await simulate(cluster_id, command, target);
      if (result.stdout) out(result.stdout);
      if (result.stderr) out(`\x1b[31m${result.stderr}\x1b[0m`);
      await sleep(150);
      mockEmit('terminal://exit', { id: args.id, code: result.exit });
    })();
    return undefined;
  },
});

register({
  custom_actions_list: () => current(),
  custom_actions_save: ({ actions }: MockArgs) => {
    const list = actions as CustomAction[];
    for (const a of list) {
      if (!a.name?.trim()) throw new Error(`${a.id}: the name is empty`);
      if (!a.command?.trim()) throw new Error(`${a.name}: the command is empty`);
      if (!a.scopes?.length) throw new Error(`${a.name}: choose at least one scope`);
      if (a.mode === 'open-url' && !/^https?:\/\//i.test(a.command.trim()))
        throw new Error(`${a.name}: the URL must start with http:// or https://`);
    }
    const ids = new Set<string>();
    for (const a of list) {
      if (ids.has(a.id)) throw new Error(`${a.name}: another action has the id "${a.id}"`);
      ids.add(a.id);
    }
    const saved = list.map((a) => ({
      ...a,
      name: a.name.trim(),
      command: a.command.trim(),
      shortcut: a.shortcut ? normalizeChord(a.shortcut) : null,
    }));
    state = { actions: saved, initialized: true };
    mockEmitAllWindows('customactions://changed', saved);
    return saved;
  },
  custom_actions_import: ({ path, text }: MockArgs) => {
    if (typeof text === 'string') return importText(text);
    throw new Error(`Demo backend: cannot read ${String(path)} in the browser preview.`);
  },
  custom_action_resolve: ({ action, clusterId, target }: MockArgs) =>
    resolve(
      action as CustomAction,
      clusterById(clusterId as string | null),
      target as CustomActionTarget,
    ),
  custom_action_run: async ({
    clusterId,
    actionId,
    target,
  }: MockArgs): Promise<CustomActionResult> => {
    const t = target as CustomActionTarget;
    const { action, cluster } = runnable(clusterId as string, actionId as string, t);
    const { command } = resolve(action, cluster, t);
    if (action.mode === 'terminal')
      throw new Error(`the custom action "${action.name}" runs in a terminal`);
    const base = { mode: action.mode, command, timed_out: false, truncated: false };
    if (action.mode === 'open-url')
      return { ...base, exit_code: null, stdout: '', stderr: '', duration_ms: 0 };
    const started = Date.now();
    await sleep(500 + Math.random() * 700);
    const result = await simulate(clusterId as string, command, t);
    return {
      ...base,
      exit_code: result.exit,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: Date.now() - started,
    };
  },
});
