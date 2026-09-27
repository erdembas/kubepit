import type { ComponentType } from 'react';
import {
  isArgoApplication,
  isArgoApplicationSet,
  isArgoProject,
  isFluxObject,
} from '@/lib/kube/gitops/kinds';
import type { KubeObject } from '@/types';
import {
  ArgoApplicationSections,
  ArgoApplicationSetSections,
  ArgoProjectSections,
} from './ArgoSections';
import { fluxSectionsFor } from './FluxSections';
import type { SectionProps } from './types';

/**
 * Details sections for Argo CD and Flux objects. Matched by API group, not
 * by kind name alone (`Application`, `HelmRelease` or `Bucket` exist in
 * other API groups too).
 */
export function gitopsSectionsFor(obj: KubeObject): ComponentType<SectionProps> | null {
  if (isArgoApplication(obj)) return ArgoApplicationSections;
  if (isArgoApplicationSet(obj)) return ArgoApplicationSetSections;
  if (isArgoProject(obj)) return ArgoProjectSections;
  if (isFluxObject(obj)) return fluxSectionsFor(obj);
  return null;
}
