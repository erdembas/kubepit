import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, isObject, spec, status } from '../accessors';
import type { ObjectRef } from '../columns/types';
import { implementationName } from './implementations';
import { GATEWAY_GROUP, isRouteKind } from './kinds';
import {
  classController,
  conditionsOf,
  findCondition,
  gatewayClassName,
  gatewayListeners,
  parentLabel,
  policyAncestors,
  policyTargets,
  routeHostnames,
  routeRules,
  type GwCondition,
  type Listener,
} from './model';
import {
  gatewaysOfClass,
  gatewayOf,
  referencePermitted,
  resolveBackends,
  resolveParents,
  routesOf,
  servicePorts,
  type GatewayIndex,
  type ResolvedParent,
} from './refs';

/**
 * "Why isn't this route attached / accepted?" — findings per object from
 * the controller's status conditions (with reason-specific hints) and from
 * the spec checks of `refs.ts`, which also explain objects no controller
 * has reported on yet. Sentences are translated; names, reasons and
 * messages are Kubernetes data and stay verbatim.
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface GatewayIssue {
  severity: IssueSeverity;
  /** Stable id for tests and grouping (`route.parent-missing`, …). */
  code: string;
  /** The object the finding is about. */
  subject: ObjectRef;
  title: string;
  /** The controller's message or a short explanation. */
  detail?: string;
  /** What to change. */
  hint?: string;
  /** The other object involved (a Gateway, Service, Secret…). */
  target?: ObjectRef;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

export function sortIssues(issues: GatewayIssue[]): GatewayIssue[] {
  return issues.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.subject.namespace ?? '').localeCompare(b.subject.namespace ?? '') ||
      a.subject.name.localeCompare(b.subject.name) ||
      a.code.localeCompare(b.code),
  );
}

function refOf(obj: KubeObject): ObjectRef {
  return {
    apiVersion: obj.apiVersion,
    kind: obj.kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? null,
  };
}

const gatewayRef = (namespace: string, name: string): ObjectRef => ({
  apiVersion: `${GATEWAY_GROUP}/v1`,
  kind: 'Gateway',
  namespace,
  name,
});

const detailOf = (c: GwCondition) => c.message || undefined;

// ---------------------------------------------------------------------------
// Reason hints (the API's documented reasons)
// ---------------------------------------------------------------------------

function routeAcceptedHint(reason: string): string | undefined {
  switch (reason) {
    case 'NotAllowedByListeners':
      return i18n.t(
        "No listener allows this route: check the listeners' allowedRoutes (namespaces and kinds).",
      );
    case 'NoMatchingListenerHostname':
      return i18n.t(
        "None of the route's hostnames matches a listener hostname. Align spec.hostnames with the listener.",
      );
    case 'NoMatchingParent':
      return i18n.t('The sectionName or port in parentRefs does not match any listener.');
    case 'UnsupportedValue':
      return i18n.t('The route uses a value this implementation does not support.');
    case 'Pending':
      return i18n.t('The controller has not finished reconciling the route yet.');
    default:
      return undefined;
  }
}

function resolvedRefsHint(reason: string): string | undefined {
  switch (reason) {
    case 'RefNotPermitted':
      return i18n.t(
        'A cross-namespace reference needs a ReferenceGrant in the namespace of the referenced object.',
      );
    case 'BackendNotFound':
      return i18n.t('A backendRef names a Service (or backend) that does not exist.');
    case 'InvalidKind':
      return i18n.t('A reference names a kind this implementation does not support.');
    case 'UnsupportedProtocol':
      return i18n.t("The backend's appProtocol is not supported by this route kind.");
    case 'InvalidCertificateRef':
      return i18n.t(
        'The TLS certificate Secret is missing, unreadable or not a valid kubernetes.io/tls Secret.',
      );
    case 'InvalidRouteKinds':
      return i18n.t('allowedRoutes.kinds names a route kind the implementation does not support.');
    default:
      return undefined;
  }
}

