import * as i18n from '@/i18n';
export function BudgetBar({
  used,
  budget,
  window: contextWindow,
}: {
  used: number;
  budget: number;
  window: number;
}) {
  i18n.useLocale();
  const max = Math.max(1, contextWindow, budget, used);
  return (
    <div className="text-fg-dim space-y-1 text-[11px]">
      <svg
        viewBox="0 0 300 12"
        className="h-3 w-full"
        role="img"
        aria-label={i18n.t('Context: {used} tokens, budget {budget}, model window {window}', {
          used: i18n.number(used),
          budget: i18n.number(budget),
          window: i18n.number(contextWindow),
        })}
      >
        <rect width="300" height="10" y="1" rx="3" className="fill-fg/10" />
        <rect
          width={(used / max) * 300}
          height="10"
          y="1"
          rx="3"
          className={used > budget ? 'fill-status-warning' : 'fill-accent'}
        />
        <path d={`M${(budget / max) * 300},0v12`} className="stroke-fg" strokeWidth="2" />
      </svg>
      <p>
        {i18n.t('≈{used} / {budget} tokens · window {window}', {
          used: i18n.number(used),
          budget: i18n.number(budget),
          window: i18n.number(contextWindow),
        })}
      </p>
    </div>
  );
}
