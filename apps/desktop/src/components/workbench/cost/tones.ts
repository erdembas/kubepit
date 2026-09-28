import type { BadgeTone } from '@/components/ui/Badge';
import type { RightsizingConfidence, RightsizingVerdict } from '@/types';

/** Badge tones of right-sizing confidence and verdicts. */
export const CONFIDENCE_TONE: Record<RightsizingConfidence, BadgeTone> = {
  high: 'success',
  medium: 'info',
  low: 'neutral',
};

export const VERDICT_TONE: Record<RightsizingVerdict, BadgeTone> = {
  over: 'info',
  under: 'warning',
  balanced: 'success',
  'no-data': 'neutral',
};

/** Text colour of an efficiency band. */
export const EFFICIENCY_TEXT = {
  good: 'text-status-running',
  fair: 'text-status-starting',
  poor: 'text-status-error',
} as const;
