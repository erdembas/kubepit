/** Container spec DSL for the demo fixtures. */

type Env =
  | [string, string]
  | [string, { secret: [string, string] } | { config: [string, string] } | { field: string }];

export interface ContainerDsl {
  name: string;
  image: string;
  ports?: Array<number | { name: string; port: number; protocol?: string }>;
  cpu?: [string, string?];
  mem?: [string, string?];
  env?: Env[];
  probe?: 'http' | 'tcp' | 'exec';
  probePath?: string;
  mounts?: Array<[string, string, boolean?]>;
  args?: string[];
  command?: string[];
}

export function container(d: ContainerDsl): Record<string, unknown> {
  const c: Record<string, unknown> = {
    name: d.name,
    image: d.image,
    imagePullPolicy: 'IfNotPresent',
  };
  if (d.command) c.command = d.command;
  if (d.args) c.args = d.args;
  if (d.ports?.length) {
    c.ports = d.ports.map((p) =>
      typeof p === 'number'
        ? { name: p === 9090 || p === 9100 ? 'metrics' : 'http', containerPort: p, protocol: 'TCP' }
        : { name: p.name, containerPort: p.port, protocol: p.protocol ?? 'TCP' },
    );
  }
  if (d.env?.length) {
    c.env = d.env.map(([name, v]) => {
      if (typeof v === 'string') return { name, value: v };
      if ('secret' in v)
        return { name, valueFrom: { secretKeyRef: { name: v.secret[0], key: v.secret[1] } } };
      if ('config' in v)
        return { name, valueFrom: { configMapKeyRef: { name: v.config[0], key: v.config[1] } } };
      return { name, valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: v.field } } };
    });
  }
  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  if (d.cpu?.[0]) requests.cpu = d.cpu[0];
  if (d.cpu?.[1]) limits.cpu = d.cpu[1];
  if (d.mem?.[0]) requests.memory = d.mem[0];
  if (d.mem?.[1]) limits.memory = d.mem[1];
  if (Object.keys(requests).length || Object.keys(limits).length)
    c.resources = {
      ...(Object.keys(requests).length ? { requests } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
    };
  const port = d.ports?.[0];
  const portNumber = typeof port === 'number' ? port : port?.port;
  if (d.probe && portNumber) {
    const handler =
      d.probe === 'http'
        ? { httpGet: { path: d.probePath ?? '/healthz', port: portNumber, scheme: 'HTTP' } }
        : d.probe === 'tcp'
          ? { tcpSocket: { port: portNumber } }
          : { exec: { command: ['sh', '-c', 'pg_isready -U postgres'] } };
    c.livenessProbe = {
      ...handler,
      initialDelaySeconds: 10,
      periodSeconds: 10,
      timeoutSeconds: 1,
      failureThreshold: 3,
    };
    c.readinessProbe = {
      ...handler,
      ...(d.probe === 'http'
        ? { httpGet: { path: '/ready', port: portNumber, scheme: 'HTTP' } }
        : {}),
      initialDelaySeconds: 5,
      periodSeconds: 5,
      timeoutSeconds: 1,
      failureThreshold: 3,
    };
  }
  if (d.mounts?.length)
    c.volumeMounts = d.mounts.map(([name, mountPath, readOnly]) => ({
      name,
      mountPath,
      ...(readOnly ? { readOnly } : {}),
    }));
  c.terminationMessagePath = '/dev/termination-log';
  c.terminationMessagePolicy = 'File';
  return c;
}
