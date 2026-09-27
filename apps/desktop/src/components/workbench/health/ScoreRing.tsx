import * as i18n from '@/i18n';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { scoreStroke, scoreText } from './severity';

/** Health score (0–100) as a progress ring with the Popeye-style grade in the middle. */
export function ScoreRing({
  score,
  grade,
  size = 112,
  stroke = 9,
  loading,
}: {
  score: number | null;
  grade: string | null;
  size?: number;
  stroke?: number;
  loading?: boolean;
}) {
  i18n.useLocale();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const small = size < 80;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={
          score === null ? i18n.t('Health score') : i18n.t('Health score {score} of 100', { score })
        }
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-fg/8"
        />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${pct * c} ${c}`}
            className={cn(scoreStroke(score), 'transition-[stroke-dasharray] duration-500')}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {loading || score === null ? (
          <Loader2 className="text-fg-dim h-4 w-4 animate-spin" />
        ) : (
          <>
            <span
              className={cn(
                'leading-none font-semibold tracking-tight',
                small ? 'text-[17px]' : 'text-[26px]',
                scoreText(score),
              )}
            >
              {grade}
            </span>
            <span
              className={cn(
                'text-fg-dim mt-1 tabular-nums',
                small ? 'text-[9.5px]' : 'text-[11px]',
              )}
            >
              {score}/100
            </span>
          </>
        )}
      </div>
    </div>
  );
}
