import type {
  ClusterDef,
  KubeObject,
  PodDebugRequest,
  PodDirListing,
  PodFileContent,
  PodFsEntry,
  PodFsTransfer,
  WatchBatch,
  WorkloadLogBatch,
  WorkloadLogEvent,
  WorkloadLogOptions,
} from '@/types';
import { sleep } from './bus';
import { generatorFor, rfc3339Nano } from './dock';
import { addWatcher, find, getDb, list, put, removeWatcher } from './fixtures/db';
import { ensureLiveness } from './fixtures/live';
import { hashString, nowIso, seeded } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo backend for the logs & debug features: merged workload logs that
 * follow the fixture pods (scale, restarts, crash loops), ephemeral debug
 * containers patched into fixture pods, and a believable fake container
 * file system per image.
 */

function assertWritable(clusterId: string, action: string) {
  const clusters = (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
  const cluster = clusters.find((c) => c.id === clusterId);
  if (cluster?.read_only)
    throw new Error(`Cluster "${cluster.name}" is read-only: ${action} is not allowed`);
}

const rand = (n: number) => Math.floor(Math.random() * n);

// ---------------------------------------------------------------------------
// Label selectors (equality and set based)
// ---------------------------------------------------------------------------

function selectorMatcher(selector: string): (labels: Record<string, string>) => boolean {
  const terms = selector.match(/[^,(]+(?:\([^)]*\))?/g)?.map((t) => t.trim()) ?? [];
  const tests = terms.filter(Boolean).map((term) => {
    const set = /^(\S+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(term);
    if (set) {
      const values = set[3]!.split(',').map((v) => v.trim());
      return (l: Record<string, string>) =>
        set[2] === 'in' ? values.includes(l[set[1]!] ?? '\u0000') : !values.includes(l[set[1]!]!);
    }
    const ne = term.split('!=');
    if (ne.length === 2) return (l: Record<string, string>) => l[ne[0]!.trim()] !== ne[1]!.trim();
    const eq = term.split(/==?/);
    if (eq.length === 2) return (l: Record<string, string>) => l[eq[0]!.trim()] === eq[1]!.trim();
    if (term.startsWith('!')) return (l: Record<string, string>) => !(term.slice(1) in l);
    return (l: Record<string, string>) => term in l;
  });
  return (labels) => tests.every((test) => test(labels));
}

// ---------------------------------------------------------------------------
// Workload logs
// ---------------------------------------------------------------------------

interface ContainerStatusLike {
  name: string;
  containerID?: string;
  restartCount?: number;
  state?: Record<string, unknown>;
}

interface MockSource {
  pod: string;
  container: string;
  instance: string | null;
  live: boolean;
  announced: boolean;
  skipped: boolean;
}

const MAX_SOURCES = 64;
const workloadStreams = new Map<string, () => void>();

function containerViews(pod: KubeObject, options: WorkloadLogOptions) {
  const statuses = new Map<string, ContainerStatusLike>();
  for (const s of [
    ...((pod.status?.containerStatuses as ContainerStatusLike[] | undefined) ?? []),
    ...((pod.status?.initContainerStatuses as ContainerStatusLike[] | undefined) ?? []),
  ])
    statuses.set(s.name, s);
  const names = [
    ...(options.init_containers
      ? ((pod.spec?.initContainers as Array<{ name: string }> | undefined) ?? [])
      : []),
    ...((pod.spec?.containers as Array<{ name: string }> | undefined) ?? []),
  ]
    .map((c) => c.name)
    .filter((n) => !options.containers.length || options.containers.includes(n));
  return names.map((name) => {
    const s = statuses.get(name);
    const running = !!s?.state && 'running' in s.state;
    return {
      name,
      running,
      instance: s?.containerID ? `${s.containerID}#${s.restartCount ?? 0}` : null,
    };
  });
}

function startWorkloadLogs(args: MockArgs): string {
  const id = crypto.randomUUID();
  const clusterId = String(args.clusterId);
  const namespace = String(args.namespace);
  const options = args.options as WorkloadLogOptions;
  const emit = args.onEvent as (batch: WorkloadLogBatch) => void;
  const matches = selectorMatcher(String(args.selector));
  const db = getDb(clusterId);
  const sources = new Map<string, MockSource>();
  const podsByUid = new Map<string, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let pending: WorkloadLogEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const flush = () => {
    flushTimer = null;
    if (stopped || pending.length === 0) return;
    const events = pending;
    pending = [];
    emit({ stream_id: id, events, done: false, error: null });
  };
  const push = (event: Omit<WorkloadLogEvent, 'lines' | 'message'> & Partial<WorkloadLogEvent>) => {
    pending.push({ lines: [], message: null, ...event });
    flushTimer ??= setTimeout(flush, 100);
  };
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timers.add(timer);
  };
  const render = (ts: Date, lines: string[]) =>
    lines.map((line) => (options.timestamps ? `${rfc3339Nano(ts)} ${line}` : line));
  const liveCount = () => [...sources.values()].filter((s) => s.live).length;

  const follow = (source: MockSource, instance: string) => {
    const gen = generatorFor(source.pod, source.container);
    const tick = () => {
      if (!source.live || source.instance !== instance) return;
      const ts = new Date();
      push({
        kind: 'lines',
        pod: source.pod,
        container: source.container,
        lines: render(ts, gen(ts)),
      });
      later(600 + rand(2_400), tick);
    };
    later(400 + rand(1_500), tick);
  };

  const start = (source: MockSource, instance: string, backlog: boolean) => {
    source.instance = instance;
    source.live = true;
    source.skipped = false;
    source.announced = true;
    push({ kind: 'source-added', pod: source.pod, container: source.container });
    const gen = generatorFor(source.pod, source.container);
    const count = backlog ? Math.min(options.tail_lines ?? 400, 400) : 6;
    const lines: string[] = [];
    let t = Date.now();
    const stamps: Date[] = [];
    for (let i = 0; i < count; i++) stamps.push(new Date((t -= 800 + rand(4_000))));
    stamps.reverse();
    const since = options.since_seconds ? Date.now() - options.since_seconds * 1000 : 0;
    for (const ts of stamps) if (ts.getTime() >= since) lines.push(...render(ts, gen(ts)));
    if (lines.length)
      later(120 + rand(200), () =>
        push({ kind: 'lines', pod: source.pod, container: source.container, lines }),
      );
    follow(source, instance);
  };

  const reconcile = (pod: KubeObject) => {
    const name = pod.metadata.name;
    for (const view of containerViews(pod, options)) {
      const key = `${name}/${view.name}`;
      let source = sources.get(key);
      if (!source) {
        source = {
          pod: name,
          container: view.name,
          instance: null,
          live: false,
          announced: false,
          skipped: false,
        };
        sources.set(key, source);
      }
      if (source.live && !view.running) {
        // The container crashed: its stream ends, a restart re-adds it.
        source.live = false;
        const ts = new Date();
        push({
          kind: 'lines',
          pod: name,
          container: view.name,
          lines: render(ts, [
            'panic: runtime error: invalid memory address or nil pointer dereference',
            '[signal SIGSEGV: segmentation violation code=0x1 addr=0x18 pc=0x9a3f12]',
          ]),
        });
        push({ kind: 'source-ended', pod: name, container: view.name });
        continue;
      }
      if (!view.running || !view.instance || source.live || source.instance === view.instance)
        continue;
      if (liveCount() >= MAX_SOURCES) {
        if (!source.skipped) {
          source.skipped = true;
          push({ kind: 'source-skipped', pod: name, container: view.name });
        }
        continue;
      }
      start(source, view.instance, source.instance === null);
    }
  };

  const remove = (podName: string) => {
    for (const [key, source] of sources) {
      if (source.pod !== podName) continue;
      source.live = false;
      if (source.announced || source.skipped)
        push({ kind: 'source-removed', pod: podName, container: source.container });
      sources.delete(key);
    }
  };

  const inScope = (pod: KubeObject) =>
    pod.metadata.namespace === namespace && matches(pod.metadata.labels ?? {});

  const watchId = addWatcher(clusterId, 'pods', [namespace], (batch: WatchBatch) => {
    if (stopped) return;
    for (const pod of batch.upserts) {
      if (inScope(pod)) {
        podsByUid.set(pod.metadata.uid, pod.metadata.name);
        reconcile(pod);
      } else if (podsByUid.has(pod.metadata.uid)) remove(pod.metadata.name);
    }
    for (const uid of batch.deletes) {
      const name = podsByUid.get(uid);
      podsByUid.delete(uid);
      if (name) remove(name);
    }
  });
  ensureLiveness();

  later(250 + rand(250), () => {
    const pods = list(db, 'pods')
      .filter(inScope)
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    for (const pod of pods) {
      podsByUid.set(pod.metadata.uid, pod.metadata.name);
      reconcile(pod);
    }
  });

  workloadStreams.set(id, () => {
    stopped = true;
    timers.forEach(clearTimeout);
    if (flushTimer) clearTimeout(flushTimer);
    removeWatcher(watchId);
  });
  return id;
}

// ---------------------------------------------------------------------------
// Debug containers
// ---------------------------------------------------------------------------

async function podDebug(args: MockArgs): Promise<string> {
  const clusterId = String(args.clusterId);
  assertWritable(clusterId, 'starting a debug container');
  const request = args.request as PodDebugRequest;
  const db = getDb(clusterId);
  const pod = find(db, 'pods', args.namespace, String(args.pod));
  if (!pod) throw new Error(`pods "${String(args.pod)}" not found`);
  const image =
    request.image.trim() ||
    ((handlers.settings_get?.({}) as { debug_image?: string } | undefined)?.debug_image ??
      'docker.io/library/busybox:1.36');
  const name = request.name?.trim() || `debugger-${Math.random().toString(36).slice(2, 7)}`;
  const spec = pod.spec as Record<string, unknown>;
  const existing = [
    ...((spec.containers as Array<{ name: string }>) ?? []),
    ...((spec.initContainers as Array<{ name: string }> | undefined) ?? []),
    ...((spec.ephemeralContainers as Array<{ name: string }> | undefined) ?? []),
  ].map((c) => c.name);
  if (existing.includes(name))
    throw new Error(`pod ${pod.metadata.name} already has a container named ${name}`);
  await sleep(350);
  const container: Record<string, unknown> = {
    name,
    image,
    stdin: true,
    tty: true,
    terminationMessagePolicy: 'File',
  };
  if (request.target_container) container.targetContainerName = request.target_container;
  if (request.command?.length) container.command = request.command;
  if (request.profile === 'netadmin')
    container.securityContext = { capabilities: { add: ['NET_ADMIN', 'NET_RAW'] } };
  if (request.profile === 'sysadmin') container.securityContext = { privileged: true };
  spec.ephemeralContainers = [...((spec.ephemeralContainers as unknown[]) ?? []), container];
  const status = (pod.status ?? {}) as Record<string, unknown>;
  const statuses = (status.ephemeralContainerStatuses as Array<Record<string, unknown>>) ?? [];
  const entry: Record<string, unknown> = {
    name,
    image,
    imageID: '',
    ready: false,
    restartCount: 0,
    state: { waiting: { reason: 'ContainerCreating' } },
  };
  status.ephemeralContainerStatuses = [...statuses, entry];
  pod.status = status;
  put(db, pod);
  await sleep(1_400);
  if (/nope|invalid|doesnotexist/.test(image)) {
    entry.state = {
      waiting: {
        reason: 'ImagePullBackOff',
        message: `Back-off pulling image "${image}"`,
      },
    };
    put(db, pod);
    throw new Error(
      `the debug container cannot start: ImagePullBackOff: Back-off pulling image "${image}"`,
    );
  }
  entry.state = { running: { startedAt: nowIso() } };
  entry.containerID = `containerd://${Math.random().toString(16).slice(2)}`;
  put(db, pod);
  return name;
}

// ---------------------------------------------------------------------------
// Container file system
// ---------------------------------------------------------------------------

type FsNode =
  | { kind: 'dir'; children: Map<string, FsNode>; mode: number; modified: number }
  | { kind: 'file'; content: string | null; size: number; mode: number; modified: number }
  | { kind: 'symlink'; target: string; mode: number; modified: number }
  | { kind: 'other'; mode: number; modified: number };

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA1klEQVR42u2XQQrCQAxFewCPKCIiRURERESKiIiIiIh4TC+hb5922nSSrDrwVj/J/6uZTFEMR3m+49EvhZ/xBAMFdsZTBmaQZz5jiAH9zOc0G6IzL2lyoJv5gmJH2gMsKXQkbb6iKIDmAGsKAqg33yAGIgNsEQKRAXYIgcgAe4RAZIADQiAyQIUQiAxwRAhEBjghBFJ/F5wRA2i+CS8UBJB+D64UOdL+Gt4odKTbTnCn2AHdVvSgyZB+e+GTZgPyNuMXQzKw+x+8GajA74f0wSDB8HnVnj9nNNQsktbLAAAAAABJRU5ErkJggg==';
const ELF = btoa('\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00');

const filesystems = new Map<string, FsNode>();

function containerSpec(pod: KubeObject, name: string | null) {
  const spec = pod.spec as Record<string, unknown>;
  const all = [
    ...((spec.containers as Array<Record<string, unknown>>) ?? []),
    ...((spec.ephemeralContainers as Array<Record<string, unknown>> | undefined) ?? []),
  ];
  return all.find((c) => c.name === name) ?? all[0];
}

function buildFs(clusterId: string, pod: KubeObject, container: Record<string, unknown>): FsNode {
  const r = seeded(`${clusterId}/${pod.metadata.name}/${String(container.name)}`);
  const now = Math.floor(Date.now() / 1000);
  const old = now - 40 * 86_400;
  const image = String(container.image ?? '');
  const alpine = /alpine|busybox|netshoot/.test(image);
  const dir = (entries: Record<string, FsNode> = {}, mode = 0o040755, modified = old): FsNode => ({
    kind: 'dir',
    children: new Map(Object.entries(entries)),
    mode,
    modified,
  });
  const file = (content: string, mode = 0o100644, modified = old): FsNode => ({
    kind: 'file',
    content,
    size: new TextEncoder().encode(content).length,
    mode,
    modified,
  });
  const bin = (size: number, modified = old): FsNode => ({
    kind: 'file',
    content: null,
    size,
    mode: 0o100755,
    modified,
  });
  const link = (target: string): FsNode => ({
    kind: 'symlink',
    target,
    mode: 0o120777,
    modified: old,
  });
  const ns = pod.metadata.namespace ?? 'default';
  const tools = alpine
    ? ['busybox', 'sh', 'ls', 'cat', 'wget', 'nc', 'ps', 'top', 'vi', 'tar']
    : ['bash', 'cat', 'ls', 'ps', 'grep', 'sed', 'tar', 'curl', 'sh'];
  const binDir = dir(
    Object.fromEntries(
      tools.map((t, i) => [
        t,
        alpine && i > 0 ? link('/bin/busybox') : bin(40_000 + Math.floor(r() * 900_000)),
      ]),
    ),
  );
  const etc = dir({
    hostname: file(`${pod.metadata.name}\n`),
    hosts: file(
      `127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${String(pod.status?.podIP ?? '10.244.1.7')}\t${pod.metadata.name}\n`,
    ),
    'resolv.conf': file(
      `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`,
    ),
    'os-release': file(
      alpine
        ? 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n'
        : 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
    ),
    passwd: file(
      'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\napp:x:10001:10001::/app:/sbin/nologin\n',
    ),
    group: file('root:x:0:\nnogroup:x:65534:\napp:x:10001:\n'),
    shadow: {
      kind: 'file',
      content: 'root:*:19000:0:99999:7:::\n',
      size: 26,
      mode: 0o100640,
      modified: old,
    },
    ...(image.includes('nginx')
      ? {
          nginx: dir({
            'nginx.conf': file(
              'user  nginx;\nworker_processes  auto;\n\nevents {\n    worker_connections  1024;\n}\n\nhttp {\n    include       /etc/nginx/mime.types;\n    sendfile        on;\n    keepalive_timeout  65;\n    include /etc/nginx/conf.d/*.conf;\n}\n',
            ),
            'conf.d': dir({
              'default.conf': file(
                'server {\n    listen       80;\n    server_name  localhost;\n\n    location / {\n        root   /usr/share/nginx/html;\n        index  index.html;\n    }\n\n    location /healthz {\n        return 200 "ok";\n    }\n}\n',
              ),
            }),
          }),
        }
      : {}),
  });
  const logs: Record<string, FsNode> = {};
  const gen = generatorFor(pod.metadata.name, String(container.name));
  for (const name of ['app.log', 'access.log']) {
    const lines: string[] = [];
    let t = Date.now() - 3_600_000;
    for (let i = 0; i < 60; i++) lines.push(...gen(new Date((t += 40_000))));
    logs[name] = file(`${lines.join('\n')}\n`, 0o100644, now - Math.floor(r() * 600));
  }
  logs['app.log.1.gz'] = bin(180_000 + Math.floor(r() * 400_000), now - 86_400);
  const app = dir(
    {
      'package.json': file(
        `{\n  "name": "${String(container.name)}",\n  "version": "1.9.0",\n  "private": true,\n  "main": "dist/server.js",\n  "scripts": {\n    "start": "node dist/server.js"\n  },\n  "dependencies": {\n    "express": "^4.21.2",\n    "pino": "^9.5.0",\n    "redis": "^4.7.0"\n  }\n}\n`,
      ),
      dist: dir({
        'server.js': file(
          "'use strict';\nconst express = require('express');\nconst pino = require('pino')();\n\nconst app = express();\napp.get('/healthz', (_req, res) => res.send('ok'));\napp.get('/api/cart/:id', async (req, res) => {\n  pino.info({ id: req.params.id }, 'request completed');\n  res.json({ id: req.params.id, items: [] });\n});\n\napp.listen(process.env.PORT ?? 8080, () => pino.info('listening'));\n",
        ),
      }),
      public: dir({
        'logo.png': { kind: 'file', content: null, size: 271, mode: 0o100644, modified: old },
      }),
      'config.yaml': file(
        `server:\n  port: 8080\n  shutdownTimeout: 30s\nlog:\n  level: info\n  format: json\nredis:\n  url: redis://redis.${ns}.svc:6379\n`,
      ),
      node_modules: dir(),
      'My Notes.txt': file('Files with spaces in their names work too.\n'),
    },
    0o040755,
    now - 3_600,
  );
  const mounts: Record<string, FsNode> = {};
  for (const m of (container.volumeMounts as Array<{ name: string; mountPath: string }>) ?? []) {
    const volume = ((pod.spec?.volumes as Array<Record<string, unknown>>) ?? []).find(
      (v) => v.name === m.name,
    );
    const cm = volume?.configMap as { name?: string } | undefined;
    const configMap = cm?.name ? find(getDb(clusterId), 'configmaps', ns, cm.name) : undefined;
    const data = (configMap?.data as Record<string, string> | undefined) ?? {};
    mounts[m.mountPath] = dir(
      Object.fromEntries(Object.entries(data).map(([k, v]) => [k, file(v, 0o100644, now - 7_200)])),
    );
  }
  const root = dir({
    app,
    bin: binDir,
    dev: dir({
      null: { kind: 'other', mode: 0o020666, modified: now },
      tty: { kind: 'other', mode: 0o020666, modified: now },
    }),
    etc,
    home: dir(),
    lib: alpine ? dir({ 'ld-musl-x86_64.so.1': bin(600_000) }) : link('usr/lib'),
    proc: dir(
      {
        cpuinfo: {
          kind: 'file',
          content:
            'processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz\n',
          size: 0,
          mode: 0o100444,
          modified: now,
        },
        '1': dir({}, 0o040555, now),
      },
      0o040555,
      now,
    ),
    root: dir({}, 0o040700),
    run: dir({ 'app.sock': { kind: 'other', mode: 0o140755, modified: now } }),
    tmp: dir({}, 0o041777, now - 600),
    usr: dir({
      bin: dir(),
      lib: dir(),
      share: dir({
        nginx: dir({
          html: dir({
            'index.html': file('<!doctype html>\n<title>Welcome</title>\n<h1>It works</h1>\n'),
          }),
        }),
      }),
    }),
    var: dir({
      log: dir(logs),
      run: link('/run'),
      lib: dir(),
    }),
  });
  // Mount volumes (configMaps with their real keys) and the service account.
  const attach = (path: string, node: FsNode) => {
    const parts = path.split('/').filter(Boolean);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (at.kind !== 'dir') return;
      let next = at.children.get(part);
      if (!next || next.kind !== 'dir') {
        next = dir();
        at.children.set(part, next);
      }
      at = next;
    }
    if (at.kind === 'dir' && parts.length) at.children.set(parts[parts.length - 1]!, node);
  };
  for (const [path, node] of Object.entries(mounts)) attach(path, node);
  attach(
    '/var/run/secrets/kubernetes.io/serviceaccount',
    dir({
      namespace: file(ns),
      token: file(
        `eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.${btoa(pod.metadata.name)}.c2lnbmF0dXJl`,
        0o100600,
      ),
      'ca.crt': file(
        '-----BEGIN CERTIFICATE-----\nMIIC/jCCAeagAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJl\n-----END CERTIFICATE-----\n',
      ),
    }),
  );
  return root;
}

