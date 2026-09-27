/** Traffic-light tint for utilisation percentages (usage / capacity). */
export function usageToneClass(percent: number): string {
  if (percent >= 90) return 'text-status-error';
  if (percent >= 70) return 'text-status-starting';
  if (percent >= 1) return 'text-status-running';
  return 'text-fg-muted';
}

export function usageBarClass(percent: number): string {
  if (percent >= 90) return 'bg-status-error';
  if (percent >= 70) return 'bg-status-starting';
  return 'bg-status-running';
}
