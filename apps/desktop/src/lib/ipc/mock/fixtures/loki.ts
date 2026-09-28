import { asArray, asObject, isObject } from '@/lib/kube/accessors';
import { parseLogLine } from '@/lib/logs/parse';
import type { KubeObject, LokiService } from '@/types';
import { list, type ClusterDb } from './db';
import { buildService } from './network';
import { DAY, hashString, seeded, type Rand } from './util';

/**
 * A fake Loki for the demo clusters. Every pod of the fixture database is a
 * stream (`namespace`, `pod`, `container`, `app`, `job`, `stream` labels)
 * whose lines are a deterministic function of (stream, minute): JSON (zap /
 * slog style), logfmt, klog, nginx access logs and Spring Boot with Java
 * stack traces. Queries, "load older" pages and the volume histogram
 * therefore agree across reloads. A small LogQL subset is understood:
 * selectors with `= != =~ !~`, line filters, `| json` / `| logfmt` and
 * label filters on parsed fields, and `sum(count_over_time(… [Ns]))`.
 */

const MIN = 60_000;

// -- Services -------------------------------------------------------------------

/** The grafana/loki chart (simple scalable) in front of the EU production cluster's Loki. */
export function buildLokiServices(db: ClusterDb) {
  if (db.id !== 'c-prod-eu') return;
  buildService(db, {
    namespace: 'monitoring',
    name: 'loki-gateway',
    selector: { app: 'loki' },
    labels: { 'app.kubernetes.io/name': 'loki', 'app.kubernetes.io/component': 'gateway' },
    ports: [{ name: 'http-metrics', port: 80, targetPort: 3100 }],
    age: 45 * DAY,
  });
  buildService(db, {
    namespace: 'monitoring',
    name: 'loki-read',
    selector: { app: 'loki' },
    labels: { 'app.kubernetes.io/name': 'loki', 'app.kubernetes.io/component': 'read' },
    ports: [
      { name: 'http-metrics', port: 3100 },
      { name: 'grpc', port: 9095 },
    ],
    age: 45 * DAY,
  });
}

const NOT_QUERY_PATH =
  /headless|memberlist|canary|-write|-backend|ingester|distributor|compactor|index-gateway|ruler|cache|promtail|alloy|fluent/;

