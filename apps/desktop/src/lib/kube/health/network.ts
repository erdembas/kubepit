import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, spec, status, type JsonObject } from '../accessors';
import { podIsReady } from '../pods';
import { matchesSelector, parseSelector, selectorText } from '../selectors';
import { groupByNamespace, makeFinding, nsKey, type Emit } from './context';
import type { HealthInput } from './types';

/** Services without (ready) endpoints and Ingresses pointing at nothing. */

function servingPods(pods: readonly KubeObject[]) {
  return pods.filter((p) => {
    if (p.metadata.deletionTimestamp) return false;
    const phase = asString(status(p).phase);
    return phase !== 'Succeeded' && phase !== 'Failed';
  });
}

export function serviceFindings(input: HealthInput, emit: Emit) {
  const byNs = groupByNamespace(servingPods(input.pods));
  for (const svc of input.services) {
    const s = spec(svc);
    if (asString(s.type) === 'ExternalName') continue;
    const selector = parseSelector(s.selector);
    if (!selector) continue;
    const matched = (byNs.get(svc.metadata.namespace ?? '') ?? []).filter((p) =>
      matchesSelector(selector, p.metadata.labels),
    );
    if (!matched.length) {
      emit(
        makeFinding(
          'service-no-pods',
          svc,
          i18n.t('Selector {selector} matches no pods', {
            selector: selectorText(s.selector).join(','),
          }),
        ),
      );
    } else if (s.publishNotReadyAddresses !== true && !matched.some(podIsReady)) {
      emit(
        makeFinding(
          'service-no-ready-endpoints',
          svc,
          i18n.plural(
            'The selected pod is not ready',
            'None of the {count} selected pods is ready',
            matched.length,
          ),
        ),
      );
    }
  }
}

interface Backend {
  service: string;
  port: string;
}

function backendOf(b: JsonObject): Backend | null {
  const svc = asObject(b.service);
  if (isObject(b.service)) {
    const port = asObject(svc.port);
    return {
      service: asString(svc.name),
      port: port.number !== undefined ? asString(port.number) : asString(port.name),
    };
  }
  // networking.k8s.io/v1beta1
  if (b.serviceName !== undefined)
    return { service: asString(b.serviceName), port: asString(b.servicePort) };
  return null;
}

function ingressBackends(ing: KubeObject): Backend[] {
  const s = spec(ing);
  const out: Backend[] = [];
  const def = asObject(s.defaultBackend ?? s.backend);
  const d = backendOf(def);
  if (d) out.push(d);
  for (const rule of asArray(s.rules).filter(isObject))
    for (const path of asArray(asObject(rule.http).paths).filter(isObject)) {
      const b = backendOf(asObject(path.backend));
      if (b) out.push(b);
    }
  return out;
}

export function ingressFindings(input: HealthInput, emit: Emit) {
  const services = new Map(
    input.services.map((s) => [nsKey(s.metadata.namespace, s.metadata.name), s]),
  );
  const secrets = new Set(input.secrets.map((s) => nsKey(s.metadata.namespace, s.metadata.name)));
  const checkServices = input.loaded.has('services');
  const checkSecrets = input.loaded.has('secrets');
  for (const ing of input.ingresses) {
    const ns = ing.metadata.namespace;
    if (checkServices) {
      const seen = new Set<string>();
      for (const b of ingressBackends(ing)) {
        if (!b.service || seen.has(`${b.service}:${b.port}`)) continue;
        seen.add(`${b.service}:${b.port}`);
        const svc = services.get(nsKey(ns, b.service));
        if (!svc) {
          emit(
            makeFinding(
              'ingress-missing-service',
              ing,
              i18n.t('Backend service {service} does not exist', { service: b.service }),
              b.service,
            ),
          );
          continue;
        }
        if (!b.port) continue;
        const ports = asArray(spec(svc).ports).filter(isObject);
        const ok = ports.some((p) => asString(p.port) === b.port || asString(p.name) === b.port);
        if (!ok)
          emit(
            makeFinding(
              'ingress-missing-port',
              ing,
              i18n.t('Service {service} has no port {port}', { service: b.service, port: b.port }),
              `${b.service}:${b.port}`,
            ),
          );
      }
    }
    if (checkSecrets) {
      for (const tls of asArray(spec(ing).tls).filter(isObject)) {
        const name = asString(tls.secretName);
        if (!name || secrets.has(nsKey(ns, name))) continue;
        emit(
          makeFinding(
            'ingress-missing-tls-secret',
            ing,
            i18n.t('TLS secret {secret} does not exist', { secret: name }),
            name,
          ),
        );
      }
    }
  }
}