function fsFor(args: MockArgs): { root: FsNode; cwd: string } {
  const clusterId = String(args.clusterId);
  const pod = find(getDb(clusterId), 'pods', args.namespace, String(args.pod));
  if (!pod) throw new Error(`pods "${String(args.pod)}" not found`);
  const container = containerSpec(pod, (args.container as string | null) ?? null);
  if (!container) throw new Error(`pod ${pod.metadata.name} has no containers`);
  const image = String(container.image ?? '');
  if (/registry\.k8s\.io\/|csi-components|kindnetd|distroless/.test(image))
    throw new Error(
      `container "${String(container.name)}" has no shell (sh), so its files cannot be browsed; start a debug container to inspect it`,
    );
  const running = [
    ...((pod.status?.containerStatuses as ContainerStatusLike[] | undefined) ?? []),
    ...((pod.status?.ephemeralContainerStatuses as ContainerStatusLike[] | undefined) ?? []),
  ].find((s) => s.name === container.name);
  if (!running?.state || !('running' in running.state))
    throw new Error(
      `cannot exec into ${pod.metadata.name}: container ${String(container.name)} is not running`,
    );
  const key = `${clusterId}/${pod.metadata.uid}/${String(container.name)}`;
  let root = filesystems.get(key);
  if (!root) {
    root = buildFs(clusterId, pod, container);
    filesystems.set(key, root);
  }
  return { root, cwd: String(container.workingDir ?? '/app') };
}

