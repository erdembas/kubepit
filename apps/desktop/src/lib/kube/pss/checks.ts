import { asArray, asObject, asString, isObject, type JsonObject } from '../accessors';
import type { PssCheckId, PssLevel } from './types';

/**
 * The official Pod Security Standards checks, versioned like
 * `k8s.io/pod-security-admission/policy`: each check applies from the
 * minor version that introduced it, and some change behaviour in later
 * versions (fields next to annotations, new allowed values, Windows pods
 * exempt from Linux-only restricted checks from v1.25).
 */

export interface CheckContext {
  annotations: Readonly<Record<string, string>>;
  spec: JsonObject;
  podSc: JsonObject;
  /** containers, initContainers and ephemeralContainers. */
  containers: JsonObject[];
  /** Minor version the policy is evaluated at (`Infinity` = latest). */
  minor: number;
  /** `spec.os.name: windows`. */
  windows: boolean;
}

export interface CheckOutcome {
  reason: string;
  detail: string;
}

export interface CheckDef {
  id: PssCheckId;
  level: Exclude<PssLevel, 'privileged'>;
  /** First minor version (v1.x) the check applies to. */
  since: number;
  /** Checks this one replaces when both apply (restricted refines baseline). */
  overrides?: readonly PssCheckId[];
  run: (ctx: CheckContext) => CheckOutcome | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quote = (s: string) => `"${s}"`;
const quoted = (list: readonly string[]) => list.map(quote).join(', ');

const sc = (c: JsonObject) => asObject(c.securityContext);
const cname = (c: JsonObject) => asString(c.name);

/** `container "a"` / `containers "a", "b"`. */
export function containerList(names: readonly string[]): string {
  return names.length === 1 ? `container ${quote(names[0]!)}` : `containers ${quoted(names)}`;
}

/** `pod`, `container "a"`, `pod and containers "a", "b"`. */
function whoList(pod: boolean, names: readonly string[]): string {
  if (!names.length) return 'pod';
  return pod ? `pod and ${containerList(names)}` : containerList(names);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const hostNamespaces: CheckDef = {
  id: 'hostNamespaces',
  level: 'baseline',
  since: 0,
  run: ({ spec }) => {
    const set = (['hostNetwork', 'hostPID', 'hostIPC'] as const).filter((k) => spec[k] === true);
    return set.length
      ? { reason: 'host namespaces', detail: set.map((k) => `${k}=true`).join(', ') }
      : null;
  },
};

const privileged: CheckDef = {
  id: 'privileged',
  level: 'baseline',
  since: 0,
  run: ({ containers }) => {
    const bad = containers.filter((c) => sc(c).privileged === true).map(cname);
    return bad.length
      ? {
          reason: 'privileged',
          detail: `${containerList(bad)} must not set securityContext.privileged=true`,
        }
      : null;
  },
};

const BASELINE_CAPABILITIES = new Set([
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'MKNOD',
  'NET_BIND_SERVICE',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
]);

const capabilitiesBaseline: CheckDef = {
  id: 'capabilities_baseline',
  level: 'baseline',
  since: 0,
  run: ({ containers }) => {
    const bad: string[] = [];
    const caps: string[] = [];
    for (const c of containers) {
      const added = asArray(asObject(sc(c).capabilities).add)
        .map((x) => asString(x))
        .filter((cap) => cap && !BASELINE_CAPABILITIES.has(cap));
      if (added.length) {
        bad.push(cname(c));
        caps.push(...added);
      }
    }
    return bad.length
      ? {
          reason: 'non-default capabilities',
          detail: `${containerList(bad)} must not include ${quoted(unique(caps))} in securityContext.capabilities.add`,
        }
      : null;
  },
};

const hostPathVolumes: CheckDef = {
  id: 'hostPathVolumes',
  level: 'baseline',
  since: 0,
  run: ({ spec }) => {
    const bad = asArray(spec.volumes)
      .filter(isObject)
      .filter((v) => isObject(v.hostPath))
      .map((v) => asString(v.name));
    return bad.length
      ? {
          reason: 'hostPath volumes',
          detail: `${bad.length === 1 ? 'volume' : 'volumes'} ${quoted(bad)}`,
        }
      : null;
  },
};

const hostPorts: CheckDef = {
  id: 'hostPorts',
  level: 'baseline',
  since: 0,
  run: ({ containers }) => {
    const bad: string[] = [];
    const ports: string[] = [];
    for (const c of containers) {
      const used = asArray(c.ports)
        .filter(isObject)
        .map((p) => Number(p.hostPort ?? 0))
        .filter((p) => p !== 0);
      if (used.length) {
        bad.push(cname(c));
        ports.push(...used.map(String));
      }
    }
    if (!bad.length) return null;
    const list = unique(ports);
    return {
      reason: 'hostPort',
      detail: `${containerList(bad)} ${bad.length === 1 ? 'uses' : 'use'} ${list.length === 1 ? 'hostPort' : 'hostPorts'} ${list.join(', ')}`,
    };
  },
};

const APPARMOR_PREFIX = 'container.apparmor.security.beta.kubernetes.io/';

const appArmorProfile: CheckDef = {
  id: 'appArmorProfile',
  level: 'baseline',
  since: 0,
  run: ({ annotations, podSc, containers, minor }) => {
    const bad: string[] = [];
    for (const [key, value] of Object.entries(annotations)) {
      if (!key.startsWith(APPARMOR_PREFIX)) continue;
      if (value && value !== 'runtime/default' && !value.startsWith('localhost/'))
        bad.push(`${key}=${quote(value)}`);
    }
    if (minor >= 30) {
      const unconfined = (o: JsonObject) =>
        asString(asObject(o.appArmorProfile).type) === 'Unconfined';
      const pod = unconfined(podSc);
      const names = containers.filter((c) => unconfined(sc(c))).map(cname);
      if (pod || names.length)
        bad.push(
          `${whoList(pod, names)} must not set securityContext.appArmorProfile.type to "Unconfined"`,
        );
    }
    return bad.length
      ? {
          reason: bad.length === 1 ? 'forbidden AppArmor profile' : 'forbidden AppArmor profiles',
          detail: bad.join(', '),
        }
      : null;
  },
};

const seLinuxOptions: CheckDef = {
  id: 'seLinuxOptions',
  level: 'baseline',
  since: 0,
  run: ({ podSc, containers, minor }) => {
    const types = new Set(['', 'container_t', 'container_init_t', 'container_kvm_t']);
    if (minor >= 31) types.add('container_engine_t');
    const fields: string[] = [];
    const inspect = (o: JsonObject) => {
      const opts = asObject(o.seLinuxOptions);
      const bad: string[] = [];
      const type = asString(opts.type);
      if (!types.has(type)) bad.push(`type ${quote(type)}`);
      if (asString(opts.user)) bad.push(`user ${quote(asString(opts.user))}`);
      if (asString(opts.role)) bad.push(`role ${quote(asString(opts.role))}`);
      fields.push(...bad);
      return bad.length > 0;
    };
    const pod = inspect(podSc);
    const names = containers.filter((c) => inspect(sc(c))).map(cname);
    if (!pod && !names.length) return null;
    return {
      reason: 'seLinuxOptions',
      detail: `${whoList(pod, names)} set forbidden securityContext.seLinuxOptions: ${unique(fields).join('; ')}`,
    };
  },
};

const procMount: CheckDef = {
  id: 'procMount',
  level: 'baseline',
  since: 0,
  run: ({ containers }) => {
    const bad: string[] = [];
    const values: string[] = [];
    for (const c of containers) {
      const value = asString(sc(c).procMount);
      if (value && value !== 'Default') {
        bad.push(cname(c));
        values.push(value);
      }
    }
    return bad.length
      ? {
          reason: 'procMount',
          detail: `${containerList(bad)} must not set securityContext.procMount to ${quoted(unique(values))}`,
        }
      : null;
  },
};

const SECCOMP_POD_ANNOTATION = 'seccomp.security.alpha.kubernetes.io/pod';
const SECCOMP_CONTAINER_PREFIX = 'container.seccomp.security.alpha.kubernetes.io/';

const seccompBaseline: CheckDef = {
  id: 'seccompProfile_baseline',
  level: 'baseline',
  since: 0,
  run: ({ annotations, podSc, containers, minor }) => {
    if (minor < 19) {
      const bad = Object.entries(annotations)
        .filter(
          ([key, value]) =>
            (key === SECCOMP_POD_ANNOTATION || key.startsWith(SECCOMP_CONTAINER_PREFIX)) &&
            value === 'unconfined',
        )
        .map(([key, value]) => `${key}=${quote(value)}`);
      return bad.length ? { reason: 'seccompProfile', detail: bad.join(', ') } : null;
    }
    const unconfined = (o: JsonObject) =>
      asString(asObject(o.seccompProfile).type) === 'Unconfined';
    const pod = unconfined(podSc);
    const names = containers.filter((c) => unconfined(sc(c))).map(cname);
    return pod || names.length
      ? {
          reason: 'seccompProfile',
          detail: `${whoList(pod, names)} must not set securityContext.seccompProfile.type to "Unconfined"`,
        }
      : null;
  },
};

/** Safe sysctls and the version that allowed each. */
const SAFE_SYSCTLS: ReadonlyArray<[string, number]> = [
  ['kernel.shm_rmid_forced', 0],
  ['net.ipv4.ip_local_port_range', 0],
  ['net.ipv4.tcp_syncookies', 0],
  ['net.ipv4.ping_group_range', 0],
  ['net.ipv4.ip_unprivileged_port_start', 22],
  ['net.ipv4.ip_local_reserved_ports', 27],
  ['net.ipv4.tcp_keepalive_time', 29],
  ['net.ipv4.tcp_fin_timeout', 29],
  ['net.ipv4.tcp_keepalive_intvl', 29],
  ['net.ipv4.tcp_keepalive_probes', 29],
  ['net.ipv4.tcp_rmem', 32],
  ['net.ipv4.tcp_wmem', 32],
];

const sysctls: CheckDef = {
  id: 'sysctls',
  level: 'baseline',
  since: 0,
  run: ({ podSc, minor }) => {
    const allowed = new Set(SAFE_SYSCTLS.filter(([, since]) => minor >= since).map(([n]) => n));
    const bad = asArray(podSc.sysctls)
      .filter(isObject)
      .map((s) => asString(s.name))
      .filter((n) => n && !allowed.has(n));
    return bad.length ? { reason: 'forbidden sysctls', detail: unique(bad).join(', ') } : null;
  },
};

const windowsHostProcess: CheckDef = {
  id: 'windowsHostProcess',
  level: 'baseline',
  since: 0,
  run: ({ podSc, containers }) => {
    const hostProcess = (o: JsonObject) => asObject(o.windowsOptions).hostProcess === true;
    const pod = hostProcess(podSc);
    const names = containers.filter((c) => hostProcess(sc(c))).map(cname);
    return pod || names.length
      ? {
          reason: 'hostProcess',
          detail: `${whoList(pod, names)} must not set securityContext.windowsOptions.hostProcess=true`,
        }
      : null;
  },
};

// ---------------------------------------------------------------------------
// Restricted
// ---------------------------------------------------------------------------

const RESTRICTED_VOLUME_TYPES = new Set([
  'configMap',
  'csi',
  'downwardAPI',
  'emptyDir',
  'ephemeral',
  'persistentVolumeClaim',
  'projected',
  'secret',
]);

const restrictedVolumes: CheckDef = {
  id: 'restrictedVolumes',
  level: 'restricted',
  since: 0,
  run: ({ spec }) => {
    const bad: string[] = [];
    const types: string[] = [];
    for (const v of asArray(spec.volumes).filter(isObject)) {
      const type = Object.keys(v).find((k) => k !== 'name' && isObject(v[k]));
      if (type && !RESTRICTED_VOLUME_TYPES.has(type)) {
        bad.push(asString(v.name));
        types.push(type);
      }
    }
    if (!bad.length) return null;
    const list = unique(types);
    return {
      reason: 'restricted volume types',
      detail:
        bad.length === 1
          ? `volume ${quote(bad[0]!)} uses restricted volume type ${quote(list[0]!)}`
          : `volumes ${quoted(bad)} use restricted volume ${list.length === 1 ? 'type' : 'types'} ${quoted(list)}`,
    };
  },
};

const allowPrivilegeEscalation: CheckDef = {
  id: 'allowPrivilegeEscalation',
  level: 'restricted',
  since: 8,
  run: ({ containers, minor, windows }) => {
    if (windows && minor >= 25) return null;
    const bad = containers.filter((c) => sc(c).allowPrivilegeEscalation !== false).map(cname);
    return bad.length
      ? {
          reason: 'allowPrivilegeEscalation != false',
          detail: `${containerList(bad)} must set securityContext.allowPrivilegeEscalation=false`,
        }
      : null;
  },
};

const runAsNonRoot: CheckDef = {
  id: 'runAsNonRoot',
  level: 'restricted',
  since: 0,
  run: ({ podSc, containers }) => {
    const pod = podSc.runAsNonRoot;
    const parts: string[] = [];
    if (pod === false) parts.push('pod must not set securityContext.runAsNonRoot=false');
    const explicit = containers.filter((c) => sc(c).runAsNonRoot === false).map(cname);
    if (explicit.length)
      parts.push(`${containerList(explicit)} must not set securityContext.runAsNonRoot=false`);
    if (pod !== true) {
      const implicit = containers
        .filter((c) => sc(c).runAsNonRoot === undefined || sc(c).runAsNonRoot === null)
        .map(cname);
      if (implicit.length)
        parts.push(`pod or ${containerList(implicit)} must set securityContext.runAsNonRoot=true`);
    }
    return parts.length ? { reason: 'runAsNonRoot != true', detail: parts.join('; ') } : null;
  },
};

const runAsUser: CheckDef = {
  id: 'runAsUser',
  level: 'restricted',
  since: 23,
  run: ({ podSc, containers }) => {
    const pod = podSc.runAsUser === 0;
    const names = containers.filter((c) => sc(c).runAsUser === 0).map(cname);
    return pod || names.length
      ? { reason: 'runAsUser=0', detail: `${whoList(pod, names)} must not set runAsUser=0` }
      : null;
  },
};

const seccompRestricted: CheckDef = {
  id: 'seccompProfile_restricted',
  level: 'restricted',
  since: 19,
  overrides: ['seccompProfile_baseline'],
  run: ({ podSc, containers, minor, windows }) => {
    if (windows && minor >= 25) return null;
    const valid = (t: string) => t === 'RuntimeDefault' || t === 'Localhost';
    const typeOf = (o: JsonObject) => asString(asObject(o.seccompProfile).type);
    const podType = typeOf(podSc);
    const parts: string[] = [];
    if (podType && !valid(podType))
      parts.push(`pod must not set securityContext.seccompProfile.type to ${quote(podType)}`);
    const explicit = containers.filter((c) => typeOf(sc(c)) && !valid(typeOf(sc(c))));
    if (explicit.length)
      parts.push(
        `${containerList(explicit.map(cname))} must not set securityContext.seccompProfile.type to ${quoted(unique(explicit.map((c) => typeOf(sc(c)))))}`,
      );
    if (!valid(podType)) {
      const implicit = containers.filter((c) => !typeOf(sc(c))).map(cname);
      if (implicit.length)
        parts.push(
          `pod or ${containerList(implicit)} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost"`,
        );
    }
    return parts.length ? { reason: 'seccompProfile', detail: parts.join('; ') } : null;
  },
};

const capabilitiesRestricted: CheckDef = {
  id: 'capabilities_restricted',
  level: 'restricted',
  since: 22,
  overrides: ['capabilities_baseline'],
  run: ({ containers, minor, windows }) => {
    if (windows && minor >= 25) return null;
    const noDrop: string[] = [];
    const extra: string[] = [];
    const caps: string[] = [];
    for (const c of containers) {
      const capabilities = asObject(sc(c).capabilities);
      const drop = asArray(capabilities.drop).map((x) => asString(x));
      if (!drop.includes('ALL')) noDrop.push(cname(c));
      const added = asArray(capabilities.add)
        .map((x) => asString(x))
        .filter((cap) => cap && cap !== 'NET_BIND_SERVICE');
      if (added.length) {
        extra.push(cname(c));
        caps.push(...added);
      }
    }
    const parts: string[] = [];
    if (noDrop.length)
      parts.push(`${containerList(noDrop)} must set securityContext.capabilities.drop=["ALL"]`);
    if (extra.length)
      parts.push(
        `${containerList(extra)} must not include ${quoted(unique(caps))} in securityContext.capabilities.add`,
      );
    return parts.length ? { reason: 'unrestricted capabilities', detail: parts.join('; ') } : null;
  },
};

/** Every check, baseline first, in the order the API server reports them. */
export const CHECKS: readonly CheckDef[] = [
  hostNamespaces,
  privileged,
  capabilitiesBaseline,
  hostPathVolumes,
  hostPorts,
  appArmorProfile,
  seLinuxOptions,
  procMount,
  seccompBaseline,
  sysctls,
  windowsHostProcess,
  restrictedVolumes,
  allowPrivilegeEscalation,
  runAsNonRoot,
  runAsUser,
  seccompRestricted,
  capabilitiesRestricted,
];

export const CHECK_IDS: readonly PssCheckId[] = CHECKS.map((c) => c.id);

export function checkDef(id: PssCheckId): CheckDef {
  return CHECKS.find((c) => c.id === id)!;
}
