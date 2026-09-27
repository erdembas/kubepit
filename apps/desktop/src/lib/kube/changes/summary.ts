import * as i18n from '@/i18n/core';
import type { ChangeActor, ChangedPath, ChangeOp, ChangeSummary } from '@/types';

/** Human-readable pieces of a journal entry (pure; the timeline renders them). */

export type PathChangeKind = 'changed' | 'added' | 'removed';

export interface PathChange {
  path: string;
  kind: PathChangeKind;
  /** Old / new value; always `null` for redacted (Secret) paths. */
  before: string | null;
  after: string | null;
  redacted: boolean;
}

export function pathChange(p: ChangedPath): PathChange {
  const kind: PathChangeKind =
    p.before === null ? 'added' : p.after === null ? 'removed' : 'changed';
  return {
    path: p.path,
    kind,
    before: p.redacted ? null : p.before,
    after: p.redacted ? null : p.after,
    redacted: p.redacted,
  };
}

/** One line of plain text per path, e.g. `spec.replicas: 3 → 5` or `data.KEY changed`. */
export function describePath(p: ChangedPath): string {
  const c = pathChange(p);
  if (c.redacted) {
    if (c.kind === 'added') return i18n.t('{path} added', { path: c.path });
    if (c.kind === 'removed') return i18n.t('{path} removed', { path: c.path });
    return i18n.t('{path} changed', { path: c.path });
  }
  if (c.kind === 'added') return i18n.t('{path} set to {value}', { path: c.path, value: c.after });
  if (c.kind === 'removed')
    return i18n.t('{path} removed (was {value})', { path: c.path, value: c.before });
  return `${c.path}: ${c.before} → ${c.after}`;
}

export function opLabel(op: ChangeOp): string {
  switch (op) {
    case 'added':
      return i18n.t('Created');
    case 'deleted':
      return i18n.t('Deleted');
    default:
      return i18n.t('Updated');
  }
}

/** `Deployment shop/web updated`. */
export function changeHeadline(entry: ChangeSummary): string {
  const values = {
    kind: entry.gvk.kind,
    name: entry.namespace ? `${entry.namespace}/${entry.name}` : entry.name,
  };
  switch (entry.op) {
    case 'added':
      return i18n.t('{kind} {name} created', values);
    case 'deleted':
      return i18n.t('{kind} {name} deleted', values);
    default:
      return i18n.t('{kind} {name} updated', values);
  }
}

/** Short text of an entry for tooltips and copy: headline and the first paths. */
export function describeChange(entry: ChangeSummary): string {
  const head = changeHeadline(entry);
  if (entry.op !== 'modified' || !entry.paths.length) return head;
  return [head, ...entry.paths.slice(0, 5).map(describePath)].join('\n');
}

export type ActorClass = 'human' | 'gitops' | 'controller' | 'unknown';

const HUMAN =
  /^(kubectl|kubepit|k9s|lens|freelens|headlamp|octant|kubernetes-dashboard|dashboard)/i;
const GITOPS =
  /(argocd|argo-cd|flux|helm|kustomize|kapp|pulumi|terraform|crossplane|spinnaker|gitops)/i;

/** Rough origin of a field manager: a person with a CLI/UI, GitOps/Helm, or a controller. */
export function actorClass(actor: ChangeActor | null): ActorClass {
  if (!actor) return 'unknown';
  if (HUMAN.test(actor.manager)) return 'human';
  if (GITOPS.test(actor.manager)) return 'gitops';
  return 'controller';
}

/** `kubectl-scale`, `kube-controller-manager (scale)`. */
export function actorLabel(actor: ChangeActor): string {
  return actor.subresource ? `${actor.manager} (${actor.subresource})` : actor.manager;
}

export function actorTitle(actor: ChangeActor): string {
  const cls = actorClass(actor);
  const origin =
    cls === 'human'
      ? i18n.t('Made from a command line or UI')
      : cls === 'gitops'
        ? i18n.t('Made by GitOps or Helm')
        : i18n.t('Made by a controller');
  const operation = actor.operation
    ? i18n.t('Field manager {manager} · {operation}', {
        manager: actor.manager,
        operation: actor.operation,
      })
    : i18n.t('Field manager {manager}', { manager: actor.manager });
  return `${operation}\n${origin}`;
}