/** The backend's detection ranking, simplified. */
export function detectLokiServices(db: ClusterDb): LokiService[] {
  const out: Array<LokiService & { score: number }> = [];
  for (const svc of list(db, 'services')) {
    const name = svc.metadata.name;
    if (NOT_QUERY_PATH.test(name)) continue;
    const labels = svc.metadata.labels ?? {};
    const component = labels['app.kubernetes.io/component'] ?? '';
    let kind: LokiService['kind'] | null = null;
    let score = 0;
    if (name.endsWith('loki-gateway') || component === 'gateway') [kind, score] = ['gateway', 100];
    else if (name.includes('loki') && name.includes('query-frontend'))
      [kind, score] = ['query-frontend', 90];
    else if (name.endsWith('loki-read') || component === 'read') [kind, score] = ['read', 85];
    else if (name === 'loki' || name.endsWith('-loki')) [kind, score] = ['loki', 80];
    if (!kind) continue;
    const ports = asArray(asObject(svc.spec).ports).filter(isObject);
    const port = Number((ports.find((p) => p.name === 'http-metrics') ?? ports[0])?.port ?? 0);
    if (!port) continue;
    out.push({
      kind,
      namespace: svc.metadata.namespace ?? 'default',
      service: name,
      port,
      scheme: 'http',
      path_prefix: '',
      score,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || a.service.localeCompare(b.service))
    .map(({ score: _score, ...service }) => service);
}

// -- Streams ----------------------------------------------------------------------

type Format = 'json' | 'logfmt' | 'klog' | 'nginx' | 'java';

export interface Stream {
  key: string;
  labels: Record<string, string>;
  format: Format;
  /** Lines per minute at peak. */
  rate: number;
}

function formatFor(pod: string, container: string): Format {
  const key = `${pod} ${container}`.toLowerCase();
  if (/nginx|ingress|web|frontend|gateway|envoy|proxy/.test(key)) return 'nginx';
  if (/java|spring|payment|kafka|billing|order/.test(key)) return 'java';
  if (/kube-|etcd|scheduler|cert-manager|coredns|csi|kubelet/.test(key)) return 'klog';
  if (/worker|cart|checkout|queue|redis|cron|job/.test(key)) return 'logfmt';
  return hashString(key) % 2 ? 'json' : 'logfmt';
}

/** Every container of every pod as a stream. */
export function allStreams(db: ClusterDb): Stream[] {
  const out: Stream[] = [];
  for (const pod of list(db, 'pods') as KubeObject[]) {
    const namespace = pod.metadata.namespace ?? 'default';
    const labels = pod.metadata.labels ?? {};
    const app = labels['app.kubernetes.io/name'] ?? labels.app ?? '';
    for (const c of asArray(asObject(pod.spec).containers).filter(isObject)) {
      const container = String(c.name ?? '');
      const key = `${namespace}/${pod.metadata.name}/${container}`;
      const streamLabels: Record<string, string> = {
        namespace,
        pod: pod.metadata.name,
        container,
        stream: 'stdout',
      };
      if (app) {
        streamLabels.app = app;
        streamLabels.job = `${namespace}/${app}`;
      }
      out.push({
        key,
        labels: streamLabels,
        format: formatFor(pod.metadata.name, container),
        rate: 2 + (hashString(key) % 9),
      });
    }
  }
  return out;
}

export const LOKI_LABELS = ['app', 'container', 'job', 'namespace', 'pod', 'stream'];

// -- Line generators ------------------------------------------------------------------

const pickOf = <T>(r: Rand, items: readonly T[]) => items[Math.floor(r() * items.length)]!;
const hex = (r: Rand, n: number) =>
  Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function levelRoll(r: Rand): 'debug' | 'info' | 'warn' | 'error' {
  const x = r();
  return x < 0.12 ? 'debug' : x < 0.86 ? 'info' : x < 0.95 ? 'warn' : 'error';
}

function jsonLine(r: Rand, ts: Date, s: Stream): string[] {
  const level = levelRoll(r);
  const base = {
    time: ts.toISOString(),
    level: level.toUpperCase(),
    msg: '',
    service: s.labels.app || s.labels.container,
  };
  if (level === 'error')
    return [
      JSON.stringify({
        ...base,
        msg: 'request failed',
        error: pickOf(r, [
          'context deadline exceeded',
          'connection reset by peer',
          'pq: too many connections for role "app"',
        ]),
        method: 'POST',
        path: pickOf(r, ['/api/v1/orders', '/api/v1/cart/items', '/api/v1/payments']),
        status: 500,
        duration_ms: 3000 + Math.floor(r() * 2000),
        trace_id: hex(r, 32),
      }),
    ];
  if (level === 'warn')
    return [
      JSON.stringify({
        ...base,
        msg: pickOf(r, ['slow request', 'retrying upstream call', 'cache miss storm']),
        path: pickOf(r, ['/api/v1/inventory', '/api/v1/search', '/api/v1/users/me']),
        duration_ms: 800 + Math.floor(r() * 1500),
        attempt: 1 + Math.floor(r() * 3),
      }),
    ];
  return [
    JSON.stringify({
      ...base,
      msg: level === 'debug' ? 'cache lookup' : 'request served',
      method: pickOf(r, ['GET', 'GET', 'GET', 'POST', 'PUT']),
      path: pickOf(r, ['/api/v1/orders', '/api/v1/cart', '/healthz', '/api/v1/users/42']),
      status: pickOf(r, [200, 200, 200, 201, 204, 304, 404]),
      duration_ms: Math.floor(r() * 120),
      user: { id: Math.floor(r() * 9000) + 1000, tier: pickOf(r, ['free', 'pro', 'team']) },
      trace_id: hex(r, 32),
    }),
  ];
}

function logfmtLine(r: Rand, ts: Date, s: Stream): string[] {
  const level = levelRoll(r);
  const t = ts.toISOString();
  if (level === 'error')
    return [
      `time=${t} level=error msg="job failed" queue=${pickOf(r, ['emails', 'invoices', 'thumbnails'])} job_id=${hex(r, 8)} attempt=${1 + Math.floor(r() * 5)} err="redis: connection pool timeout"`,
    ];
  if (level === 'warn')
    return [
      `time=${t} level=warn msg="queue backlog growing" queue=${pickOf(r, ['emails', 'invoices'])} depth=${200 + Math.floor(r() * 800)} consumers=${1 + Math.floor(r() * 4)}`,
    ];
  return [
    `time=${t} level=${level} msg="${level === 'debug' ? 'poll' : 'job done'}" queue=${pickOf(r, ['emails', 'invoices', 'thumbnails'])} job_id=${hex(r, 8)} duration=${(r() * 900).toFixed(1)}ms component=${s.labels.container}`,
  ];
}

function klogLine(r: Rand, ts: Date): string[] {
  const level = levelRoll(r);
  const letter = level === 'error' ? 'E' : level === 'warn' ? 'W' : 'I';
  const head = `${letter}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())} ${pad(ts.getUTCHours())}:${pad(ts.getUTCMinutes())}:${pad(ts.getUTCSeconds())}.${pad(ts.getUTCMilliseconds(), 3)}${pad(Math.floor(r() * 1000), 3)}       1`;
  if (letter === 'E')
    return [
      `${head} leaderelection.go:340] "Failed to update lock" err="context deadline exceeded" lease="kube-system/${pickOf(r, ['cert-manager-controller', 'kube-scheduler'])}"`,
    ];
  if (letter === 'W')
    return [
      `${head} reflector.go:561] "Watch ended with an error" resource="*v1.Secret" err="http2: client connection lost"`,
    ];
  return [
    `${head} ${pickOf(r, ['controller.go:197] "Starting workers" controller="certificate" worker_count=2', 'sync.go:112] "Synced object" kind="Certificate" key="checkout/cart-tls"', 'server.go:87] "Handled request" verb="GET" code=200 latency="3.1ms"'])}`,
  ];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function nginxLine(r: Rand, ts: Date): string[] {
  const status = pickOf(r, [200, 200, 200, 200, 200, 204, 301, 304, 404, 499, 500, 502]);
  const path = pickOf(r, ['/', '/api/v1/orders', '/api/v1/cart', '/healthz', '/static/app.js']);
  const time = `${pad(ts.getUTCDate())}/${MONTHS[ts.getUTCMonth()]}/${ts.getUTCFullYear()}:${pad(ts.getUTCHours())}:${pad(ts.getUTCMinutes())}:${pad(ts.getUTCSeconds())} +0000`;
  return [
    `10.244.${Math.floor(r() * 4)}.${Math.floor(r() * 255)} - - [${time}] "${pickOf(r, ['GET', 'GET', 'POST'])} ${path} HTTP/1.1" ${status} ${Math.floor(r() * 40_000)} "-" "${pickOf(r, ['kube-probe/1.32', 'curl/8.7.1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)'])}"`,
  ];
}

function javaLine(r: Rand, ts: Date): string[] {
  const stamp = `${ts.toISOString().slice(0, 10)} ${ts.toISOString().slice(11, 23)}`;
  const thread = pickOf(r, ['nio-8080-exec-3', 'nio-8080-exec-7', 'scheduling-1']);
  const level = levelRoll(r);
  if (level === 'error')
    return [
      `${stamp} ERROR 1 --- [${thread}] c.a.payments.PaymentController           : Payment failed for order=${Math.floor(r() * 99_999)}`,
      `java.lang.IllegalStateException: Payment provider timeout after 3000ms`,
      '\tat com.acme.payments.provider.StripeClient.charge(StripeClient.java:118)',
      '\tat com.acme.payments.PaymentService.process(PaymentService.java:64)',
      '\t... 48 common frames omitted',
      'Caused by: java.net.SocketTimeoutException: Read timed out',
      '\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(NioSocketImpl.java:288)',
    ];
  if (level === 'warn')
    return [
      `${stamp}  WARN 1 --- [${thread}] c.a.payments.retry.RetryTemplate          : Attempt ${1 + Math.floor(r() * 3)}/3 failed for provider=stripe`,
    ];
  return [
    `${stamp} ${level === 'debug' ? 'DEBUG' : ' INFO'} 1 --- [${thread}] c.a.payments.PaymentController           : Processed payment id=pay_${hex(r, 8)} amount=${(r() * 200).toFixed(2)} EUR`,
  ];
}

/** 0 at night, 1 in the early afternoon (UTC). */
function busy(t: number): number {
  const phase = ((t % DAY) / DAY) * 2 * Math.PI;
  return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(phase - Math.PI / 2 - 0.9));
}

/** Events (log calls) of a stream in one minute (deterministic). */
export function eventsInMinute(s: Stream, minute: number): number {
  const noise = (hashString(`${s.key}:${minute}`) % 1000) / 1000;
  return Math.floor(s.rate * busy(minute * MIN) * (0.4 + noise * 1.2));
}

export interface GeneratedLine {
  ns: string;
  line: string;
}

/** Lines of a stream in one minute, oldest first (stack traces share their event's time). */
export function minuteLines(s: Stream, minute: number): GeneratedLine[] {
  const count = eventsInMinute(s, minute);
  if (count === 0) return [];
  const r = seeded(`${s.key}#${minute}`);
  const offsets = Array.from({ length: count }, () => Math.floor(r() * MIN)).sort((a, b) => a - b);
  const out: GeneratedLine[] = [];
  offsets.forEach((offset, i) => {
    const ms = minute * MIN + offset;
    const ts = new Date(ms);
    const lines =
      s.format === 'json'
        ? jsonLine(r, ts, s)
        : s.format === 'logfmt'
          ? logfmtLine(r, ts, s)
          : s.format === 'klog'
            ? klogLine(r, ts)
            : s.format === 'nginx'
              ? nginxLine(r, ts)
              : javaLine(r, ts);
    lines.forEach((line, j) => out.push({ ns: `${ms}${pad(i * 10 + j, 6)}`, line }));
  });
  return out;
}

// -- LogQL subset -----------------------------------------------------------------------

type Op = '=' | '!=' | '=~' | '!~';
interface Matcher {
  label: string;
  op: Op;
  value: string;
}

export interface LogQuery {
  matchers: Matcher[];
  test: (line: string) => boolean;
}

const unquote = (s: string) =>
  s.startsWith('`')
    ? s.slice(1, -1)
    : s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));

