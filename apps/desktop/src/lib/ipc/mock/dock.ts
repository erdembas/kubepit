import type { LogChunk, LogOptions } from '@/types';
import { mockEmit } from './bus';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo log streams for the dock in browser previews. Output looks like real
 * workloads — nginx access logs, Spring Boot with stack traces, Go zap JSON
 * and klog, pino-pretty style ANSI colour — picked from the pod/container
 * name, and honours tail / since / timestamps / previous / follow.
 */

type Event = string[];
type Generator = (ts: Date) => Event;

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(items: readonly T[]): T => items[rand(items.length)]!;
const chance = (p: number) => Math.random() < p;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const hex = (len: number) => Array.from({ length: len }, () => rand(16).toString(16)).join('');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clock = (d: Date) =>
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
const rfc3339Nano = (d: Date) => d.toISOString().replace('Z', `${pad(rand(1_000_000), 6)}Z`);

const nginx: Generator = (ts) => {
  const time = `${pad(ts.getUTCDate())}/${MONTHS[ts.getUTCMonth()]}/${ts.getUTCFullYear()}:${clock(ts).slice(0, 8)} +0000`;
  if (chance(0.04)) {
    const upstream = `10.96.${rand(255)}.${rand(255)}:8080`;
    return [
      `${ts.toISOString().slice(0, 10).replace(/-/g, '/')} ${clock(ts).slice(0, 8)} [error] 29#29: *${rand(90_000)} upstream timed out (110: Connection timed out) while reading response header from upstream, client: 10.244.1.${rand(255)}, server: _, request: "GET /api/v1/orders HTTP/1.1", upstream: "http://${upstream}/api/v1/orders"`,
    ];
  }
  if (chance(0.03)) {
    return [
      `${ts.toISOString().slice(0, 10).replace(/-/g, '/')} ${clock(ts).slice(0, 8)} [warn] 29#29: *${rand(90_000)} an upstream response is buffered to a temporary file /var/cache/nginx/proxy_temp/4/02/0000000024 while reading upstream`,
    ];
  }
  const status = pick([200, 200, 200, 200, 200, 200, 204, 301, 304, 304, 404, 499, 500, 502]);
  const path = pick([
    '/',
    '/api/v1/orders',
    '/api/v1/cart',
    '/healthz',
    '/static/app.8f3a1c.js',
    '/favicon.ico',
    '/api/v1/users/42',
    '/metrics',
    '/api/v1/search?q=shoes&page=2',
  ]);
  const method = path.startsWith('/api') && chance(0.3) ? pick(['POST', 'PUT', 'DELETE']) : 'GET';
  const ua = pick([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'kube-probe/1.32',
    'Prometheus/2.53.0',
    'curl/8.7.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  ]);
  return [
    `10.244.${rand(4)}.${rand(255)} - - [${time}] "${method} ${path} HTTP/1.1" ${status} ${rand(40_000)} "-" "${ua}" ${(Math.random() * 0.4).toFixed(3)}`,
  ];
};

const javaTrace = (): string[] => [
  `java.lang.IllegalStateException: Payment provider timeout after 3000ms (request_id=${hex(12)})`,
  '\tat com.acme.payments.provider.StripeClient.charge(StripeClient.java:118)',
  '\tat com.acme.payments.PaymentService.process(PaymentService.java:64)',
  '\tat com.acme.payments.PaymentController.create(PaymentController.java:41)',
  '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
  '\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)',
  '\t... 48 common frames omitted',
  'Caused by: java.net.SocketTimeoutException: Read timed out',
  '\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(NioSocketImpl.java:288)',
  '\tat java.base/java.net.Socket$SocketInputStream.read(Socket.java:1099)',
  '\t... 12 more',
];

const java: Generator = (ts) => {
  const stamp = `${ts.toISOString().slice(0, 10)} ${clock(ts)}`;
  const thread = pick([
    'nio-8080-exec-3',
    'nio-8080-exec-7',
    'scheduling-1',
    'kafka-consumer-2',
    'main',
  ]);
  const roll = Math.random();
  if (roll < 0.04) {
    return [
      `${stamp} ERROR 1 --- [${thread}] o.a.c.c.C.[.[.[/].[dispatcherServlet]    : Servlet.service() for servlet [dispatcherServlet] threw exception`,
      ...javaTrace(),
    ];
  }
  if (roll < 0.14) {
    return [
      `${stamp}  WARN 1 --- [${thread}] c.a.payments.retry.RetryTemplate          : Attempt ${1 + rand(3)}/3 failed for provider=stripe, backing off ${pick([200, 400, 800])}ms`,
    ];
  }
  if (roll < 0.22) {
    return [
      `${stamp} DEBUG 1 --- [${thread}] o.s.w.s.DispatcherServlet                : Completed 200 OK`,
    ];
  }
  return [
    pick([
      `${stamp}  INFO 1 --- [${thread}] c.a.payments.PaymentController           : Processed payment id=pay_${hex(8)} amount=${(Math.random() * 200).toFixed(2)} EUR in ${rand(90)}ms`,
      `${stamp}  INFO 1 --- [${thread}] c.a.payments.kafka.OrderEventsListener    : Consumed OrderPlaced order=${rand(99_999)} partition=${rand(6)} offset=${rand(900_000)}`,
      `${stamp}  INFO 1 --- [${thread}] com.zaxxer.hikari.pool.HikariPool        : HikariPool-1 - Pool stats (total=10, active=${rand(10)}, idle=${rand(10)}, waiting=0)`,
    ]),
  ];
};

const goJson: Generator = (ts) => {
  const level = pick(['info', 'info', 'info', 'info', 'debug', 'warn', 'error']);
  const base = {
    level,
    ts: ts.toISOString(),
    caller: pick(['controller/reconcile.go:142', 'server/http.go:88', 'cache/informer.go:311']),
  };
  if (level === 'error') {
    return [
      JSON.stringify({
        ...base,
        msg: 'Reconciler error',
        controller: 'deployment',
        namespace: 'checkout',
        name: 'cart',
        error:
          'Operation cannot be fulfilled on deployments.apps "cart": the object has been modified; please apply your changes to the latest version and try again',
        stacktrace:
          'sigs.k8s.io/controller-runtime/pkg/internal/controller.(*Controller).reconcileHandler\n\t/go/pkg/mod/sigs.k8s.io/controller-runtime@v0.19.0/pkg/internal/controller/controller.go:316',
      }),
    ];
  }
  if (level === 'warn')
    return [
      JSON.stringify({
        ...base,
        msg: 'Slow request',
        method: 'GET',
        path: '/api/v1/inventory',
        duration: `${rand(3000) + 1000}ms`,
      }),
    ];
  return [
    JSON.stringify({
      ...base,
      msg: pick(['Reconciled object', 'Request served', 'Cache synced']),
      namespace: pick(['checkout', 'payments', 'default']),
      duration: `${(Math.random() * 40).toFixed(1)}ms`,
      trace_id: hex(16),
    }),
  ];
};

const klog: Generator = (ts) => {
  const tag = `${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())} ${clock(ts)}${pad(rand(1000), 3)}`;
  const roll = Math.random();
  if (roll < 0.05)
    return [
      `E${tag}       1 leaderelection.go:340] error retrieving resource lock kube-system/cert-manager-controller: Get "https://10.96.0.1:443/apis/coordination.k8s.io/v1/namespaces/kube-system/leases/cert-manager-controller": context deadline exceeded`,
    ];
  if (roll < 0.12)
    return [
      `W${tag}       1 reflector.go:561] k8s.io/client-go/informers/factory.go:160: watch of *v1.Secret ended with: an error on the server ("unable to decode an event from the watch stream: http2: client connection lost") has prevented the request from succeeding`,
    ];
  return [
    `I${tag}       1 ${pick(['controller.go:197] "Starting workers" worker count=2', 'leaderelection.go:258] successfully acquired lease kube-system/cert-manager-controller', 'trigger_controller.go:223] "Certificate does not need re-issuance" key="checkout/cart-tls"'])}`,
  ];
};

const ansi: Generator = (ts) => {
  const time = `\x1b[90m[${clock(ts)}]\x1b[39m`;
  const roll = Math.random();
  if (roll < 0.05) {
    return [
      `${time} \x1b[31mERROR\x1b[39m (api/1): \x1b[36mUnhandled rejection\x1b[39m`,
      `    Error: connect ECONNREFUSED 10.96.0.15:6379`,
      `        at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)`,
      `        at RedisClient.connect (/app/node_modules/@redis/client/dist/lib/client/socket.js:213:15)`,
    ];
  }
  if (roll < 0.15)
    return [
      `${time} \x1b[33mWARN\x1b[39m (api/1): \x1b[36mcache miss storm\x1b[39m {"keys":${rand(900)},"window":"10s"}`,
    ];
  const status = pick([200, 200, 200, 201, 304, 404]);
  const color = status >= 400 ? 33 : 32;
  return [
    `${time} \x1b[32mINFO\x1b[39m (api/1): request completed \x1b[90m{"method":"GET","url":"/api/cart/${rand(999)}","status":\x1b[${color}m${status}\x1b[90m,"ms":${rand(120)}}\x1b[39m`,
  ];
};

const mix: Generator = (ts) => pick([nginx, java, goJson, klog, ansi, ansi])(ts);

function generatorFor(pod: string, container: string | null): Generator {
  const key = `${pod} ${container ?? ''}`.toLowerCase();
  if (/nginx|ingress|web|frontend|gateway|envoy|proxy/.test(key)) return nginx;
  if (/java|spring|payment|kafka|billing|jvm|order/.test(key)) return java;
  if (/controller|operator|cert-manager|argocd|coredns/.test(key))
    return (ts) => (chance(0.5) ? goJson(ts) : klog(ts));
  if (/kube-|etcd|scheduler/.test(key)) return klog;
  if (/node|api|cart|checkout|worker|redis/.test(key)) return ansi;
  return mix;
}

function crashLog(start: number): Array<{ ts: Date; lines: Event }> {
  const lines: Event[] = [
    ['{"level":"info","msg":"starting server","version":"2.14.1","commit":"9f3c2ab"}'],
    ['{"level":"info","msg":"loading configuration","path":"/etc/app/config.yaml"}'],
    ['{"level":"warn","msg":"config key \\"database.pool\\" is deprecated, use \\"db.pool\\""}'],
    ['{"level":"info","msg":"connecting to postgres","host":"postgres.checkout.svc","port":5432}'],
    ['{"level":"error","msg":"config value missing","key":"payments.provider.endpoint"}'],
    [
      'panic: runtime error: invalid memory address or nil pointer dereference',
      '[signal SIGSEGV: segmentation violation code=0x1 addr=0x18 pc=0x9a3f12]',
      '',
      'goroutine 1 [running]:',
      'main.(*Server).loadProvider(0x0, {0xc00012a000, 0x14})',
      '\t/app/cmd/server/main.go:88 +0x2a',
      'main.main()',
      '\t/app/cmd/server/main.go:41 +0x1c5',
    ],
  ];
  return lines.map((event, i) => ({ ts: new Date(start + i * 180), lines: event }));
}

interface Stream {
  timers: Set<ReturnType<typeof setTimeout>>;
  stopped: boolean;
}
const streams = new Map<string, Stream>();

function startStream(args: MockArgs): string {
  const id = crypto.randomUUID();
  const emit = args.onChunk as (chunk: LogChunk) => void;
  const opts = args.options as LogOptions;
  const pod = String(args.pod);
  const container = (args.container as string | null) ?? null;
  const stream: Stream = { timers: new Set(), stopped: false };
  streams.set(id, stream);
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      stream.timers.delete(timer);
      if (!stream.stopped) fn();
    }, ms);
    stream.timers.add(timer);
  };
  const render = (ts: Date, lines: Event) =>
    lines.map((line) => (opts.timestamps ? `${rfc3339Nano(ts)} ${line}` : line)).join('\n') + '\n';
  const send = (data: string, done = false, error: string | null = null) =>
    emit({ stream_id: id, data, done, error });

  if (/pending|imagepull|waiting/.test(pod)) {
    later(400, () =>
      send(
        '',
        true,
        `container "${container ?? 'app'}" in pod "${pod}" is waiting to start: ContainerCreating`,
      ),
    );
    return id;
  }

  const now = Date.now();
  let events: Array<{ ts: Date; lines: Event }>;
  if (opts.previous) {
    events = crashLog(now - 3_600_000);
  } else {
    const gen = generatorFor(pod, container);
    const count = Math.min(opts.tail_lines ?? 1_500, 5_000);
    events = [];
    let t = now;
    for (let i = 0; i < count; i++) {
      t -= 400 + rand(2_600);
      const ts = new Date(t);
      events.push({ ts, lines: gen(ts) });
    }
    events.reverse();
    if (opts.since_seconds)
      events = events.filter((e) => e.ts.getTime() >= now - opts.since_seconds! * 1000);
  }
  // Tail counts lines, not events.
  let text = events.map((e) => render(e.ts, e.lines)).join('');
  if (opts.tail_lines !== null) {
    const lines = text.split('\n');
    text = lines.slice(Math.max(0, lines.length - 1 - opts.tail_lines)).join('\n');
  }

  // Deliver the backlog in uneven slices so lines straddle chunk boundaries.
  let offset = 0;
  let delay = 120;
  while (offset < text.length) {
    const size = 2_000 + rand(6_000);
    const slice = text.slice(offset, offset + size);
    offset += size;
    later(delay, () => send(slice));
    delay += 15;
  }
  const follow = opts.follow && !opts.previous;
  if (!follow) {
    later(delay + 20, () => send('', true));
    return id;
  }
  const gen = generatorFor(pod, container);
  const tick = () => {
    const ts = new Date();
    send(render(ts, gen(ts)));
    later(300 + rand(1_200), tick);
  };
  later(delay + 300, tick);
  return id;
}

