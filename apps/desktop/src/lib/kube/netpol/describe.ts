import * as i18n from '@/i18n/core';
import type { LabelSelector } from '../selectors';
import { formatRange, type IpRange } from './ip';
import type { NpPeer, NpPortSpec, NpRule, NpWorkloadRef } from './model';
import { isAllOf, isAllPorts, isEmptyPorts, portEntries, type PortSet } from './ports';

/**
 * Plain-language descriptions of selectors, peers and ports. Labels,
 * namespaces, CIDRs and port names are Kubernetes data and stay verbatim.
 */

export function selectorTerms(sel: LabelSelector | null): string[] {
  if (!sel) return [];
  const out = Object.entries(sel.matchLabels).map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions) {
    if (e.operator === 'Exists') out.push(e.key);
    else if (e.operator === 'DoesNotExist') out.push(`!${e.key}`);
    else if (e.operator === 'In') out.push(`${e.key} in (${e.values.join(', ')})`);
    else if (e.operator === 'NotIn') out.push(`${e.key} notin (${e.values.join(', ')})`);
    else out.push(`${e.key} ${e.operator} (${e.values.join(', ')})`);
  }
  return out;
}

export function isEmptySelector(sel: LabelSelector | null): boolean {
  return !!sel && !Object.keys(sel.matchLabels).length && !sel.matchExpressions.length;
}

function joinTerms(sel: LabelSelector): string {
  return selectorTerms(sel).join(', ');
}

/** The pods a policy applies to. */
export function podSelectorText(sel: LabelSelector, namespace: string): string {
  return isEmptySelector(sel)
    ? i18n.t('every pod in namespace {namespace}', { namespace })
    : i18n.t('pods matching {selector} in namespace {namespace}', {
        selector: joinTerms(sel),
        namespace,
      });
}

/** One peer of a rule, in the policy's namespace. */
export function peerText(peer: NpPeer, policyNamespace: string): string {
  switch (peer.type) {
    case 'invalid':
      return i18n.t('an invalid peer (matches nothing)');
    case 'ipBlock':
      return peer.except.length
        ? i18n.t('addresses in {cidr} except {except}', {
            cidr: peer.cidr,
            except: peer.except.join(', '),
          })
        : i18n.t('addresses in {cidr}', { cidr: peer.cidr });
    case 'pods': {
      const pods = peer.podSelector && !isEmptySelector(peer.podSelector) ? peer.podSelector : null;
      if (!peer.namespaceSelector)
        return pods
          ? i18n.t('pods matching {selector} in namespace {namespace}', {
              selector: joinTerms(pods),
              namespace: policyNamespace,
            })
          : i18n.t('every pod in namespace {namespace}', { namespace: policyNamespace });
      const allNs = isEmptySelector(peer.namespaceSelector);
      if (!pods)
        return allNs
          ? i18n.t('every pod in every namespace')
          : i18n.t('every pod in namespaces matching {selector}', {
              selector: joinTerms(peer.namespaceSelector),
            });
      return allNs
        ? i18n.t('pods matching {selector} in every namespace', { selector: joinTerms(pods) })
        : i18n.t('pods matching {selector} in namespaces matching {namespaceSelector}', {
            selector: joinTerms(pods),
            namespaceSelector: joinTerms(peer.namespaceSelector),
          });
    }
  }
}

export function portSpecText(spec: NpPortSpec): string {
  if (spec.port === null) return i18n.t('all {protocol} ports', { protocol: spec.protocol });
  if (spec.endPort !== null && typeof spec.port === 'number' && spec.endPort !== spec.port)
    return `${spec.protocol} ${spec.port}–${spec.endPort}`;
  return `${spec.protocol} ${spec.port}`;
}

export function rulePortsText(rule: NpRule): string {
  if (rule.ports === null) return i18n.t('any port');
  if (!rule.ports.length) return i18n.t('no port (every entry is invalid)');
  return rule.ports.map(portSpecText).join(', ');
}

/** Ports of a resolved port set: `TCP 8080, UDP 53`. */
export function portSetText(set: PortSet): string {
  if (isAllPorts(set)) return i18n.t('any port');
  if (isEmptyPorts(set)) return i18n.t('no port');
  return portEntries(set)
    .map(([protocol, ranges]) =>
      isAllOf(set, protocol)
        ? i18n.t('all {protocol} ports', { protocol })
        : `${protocol} ${ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')}`,
    )
    .join(' · ');
}

export function workloadText(ref: NpWorkloadRef): string {
  return `${ref.kind}/${ref.name}`;
}

export function rangeText(range: IpRange): string {
  return formatRange(range);
}
