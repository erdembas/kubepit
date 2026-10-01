import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { Investigation } from '@/types/investigations';
import { saveTextAs } from '../dock/shared/saveFile';
import { evidenceKind, evidenceLabel, investigationError } from './labels';

export function ExportInvestigationDialog({
  record,
  onClose,
}: {
  record: Investigation;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [selected, setSelected] = useState(() => record.evidence.map((entry) => entry.id));
  const [preview, setPreview] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setReviewed(false);
    setError(null);
    if (!selected.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void ipc
      .investigationExport(record.id, selected)
      .then((value) => {
        if (!cancelled) setPreview(value);
      })
      .catch((error) => {
        if (!cancelled) setError(investigationError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, selected]);

  const save = async () => {
    if (!preview || !reviewed) return;
    setSaving(true);
    try {
      const name = record.target.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const path = await saveTextAs(
        `${name}-${new Date(record.captured_at).toISOString().slice(0, 10)}.kubepit-investigation.json`,
        preview,
        { name: i18n.t('Investigation bundles'), extensions: ['json'] },
      );
      if (isTauri && !path) return;
      useAppStore
        .getState()
        .pushToast('success', i18n.t('Reviewed investigation bundle exported.'));
      onClose();
    } catch (error) {
      setError(investigationError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={i18n.t('Review investigation export')}
      subtitle={record.title}
      size="xl"
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!preview || !reviewed || loading || saving}
            leftIcon={
              saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
            onClick={() => void save()}
          >
            {i18n.t('Save reviewed bundle')}
          </Button>
        </>
      }
    >
      <p className="text-fg-muted mb-3 text-[12px] leading-relaxed">
        {i18n.t(
          'Choose the evidence to include, then review the exact file below. Known credentials and literal environment values are masked. Logs and notes can still contain sensitive content.',
        )}
      </p>
      <div className="grid min-h-0 gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
        <div className="space-y-1">
          <h4 className="text-fg-dim mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Included evidence')}
          </h4>
          <div className="max-h-80 overflow-y-auto">
            {record.evidence.map((entry) => (
              <label
                key={entry.id}
                className="hover:bg-fg/5 flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[11px]"
              >
                <input
                  type="checkbox"
                  className="accent-accent mt-0.5"
                  disabled={saving}
                  checked={selected.includes(entry.id)}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, entry.id]
                        : old.filter((id) => id !== entry.id),
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="text-fg block">{evidenceKind(entry.kind)}</span>
                  <span
                    className="text-fg-dim block truncate font-mono"
                    title={evidenceLabel(entry.label)}
                  >
                    {evidenceLabel(entry.label)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {!selected.length && (
            <p className="text-status-starting text-[11px]">
              {i18n.t('Select at least one evidence section.')}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <h4 className="text-fg-dim mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Exact export preview')}
          </h4>
          {loading ? (
            <div className="text-fg-dim flex h-64 items-center justify-center gap-2 text-[12px]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Preparing preview…')}
            </div>
          ) : (
            <pre
              tabIndex={0}
              className="border-border bg-surface-muted/40 text-fg-muted h-80 overflow-auto rounded border p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
            >
              {preview ?? ''}
            </pre>
          )}
        </div>
      </div>
      <label className="text-fg mt-4 flex cursor-pointer items-center gap-2 text-[12px]">
        <input
          className="accent-accent"
          type="checkbox"
          checked={reviewed}
          disabled={!preview || loading || saving}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        {i18n.t('I reviewed this exact file and the included evidence.')}
      </label>
      {error && (
        <p role="alert" className="text-status-error mt-3 text-[12px]">
          {error}
        </p>
      )}
    </Dialog>
  );
}