function normalize(path: string, cwd: string): string {
  const out: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function lookup(root: FsNode, path: string, follow = true, depth = 0): FsNode | null {
  let node: FsNode = root;
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (node.kind === 'symlink') {
      if (depth > 8) return null;
      const target = normalize(node.target, `/${parts.slice(0, i - 1).join('/')}`);
      const resolved = lookup(root, target, true, depth + 1);
      if (!resolved) return null;
      node = resolved;
    }
    if (node.kind !== 'dir') return null;
    const next = node.children.get(parts[i]!);
    if (!next) return null;
    node = next;
  }
  if (follow && node.kind === 'symlink' && depth < 8) {
    const parent = `/${parts.slice(0, -1).join('/')}`;
    return lookup(root, normalize(node.target, parent), true, depth + 1);
  }
  return node;
}

function modeString(mode: number): string {
  const type = mode & 0o170000;
  const kind =
    type === 0o040000
      ? 'd'
      : type === 0o120000
        ? 'l'
        : type === 0o020000
          ? 'c'
          : type === 0o140000
            ? 's'
            : '-';
  let out = kind;
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7;
    out += bits & 4 ? 'r' : '-';
    out += bits & 2 ? 'w' : '-';
    out += shift === 0 && mode & 0o1000 ? (bits & 1 ? 't' : 'T') : bits & 1 ? 'x' : '-';
  }
  return out;
}

