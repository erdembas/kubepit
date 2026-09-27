import * as i18n from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

// Literal class sets so Tailwind keeps them; a tag always maps to the same tone.
const TONES = [
  { bg: 'bg-cat-frontend/10', color: 'text-cat-frontend', ring: 'ring-cat-frontend/25' },
  { bg: 'bg-cat-backend/10', color: 'text-cat-backend', ring: 'ring-cat-backend/25' },
  { bg: 'bg-cat-database/10', color: 'text-cat-database', ring: 'ring-cat-database/25' },
  { bg: 'bg-cat-infra/10', color: 'text-cat-infra', ring: 'ring-cat-infra/25' },
  { bg: 'bg-cat-worker/10', color: 'text-cat-worker', ring: 'ring-cat-worker/25' },
  { bg: 'bg-cat-tooling/10', color: 'text-cat-tooling', ring: 'ring-cat-tooling/25' },
  { bg: 'bg-cat-other/10', color: 'text-cat-other', ring: 'ring-cat-other/25' },
] as const;

export function tagTone(tag: string) {
  let hash = 0;
  for (const ch of tag) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

interface Props {
  tag: string;
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
  size?: 'sm' | 'md';
}

export function TagChip({ tag, onRemove, onClick, active, size = 'sm' }: Props) {
  i18n.useLocale();
  const tone = tagTone(tag);
  const sizing = size === 'md' ? 'text-[11px] px-2 py-0.5' : 'text-[11px] px-1.5 py-0.5';
  return (
    <span
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-app-sm inline-flex items-center gap-1 ring-1 transition',
        sizing,
        tone.bg,
        tone.color,
        tone.ring,
        onClick && 'cursor-pointer hover:brightness-110',
        active && 'ring-2',
      )}
    >
      <span className="font-medium">{tag}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex h-3 w-3 items-center justify-center opacity-60 hover:opacity-100"
          aria-label={i18n.t('Remove {tag}', { tag: tag })}
        >
          <X className="h-2 w-2" />
        </button>
      )}
    </span>
  );
}