function matcherTest(m: Matcher): (value: string) => boolean {
  if (m.op === '=') return (v) => v === m.value;
  if (m.op === '!=') return (v) => v !== m.value;
  const re = new RegExp(`^(?:${m.value})$`);
  return m.op === '=~' ? (v) => re.test(v) : (v) => !re.test(v);
}

function syntaxError(col: number, message: string): Error {
  return new Error(`parse error at line 1, col ${col}: ${message}`);
}

/** `{a="b", c=~"d"} |= "x" | json | level="error"` → matchers + a line predicate. */
export function parseLogQuery(query: string): LogQuery {
  const q = query.trim();
  const m = /^\{([^}]*)\}/.exec(q);
  if (!m) throw syntaxError(1, 'syntax error: unexpected IDENTIFIER, expecting {');
  const matchers: Matcher[] = [];
  const re = /\s*([A-Za-z_]\w*)\s*(=~|!~|!=|=)\s*("(?:\\.|[^"\\])*"|`[^`]*`)\s*,?/gy;
  const body = m[1]!;
  let pos = 0;
  while (pos < body.length) {
    re.lastIndex = pos;
    const mm = re.exec(body);
    if (!mm) {
      if (!body.slice(pos).trim()) break;
      throw syntaxError(pos + 2, 'syntax error: unexpected character in the stream selector');
    }
    matchers.push({ label: mm[1]!, op: mm[2] as Op, value: unquote(mm[3]!) });
    pos = re.lastIndex;
  }
  if (!matchers.length) throw syntaxError(2, 'queries require at least one matcher');
  if (
    matchers.every(
      (x) => (x.op === '=~' || x.op === '!~') && new RegExp(`^(?:${x.value})$`).test(''),
    )
  )
    throw new Error(
      'queries require at least one regexp or equality matcher that does not have an empty-compatible value',
    );
  const tests: Array<(line: string) => boolean> = [];
  let parsed = false;
  let rest = q.slice(m[0].length);
  while (rest.trim()) {
    const lf = /^\s*(\|=|!=|\|~|!~)\s*("(?:\\.|[^"\\])*"|`[^`]*`)/.exec(rest);
    if (lf) {
      const value = unquote(lf[2]!);
      if (lf[1] === '|=') tests.push((l) => l.includes(value));
      else if (lf[1] === '!=') tests.push((l) => !l.includes(value));
      else {
        const rx = new RegExp(value);
        tests.push(lf[1] === '|~' ? (l) => rx.test(l) : (l) => !rx.test(l));
      }
      rest = rest.slice(lf[0].length);
      continue;
    }
    const parser = /^\s*\|\s*(json|logfmt|decolorize|unpack)\b/.exec(rest);
    if (parser) {
      parsed = true;
      rest = rest.slice(parser[0].length);
      continue;
    }
    const label =
      /^\s*\|\s*([A-Za-z_][\w.]*)\s*(=~|!~|!=|==|=)\s*("(?:\\.|[^"\\])*"|`[^`]*`|[\w.-]+)/.exec(
        rest,
      );
    if (label && parsed) {
      const key = label[1]!;
      const raw = label[3]!;
      const value = /^["`]/.test(raw) ? unquote(raw) : raw;
      const test = matcherTest({
        label: key,
        op: (label[2] === '==' ? '=' : label[2]) as Op,
        value,
      });
      tests.push((l) => {
        const p = parseLogLine(l);
        const field =
          key === 'level' ? (p.level ?? '') : key === 'msg' ? p.message : (p.fields[key] ?? '');
        return test(field);
      });
      rest = rest.slice(label[0].length);
      continue;
    }
    throw syntaxError(
      q.length - rest.length + 1,
      `syntax error: unexpected ${rest.trim().split(/\s/)[0]}`,
    );
  }
  return { matchers, test: (line) => tests.every((t) => t(line)) };
}

export function selectStreams(streams: Stream[], matchers: Matcher[]): Stream[] {
  const tests = matchers.map((m) => ({ label: m.label, test: matcherTest(m) }));
  return streams.filter((s) => tests.every((t) => t.test(s.labels[t.label] ?? '')));
}

/** `sum(count_over_time(<log query> [5m]))` → the log query and window seconds. */
export function parseVolumeQuery(query: string): { inner: string; windowSecs: number } | null {
  const m =
    /^\s*sum\s*\(\s*count_over_time\s*\(\s*([\s\S]+?)\s*\[(\d+)([smhd])\]\s*\)\s*\)\s*$/.exec(
      query,
    );
  if (!m) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[3] as 's' | 'm' | 'h' | 'd'];
  return { inner: m[1]!, windowSecs: Number(m[2]) * unit };
}
