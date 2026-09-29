import * as i18n from '@/i18n';
import { useId, type ReactNode } from 'react';
import { issuesOf, type SettingsIssue } from '@/lib/ai/settingsIssues';

export function Issues({ issues, field }: { issues: readonly SettingsIssue[]; field: string }) {
  i18n.useLocale();
  return (
    <>
      {issuesOf(issues, field).map((issue, index) => (
        <p
          key={index}
          role={issue.severity === 'error' ? 'alert' : undefined}
          className={`mt-1 text-[11px] ${issue.severity === 'error' ? 'text-status-error' : 'text-status-starting'}`}
        >
          {issue.message}
        </p>
      ))}
    </>
  );
}

export function Field({
  label,
  children,
  issues = [],
  field = '',
}: {
  label: string;
  children: ReactNode;
  issues?: readonly SettingsIssue[];
  field?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <div id={id} className="text-fg-muted mb-1 text-[11px]">
        {label}
      </div>
      <div role="group" aria-labelledby={id}>
        {children}
      </div>
      <Issues issues={issues} field={field} />
    </div>
  );
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