register({
  pod_logs_stream: (args: MockArgs) => startStream(args),
  pod_logs_stop: ({ streamId }: MockArgs) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    stream.stopped = true;
    stream.timers.forEach(clearTimeout);
    streams.delete(streamId);
  },
});

// Let `exit` / `exit <code>` in the demo shell end the session so the dock's
// exit banner can be exercised without a PTY (wraps the echo shell in app.ts).
const echoWrite = handlers.terminal_write;
const echoDestroy = handlers.terminal_destroy;
const lines = new Map<string, string>();
if (echoWrite && echoDestroy) {
  register({
    terminal_destroy: (args: MockArgs) => {
      lines.delete(String(args.id));
      return echoDestroy(args);
    },
    terminal_write: (args: MockArgs) => {
      const id = String(args.id);
      const text = new TextDecoder().decode(new Uint8Array(args.data as number[]));
      let line = lines.get(id) ?? '';
      for (const ch of text) {
        if (ch === '\r') {
          const match = /^\s*exit(?:\s+(\d+))?\s*$/.exec(line);
          if (match)
            setTimeout(() => mockEmit('terminal://exit', { id, code: Number(match[1] ?? 0) }), 50);
          line = '';
        } else if (ch === '\x7f') line = line.slice(0, -1);
        else line += ch;
      }
      lines.set(id, line);
      return echoWrite(args);
    },
  });
}