function sizeOf(node: FsNode): number {
  if (node.kind === 'file') return node.size;
  if (node.kind === 'dir') return [...node.children.values()].reduce((n, c) => n + sizeOf(c), 0);
  return 0;
}

async function fsList(args: MockArgs): Promise<PodDirListing> {
  await sleep(160 + rand(160));
  const { root, cwd } = fsFor(args);
  const path = normalize(String(args.path ?? '') || cwd, cwd);
  const node = lookup(root, path);
  if (!node) throw new Error(`no such file or directory: ${String(args.path)}`);
  if (node.kind !== 'dir') throw new Error(`not a directory: ${String(args.path)}`);
  if (node.mode === 0o040700 && path === '/root') throw new Error(`permission denied: ${path}`);
  const entries: PodFsEntry[] = [...node.children.entries()].map(([name, child]) => {
    const resolved = child.kind === 'symlink' ? lookup(root, normalize(child.target, path)) : null;
    return {
      name,
      kind: child.kind,
      size:
        child.kind === 'dir'
          ? 4096
          : child.kind === 'symlink'
            ? child.target.length
            : sizeOf(child),
      mode: modeString(child.mode),
      modified: child.modified,
      link_target: child.kind === 'symlink' ? child.target : null,
      link_to_dir: resolved?.kind === 'dir',
    };
  });
  const dirLike = (e: PodFsEntry) => (e.kind === 'dir' || e.link_to_dir ? 0 : 1);
  entries.sort(
    (a, b) => dirLike(a) - dirLike(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return { path, entries, truncated: false };
}

async function fsRead(args: MockArgs): Promise<PodFileContent> {
  await sleep(120 + rand(120));
  const { root, cwd } = fsFor(args);
  const path = normalize(String(args.path), cwd);
  const node = lookup(root, path);
  if (!node) throw new Error(`no such file or directory: ${path}`);
  if (node.kind === 'dir') throw new Error(`is a directory: ${path}`);
  if (node.kind !== 'file') throw new Error(`not a regular file: ${path}`);
  if (node.mode === 0o100640 && path === '/etc/shadow')
    throw new Error(`permission denied: ${path}`);
  if (node.content !== null)
    return {
      path,
      size: node.size || null,
      text: node.content,
      base64: null,
      truncated: false,
      binary: false,
    };
  const base64 = path.endsWith('.png') ? PNG : ELF;
  return {
    path,
    size: node.size,
    text: null,
    base64,
    truncated: node.size > 271 || !path.endsWith('.png'),
    binary: true,
  };
}

async function fsDownload(args: MockArgs): Promise<PodFsTransfer> {
  await sleep(500);
  const { root, cwd } = fsFor(args);
  const node = lookup(root, normalize(String(args.remotePath), cwd));
  if (!node) throw new Error(`no such file or directory: ${String(args.remotePath)}`);
  return {
    path: String(args.localPath),
    bytes: node.kind === 'dir' ? sizeOf(node) + 10_240 : sizeOf(node),
    archive: node.kind === 'dir',
  };
}

async function fsUpload(args: MockArgs): Promise<PodFsTransfer> {
  assertWritable(String(args.clusterId), 'uploading files');
  await sleep(600);
  const { root, cwd } = fsFor(args);
  const dir = normalize(String(args.remoteDir || cwd), cwd);
  const node = lookup(root, dir);
  if (!node || node.kind !== 'dir') throw new Error(`not a directory: ${dir}`);
  const name = String(args.localPath).split(/[\\/]/).pop() || 'upload.bin';
  const size = 1_024 + (hashString(name) % 400_000);
  node.children.set(name, {
    kind: 'file',
    content: null,
    size,
    mode: 0o100644,
    modified: Math.floor(Date.now() / 1000),
  });
  return { path: `${dir === '/' ? '' : dir}/${name}`, bytes: size, archive: false };
}

register({
  workload_logs_stream: (args: MockArgs) => startWorkloadLogs(args),
  workload_logs_stop: ({ streamId }: MockArgs) => {
    workloadStreams.get(streamId)?.();
    workloadStreams.delete(streamId);
  },
  save_text_file: () => undefined,
  pod_debug: (args: MockArgs) => podDebug(args),
  pod_fs_list: (args: MockArgs) => fsList(args),
  pod_fs_read: (args: MockArgs) => fsRead(args),
  pod_fs_download: (args: MockArgs) => fsDownload(args),
  pod_fs_upload: (args: MockArgs) => fsUpload(args),
});

// The demo terminal names pod-attach sessions like exec ones (wraps app.ts).
const createTerminal = handlers.terminal_create;
if (createTerminal) {
  register({
    terminal_create: (args: MockArgs) =>
      createTerminal(
        args.spec?.kind === 'pod-attach'
          ? { ...args, spec: { ...args.spec, kind: 'pod-exec', command: null } }
          : args,
      ),
  });
}