function gatewayProgrammedHint(reason: string): string | undefined {
  switch (reason) {
    case 'AddressNotAssigned':
    case 'AddressNotUsable':
      return i18n.t(
        'No address could be assigned. Check the load balancer Service of the gateway and spec.addresses.',
      );
    case 'NoResources':
      return i18n.t('The data plane could not be provisioned (no resources or quota).');
    case 'Invalid':
      return i18n.t('The Gateway spec is invalid for this implementation.');
    case 'Pending':
      return i18n.t('The controller is still provisioning the data plane.');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function parentIssues(index: GatewayIndex, route: KubeObject, p: ResolvedParent): GatewayIssue[] {
  const subject = refOf(route);
  const label = parentLabel(p.ref);
  const target = gatewayRef(p.ref.namespace, p.ref.name);
  const out: GatewayIssue[] = [];
  const push = (issue: Omit<GatewayIssue, 'subject'>) => out.push({ subject, ...issue });

  switch (p.problem) {
    case 'gateway-missing':
      push({
        severity: 'error',
        code: 'route.parent-missing',
        title: i18n.t('Parent Gateway {gateway} does not exist', { gateway: label }),
        hint: i18n.t('Fix the name or namespace in spec.parentRefs, or create the Gateway.'),
        target,
      });
      break;
    case 'no-section':
      push({
        severity: 'error',
        code: 'route.no-section',
        title: i18n.t('Gateway {gateway} has no listener named {section}', {
          gateway: `${p.ref.namespace}/${p.ref.name}`,
          section: p.ref.sectionName ?? '',
        }),
        hint: p.gateway
          ? i18n.t('Listeners: {names}', {
              names: gatewayListeners(p.gateway)
                .map((l) => l.name)
                .join(', '),
            })
          : undefined,
        target,
      });
      break;
    case 'no-port':
      push({
        severity: 'error',
        code: 'route.no-port',
        title: i18n.t('Gateway {gateway} has no listener on port {port}', {
          gateway: `${p.ref.namespace}/${p.ref.name}`,
          port: p.ref.port ?? 0,
        }),
        target,
      });
      break;
    case 'no-listener':
      push({
        severity: 'error',
        code: 'route.no-listener',
        title: i18n.t('Gateway {gateway} has no listeners', {
          gateway: `${p.ref.namespace}/${p.ref.name}`,
        }),
        target,
      });
      break;
    case 'no-matching-listener':
      for (const m of p.listeners) {
        for (const why of m.mismatches) {
          if (why === 'namespace')
            push({
              severity: 'error',
              code: 'route.namespace-not-allowed',
              title: i18n.t(
                'Listener {listener} of {gateway} does not allow routes from {namespace}',
                {
                  listener: m.listener.name,
                  gateway: `${p.ref.namespace}/${p.ref.name}`,
                  namespace: route.metadata.namespace ?? '',
                },
              ),
              detail: i18n.t('allowedRoutes.namespaces.from: {from}', {
                from: m.listener.allowedFrom,
              }),
              hint:
                m.listener.allowedFrom === 'Selector'
                  ? i18n.t("Label the route's namespace so the listener's selector matches it.")
                  : i18n.t(
                      'Set allowedRoutes.namespaces.from to All or Selector on the listener, or move the route.',
                    ),
              target,
            });
          else if (why === 'kind')
            push({
              severity: 'error',
              code: 'route.kind-not-allowed',
              title: i18n.t('Listener {listener} ({protocol}) does not accept {kind}', {
                listener: m.listener.name,
                protocol: m.listener.protocol,
                kind: route.kind,
              }),
              target,
            });
          else
            push({
              severity: 'error',
              code: 'route.hostname-mismatch',
              title: i18n.t("No route hostname matches listener {listener}'s hostname {hostname}", {
                listener: m.listener.name,
                hostname: m.listener.hostname ?? '*',
              }),
              detail: routeHostnames(route).join(', '),
              target,
            });
        }
      }
      break;
    default:
      break;
  }

  const accepted = p.status ? findCondition(p.status.conditions, 'Accepted') : undefined;
  const resolved = p.status ? findCondition(p.status.conditions, 'ResolvedRefs') : undefined;
  if (accepted?.status === 'False' && !out.length)
    push({
      severity: 'error',
      code: 'route.not-accepted',
      title: i18n.t('Not accepted by {gateway}: {reason}', {
        gateway: label,
        reason: accepted.reason || 'False',
      }),
      detail: detailOf(accepted),
      hint: routeAcceptedHint(accepted.reason),
      target,
    });
  if (resolved?.status === 'False')
    push({
      severity: 'error',
      code: 'route.refs-unresolved',
      title: i18n.t('References not resolved on {gateway}: {reason}', {
        gateway: label,
        reason: resolved.reason || 'False',
      }),
      detail: detailOf(resolved),
      hint: resolvedRefsHint(resolved.reason),
      target,
    });
  if (!p.status && !out.length && p.gateway) {
    const className = gatewayClassName(p.gateway);
    const cls = index.classes.get(className);
    push({
      severity: 'warning',
      code: 'route.no-status',
      title: i18n.t('No controller has reported on this route for {gateway}', { gateway: label }),
      hint: cls
        ? i18n.t(
            'Check that GatewayClass {class} is accepted and its controller ({controller}) is running.',
            { class: className, controller: implementationName(classController(cls)) },
          )
        : index.known.classes
          ? i18n.t('GatewayClass {class} of the Gateway does not exist.', { class: className })
          : i18n.t('Check that the controller of GatewayClass {class} is running.', {
              class: className,
            }),
      target,
    });
  }
  if (
    accepted?.status === 'True' &&
    accepted.observedGeneration !== null &&
    route.metadata.generation !== undefined &&
    accepted.observedGeneration < route.metadata.generation
  )
    push({
      severity: 'info',
      code: 'route.status-stale',
      title: i18n.t('The status for {gateway} describes an older generation of the route', {
        gateway: label,
      }),
      target,
    });
  return out;
}

export function diagnoseRoute(index: GatewayIndex, route: KubeObject): GatewayIssue[] {
  const subject = refOf(route);
  const out: GatewayIssue[] = [];
  const parents = resolveParents(index, route);
  if (!parents.length)
    out.push({
      severity: 'warning',
      code: 'route.no-parents',
      subject,
      title: i18n.t('The route has no parentRefs, so no Gateway serves it'),
      hint: i18n.t('Add a parentRef to the Gateway (and listener) that should serve it.'),
    });
  for (const p of parents) out.push(...parentIssues(index, route, p));

  for (const b of resolveBackends(index, route)) {
    const target: ObjectRef = {
      // The version is a placeholder: links resolve the served one by group and kind.
      apiVersion: b.ref.group ? `${b.ref.group}/v1` : 'v1',
      kind: b.ref.kind,
      name: b.ref.name,
      namespace: b.ref.namespace,
    };
    const name = `${b.ref.namespace}/${b.ref.name}`;
    for (const problem of b.problems) {
      if (problem === 'not-permitted')
        out.push({
          severity: 'error',
          code: 'route.backend-not-permitted',
          subject,
          title: i18n.t('Cross-namespace backendRef to {backend} is not permitted', {
            backend: name,
          }),
          hint: i18n.t(
            'Create a ReferenceGrant in {namespace} from {kind} in {from} to {target} {name}.',
            {
              namespace: b.ref.namespace,
              kind: route.kind,
              from: route.metadata.namespace ?? '',
              target: b.ref.kind,
              name: b.ref.name,
            },
          ),
          target,
        });
      else if (problem === 'service-missing')
        out.push({
          severity: 'error',
          code: 'route.backend-missing',
          subject,
          title: i18n.t('Backend Service {backend} does not exist', { backend: name }),
          target,
        });
      else if (problem === 'port-missing')
        out.push({
          severity: 'error',
          code: 'route.backend-port-missing',
          subject,
          title: i18n.t('The backendRef to Service {backend} has no port', { backend: name }),
          hint: i18n.t('A Service backendRef must set port.'),
          target,
        });
      else if (problem === 'port-unknown' && b.service)
        out.push({
          severity: 'error',
          code: 'route.backend-port-unknown',
          subject,
          title: i18n.t('Service {backend} does not expose port {port}', {
            backend: name,
            port: b.ref.port ?? 0,
          }),
          hint: i18n.t('Service ports: {ports}', {
            ports: servicePorts(b.service).join(', ') || '—',
          }),
          target,
        });
    }
  }

  if (route.kind === 'HTTPRoute' || route.kind === 'GRPCRoute')
    for (const rule of routeRules(route)) {
      const live = rule.backends.filter((b) => !b.mirror);
      if (!live.length && !rule.terminal)
        out.push({
          severity: 'warning',
          code: 'route.rule-no-backends',
          subject,
          title: i18n.t('Rule {rule} has no backendRefs', { rule: rule.name || rule.index + 1 }),
          detail: i18n.t('Matching requests get an error response from the gateway.'),
        });
      else if (live.length && live.every((b) => b.weight === 0))
        out.push({
          severity: 'warning',
          code: 'route.rule-zero-weight',
          subject,
          title: i18n.t('Every backend of rule {rule} has weight 0', {
            rule: rule.name || rule.index + 1,
          }),
        });
    }
  return out;
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

function listenerIssues(gw: KubeObject, l: Listener): GatewayIssue[] {
  const subject = refOf(gw);
  const out: GatewayIssue[] = [];
  const conds = l.status?.conditions ?? [];
  const accepted = findCondition(conds, 'Accepted');
  const programmed = findCondition(conds, 'Programmed');
  const resolved = findCondition(conds, 'ResolvedRefs');
  const conflicted = findCondition(conds, 'Conflicted');
  if (conflicted?.status === 'True')
    out.push({
      severity: 'error',
      code: 'gateway.listener-conflicted',
      subject,
      title: i18n.t('Listener {listener} conflicts with another listener: {reason}', {
        listener: l.name,
        reason: conflicted.reason,
      }),
      detail: detailOf(conflicted),
      hint: i18n.t('Listeners on one port need distinct hostnames and compatible protocols.'),
    });
  if (accepted?.status === 'False')
    out.push({
      severity: 'error',
      code: 'gateway.listener-not-accepted',
      subject,
      title: i18n.t('Listener {listener} is not accepted: {reason}', {
        listener: l.name,
        reason: accepted.reason,
      }),
      detail: detailOf(accepted),
    });
  if (resolved?.status === 'False')
    out.push({
      severity: 'error',
      code: 'gateway.listener-refs-unresolved',
      subject,
      title: i18n.t('Listener {listener} has unresolved references: {reason}', {
        listener: l.name,
        reason: resolved.reason,
      }),
      detail: detailOf(resolved),
      hint: resolvedRefsHint(resolved.reason),
    });
  if (programmed?.status === 'False' && accepted?.status !== 'False')
    out.push({
      severity: 'error',
      code: 'gateway.listener-not-programmed',
      subject,
      title: i18n.t('Listener {listener} is not programmed: {reason}', {
        listener: l.name,
        reason: programmed.reason,
      }),
      detail: detailOf(programmed),
    });
  return out;
}

export function diagnoseGateway(index: GatewayIndex, gw: KubeObject): GatewayIssue[] {
  const subject = refOf(gw);
  const out: GatewayIssue[] = [];
  const className = gatewayClassName(gw);
  const cls = index.classes.get(className);
  const classRef: ObjectRef = {
    apiVersion: `${GATEWAY_GROUP}/v1`,
    kind: 'GatewayClass',
    name: className,
  };
  if (!cls && index.known.classes)
    out.push({
      severity: 'error',
      code: 'gateway.class-missing',
      subject,
      title: i18n.t('GatewayClass {class} does not exist', { class: className }),
      hint: i18n.t('Set spec.gatewayClassName to an installed class.'),
      target: classRef,
    });
  else if (
    cls &&
    findCondition(conditionsOf(status(cls).conditions), 'Accepted')?.status === 'False'
  )
    out.push({
      severity: 'error',
      code: 'gateway.class-not-accepted',
      subject,
      title: i18n.t('GatewayClass {class} is not accepted by its controller', { class: className }),
      target: classRef,
    });

  const conds = conditionsOf(status(gw).conditions);
  const accepted = findCondition(conds, 'Accepted');
  const programmed = findCondition(conds, 'Programmed');
  if (accepted?.status === 'False')
    out.push({
      severity: 'error',
      code: 'gateway.not-accepted',
      subject,
      title: i18n.t('Gateway is not accepted: {reason}', { reason: accepted.reason }),
      detail: detailOf(accepted),
      hint: gatewayProgrammedHint(accepted.reason),
    });
  if (programmed?.status === 'False')
    out.push({
      severity: 'error',
      code: 'gateway.not-programmed',
      subject,
      title: i18n.t('Gateway is not programmed: {reason}', { reason: programmed.reason }),
      detail: detailOf(programmed),
      hint: gatewayProgrammedHint(programmed.reason),
    });
  else if (programmed?.status === 'Unknown')
    out.push({
      severity: 'warning',
      code: 'gateway.programming',
      subject,
      title: i18n.t('Gateway is not programmed yet'),
      detail: detailOf(programmed),
    });
  if (!conds.length && cls)
    out.push({
      severity: 'warning',
      code: 'gateway.no-status',
      subject,
      title: i18n.t('No controller has reported on this Gateway'),
      hint: i18n.t('Check that the controller of GatewayClass {class} ({controller}) is running.', {
        class: className,
        controller: implementationName(classController(cls)),
      }),
    });

  const listeners = gatewayListeners(gw);
  const seen = new Map<string, string>();
  for (const l of listeners) {
    out.push(...listenerIssues(gw, l));
    const key = `${l.port}|${l.protocol}|${(l.hostname ?? '').toLowerCase()}`;
    const other = seen.get(key);
    if (other)
      out.push({
        severity: 'error',
        code: 'gateway.listener-duplicate',
        subject,
        title: i18n.t('Listeners {first} and {second} use the same port, protocol and hostname', {
          first: other,
          second: l.name,
        }),
      });
    else seen.set(key, l.name);
    const terminates =
      (l.protocol === 'HTTPS' || l.protocol === 'TLS') &&
      (l.tls?.mode ?? 'Terminate') === 'Terminate';
    if (terminates && !l.tls)
      out.push({
        severity: 'error',
        code: 'gateway.listener-no-tls',
        subject,
        title: i18n.t('Listener {listener} ({protocol}) has no TLS configuration', {
          listener: l.name,
          protocol: l.protocol,
        }),
        hint: i18n.t('Add tls.certificateRefs with the certificate Secret.'),
      });
    else if (terminates && !l.tls?.certificateRefs.length)
      out.push({
        severity: 'warning',
        code: 'gateway.listener-no-certificate',
        subject,
        title: i18n.t('Listener {listener} terminates TLS without certificateRefs', {
          listener: l.name,
        }),
      });
    for (const ref of l.tls?.certificateRefs ?? []) {
      const permitted = referencePermitted(
        index,
        { group: GATEWAY_GROUP, kind: 'Gateway', namespace: gw.metadata.namespace ?? '' },
        { group: ref.group, kind: ref.kind, namespace: ref.namespace, name: ref.name },
      );
      if (permitted === false)
        out.push({
          severity: 'error',
          code: 'gateway.certificate-not-permitted',
          subject,
          title: i18n.t(
            'Certificate {secret} of listener {listener} is in another namespace without a ReferenceGrant',
            {
              secret: `${ref.namespace}/${ref.name}`,
              listener: l.name,
            },
          ),
          hint: i18n.t(
            'Create a ReferenceGrant in {namespace} from Gateway in {from} to Secret {name}.',
            {
              namespace: ref.namespace,
              from: gw.metadata.namespace ?? '',
              name: ref.name,
            },
          ),
          target: { apiVersion: 'v1', kind: 'Secret', name: ref.name, namespace: ref.namespace },
        });
    }
  }
  if (!listeners.length)
    out.push({
      severity: 'error',
      code: 'gateway.no-listeners',
      subject,
      title: i18n.t('Gateway has no listeners'),
    });

  if (programmed?.status === 'True' && !asArray(status(gw).addresses).filter(isObject).length)
    out.push({
      severity: 'info',
      code: 'gateway.no-address',
      subject,
      title: i18n.t('Gateway is programmed but reports no address'),
    });

  const attached = routesOf(index, gw);
  for (const l of listeners) {
    const hasRoutes =
      (l.status?.attachedRoutes ?? 0) > 0 || attached.some((a) => a.listeners.includes(l.name));
    if (!hasRoutes && l.protocol !== 'TLS' && l.status)
      out.push({
        severity: 'info',
        code: 'gateway.listener-idle',
        subject,
        title: i18n.t('No routes are attached to listener {listener}', { listener: l.name }),
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GatewayClasses
// ---------------------------------------------------------------------------

export function diagnoseGatewayClass(index: GatewayIndex, cls: KubeObject): GatewayIssue[] {
  const subject = refOf(cls);
  const out: GatewayIssue[] = [];
  const conds = conditionsOf(status(cls).conditions);
  const accepted = findCondition(conds, 'Accepted');
  const controller = classController(cls);
  if (!accepted || accepted.status === 'Unknown')
    out.push({
      severity: 'warning',
      code: 'class.unclaimed',
      subject,
      title: i18n.t('No controller has accepted this class'),
      detail: accepted ? detailOf(accepted) : undefined,
      hint: i18n.t('Check that the controller for {controller} is installed and running.', {
        controller,
      }),
    });
  else if (accepted.status === 'False')
    out.push({
      severity: 'error',
      code: 'class.not-accepted',
      subject,
      title: i18n.t('GatewayClass is not accepted: {reason}', { reason: accepted.reason }),
      detail: detailOf(accepted),
      hint:
        accepted.reason === 'InvalidParameters'
          ? i18n.t('spec.parametersRef points to a missing or invalid parameters object.')
          : undefined,
    });
  const supported = findCondition(conds, 'SupportedVersion');
  if (supported?.status === 'False')
    out.push({
      severity: 'warning',
      code: 'class.unsupported-version',
      subject,
      title: i18n.t('The installed Gateway API CRDs are not supported by the controller'),
      detail: detailOf(supported),
    });
  if (!gatewaysOfClass(index, cls.metadata.name).length && index.known.gateways)
    out.push({
      severity: 'info',
      code: 'class.unused',
      subject,
      title: i18n.t('No Gateway uses this class'),
    });
  return out;
}

// ---------------------------------------------------------------------------
// Policies (targetRefs + ancestor status)
// ---------------------------------------------------------------------------

/** Kinds a policy's targetRefs may name that the index can resolve. */
/**
 * Whether a policy target exists: `true` / `false` when its list is
 * complete, `null` when it cannot be told (an incomplete list, or a kind
 * the index does not hold).
 */
function targetExists(
  index: GatewayIndex,
  kind: string,
  group: string,
  ns: string,
  name: string,
): boolean | null {
  const answer = (found: boolean, known: boolean) => (found ? true : known ? false : null);
  if (group === GATEWAY_GROUP && kind === 'Gateway')
    return answer(gatewayOf(index, ns, name) !== null, index.known.gateways);
  if (group === GATEWAY_GROUP && kind === 'GatewayClass')
    return answer(index.classes.has(name), index.known.classes);
  if (group === GATEWAY_GROUP && isRouteKind(kind))
    return answer(
      index.routes.some(
        (r) => r.kind === kind && r.metadata.name === name && r.metadata.namespace === ns,
      ),
      index.known.routes,
    );
  if (group === '' && kind === 'Service')
    return answer(index.services.has(`${ns}/${name}`), index.known.services);
  return null;
}

export function diagnosePolicy(index: GatewayIndex, policy: KubeObject): GatewayIssue[] {
  const subject = refOf(policy);
  const out: GatewayIssue[] = [];
  const targets = policyTargets(policy);
  const selectors = asArray(spec(policy).targetSelectors).length;
  if (!targets.length && !selectors)
    out.push({
      severity: 'warning',
      code: 'policy.no-targets',
      subject,
      title: i18n.t('The policy has no targetRefs'),
    });
  for (const t of targets) {
    if (targetExists(index, t.kind, t.group, t.namespace, t.name) === false)
      out.push({
        severity: 'error',
        code: 'policy.target-missing',
        subject,
        title: i18n.t('Target {kind} {name} does not exist', { kind: t.kind, name: t.name }),
        target: {
          apiVersion: t.group ? `${t.group}/v1` : 'v1',
          kind: t.kind,
          name: t.name,
          namespace: t.namespace,
        },
      });
  }
  const ancestors = policyAncestors(policy);
  for (const a of ancestors) {
    const label = parentLabel(a.ancestorRef);
    const accepted = findCondition(a.conditions, 'Accepted');
    if (accepted?.status === 'False')
      out.push({
        severity: accepted.reason === 'Conflicted' ? 'warning' : 'error',
        code: accepted.reason === 'Conflicted' ? 'policy.conflicted' : 'policy.not-accepted',
        subject,
        title: i18n.t('Not accepted for {ancestor}: {reason}', {
          ancestor: label,
          reason: accepted.reason,
        }),
        detail: detailOf(accepted),
      });
    const overridden = findCondition(a.conditions, 'Overridden');
    if (overridden?.status === 'True')
      out.push({
        severity: 'warning',
        code: 'policy.overridden',
        subject,
        title: i18n.t('Overridden for {ancestor} by a more specific policy', { ancestor: label }),
        detail: detailOf(overridden),
      });
  }
  if (!ancestors.length && targets.length)
    out.push({
      severity: 'warning',
      code: 'policy.no-status',
      subject,
      title: i18n.t('No controller has reported on this policy'),
    });
  return out;
}

/** Findings for a whole set of objects, most severe first. */
export function diagnoseAll(
  index: GatewayIndex,
  objects: {
    classes: readonly KubeObject[];
    gateways: readonly KubeObject[];
    routes: readonly KubeObject[];
    policies: readonly KubeObject[];
  },
): GatewayIssue[] {
  return sortIssues([
    ...objects.classes.flatMap((c) => diagnoseGatewayClass(index, c)),
    ...objects.gateways.flatMap((g) => diagnoseGateway(index, g)),
    ...objects.routes.flatMap((r) => diagnoseRoute(index, r)),
    ...objects.policies.flatMap((p) => diagnosePolicy(index, p)),
  ]);
}

export function countBySeverity(issues: readonly GatewayIssue[]) {
  const out: Record<IssueSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity]++;
  return out;
}
