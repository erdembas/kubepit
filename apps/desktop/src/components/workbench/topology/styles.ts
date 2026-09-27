import type { StatusTone } from '@/lib/kube/pods';
import type { EdgeFamily } from '@/lib/kube/topology';

/** Literal class names (Tailwind scans them) for the SVG map, all theme tokens. */

export const TONE_TEXT_FILL: Record<StatusTone, string> = {
  success: 'fill-status-running',
  warning: 'fill-status-starting',
  error: 'fill-status-error',
  info: 'fill-cat-frontend',
  muted: 'fill-fg-dim',
};

export const TONE_SOFT_FILL: Record<StatusTone, string> = {
  success: 'fill-status-running/12',
  warning: 'fill-status-starting/15',
  error: 'fill-status-error/12',
  info: 'fill-cat-frontend/12',
  muted: 'fill-fg/6',
};

export const TONE_ICON: Record<StatusTone, string> = {
  success: 'text-status-running',
  warning: 'text-status-starting',
  error: 'text-status-error',
  info: 'text-cat-frontend',
  muted: 'text-fg-dim',
};

export const TONE_BAR_FILL: Record<StatusTone, string> = {
  success: 'fill-status-running',
  warning: 'fill-status-starting',
  error: 'fill-status-error',
  info: 'fill-cat-frontend',
  muted: 'fill-fg-dim/60',
};

export const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-status-running',
  warning: 'bg-status-starting',
  error: 'bg-status-error',
  info: 'bg-cat-frontend',
  muted: 'bg-fg-dim/60',
};

export const FAMILY_STROKE: Record<EdgeFamily, string> = {
  ownership: 'stroke-fg-dim',
  traffic: 'stroke-cat-frontend',
  config: 'stroke-cat-backend',
  storage: 'stroke-cat-database',
  access: 'stroke-cat-tooling',
  policy: 'stroke-cat-infra',
  scaling: 'stroke-cat-worker',
  scheduling: 'stroke-fg-dim',
};

export const FAMILY_FILL: Record<EdgeFamily, string> = {
  ownership: 'fill-fg-dim',
  traffic: 'fill-cat-frontend',
  config: 'fill-cat-backend',
  storage: 'fill-cat-database',
  access: 'fill-cat-tooling',
  policy: 'fill-cat-infra',
  scaling: 'fill-cat-worker',
  scheduling: 'fill-fg-dim',
};

export const FAMILY_DASH: Record<EdgeFamily, string | undefined> = {
  ownership: undefined,
  traffic: undefined,
  config: '5 4',
  storage: undefined,
  access: '5 4',
  policy: '2 4',
  scaling: '8 3 2 3',
  scheduling: '2 4',
};
