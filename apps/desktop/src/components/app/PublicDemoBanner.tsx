import * as i18n from '@/i18n';
import { ArrowLeft, FlaskConical, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/** Included only in the hosted demo build; the desktop keeps its normal chrome. */
export function PublicDemoBanner() {
  i18n.useLocale();
  const website = import.meta.env.BASE_URL.replace(/demo\/$/, '');
  return (
    <aside
      aria-label={i18n.t('Public browser demo')}
      className="border-accent/25 bg-accent/8 text-fg relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 text-[11px]"
    >
      <span className="text-accent flex items-center gap-1.5 font-semibold tracking-[0.12em] uppercase">
        <FlaskConical size={13} aria-hidden="true" />
        {i18n.t('Public demo')}
      </span>
      <p className="text-fg-muted min-w-0 flex-1">
        {i18n.t('Synthetic data. No real clusters. Every action is simulated.')}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          leftIcon={<RotateCcw size={12} aria-hidden="true" />}
          title={i18n.t(
            'Reload resets resource changes; layout and settings stay in this browser.',
          )}
          onClick={() => window.location.reload()}
        >
          {i18n.t('Reload demo')}
        </Button>
        <a
          href={website}
          className="text-fg-muted hover:bg-fg/5 hover:text-fg flex h-6 items-center gap-1 rounded px-2 transition"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          {i18n.t('Back to website')}
        </a>
      </div>
    </aside>
  );
}
