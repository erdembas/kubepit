import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Camera,
  ChevronRight,
  Download,
  FileInput,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { resolveKindName } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import type { KubeObject } from '@/types';
import type {
  Investigation,
  InvestigationEvidence,
  InvestigationSummary,
} from '@/types/investigations';
import { byteLength, MAX_BUNDLE_BYTES, parseInvestigationBundle } from './bundle';
import { ExportInvestigationDialog } from './ExportInvestigationDialog';
import { InvestigationComparisonDialog } from './InvestigationComparisonDialog';
import {
  evidenceKind,
  evidenceLabel,
  evidenceReason,
  evidenceStatus,
  investigationError,
} from './labels';
import { startInvestigation, useInvestigationStore } from './navigation';

/** All reads, edits, imports and exports are local. Only Capture again
 * needs a currently connected, still-registered source cluster. */
export function InvestigationsPage({
  clusterId,
  active = true,
}: {
  clusterId?: string;
  active?: boolean;
}) {
  i18n.useLocale();
  const scope = clusterId ?? 'all';
  const selectedId = useInvestigationStore((state) => state.selected[scope]);
  const revision = useInvestigationStore((state) => state.revision);
  const captures = useInvestigationStore((state) => state.capturing);
  const drafts = useInvestigationStore((state) => state.drafts);
  const statuses = useAppStore((state) => state.statuses);
  const [records, setRecords] = useState<InvestigationSummary[]>([]);
  const [record, setRecord] = useState<Investigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [lookback, setLookback] = useState<'15' | '60'>('15');
  const fileInput = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const capturing = clusterId ? !!captures[clusterId] : Object.values(captures).some(Boolean);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await ipc.investigationsList(clusterId ?? null);
      if (seq !== requestSeq.current) return;
      setRecords(rows);
      const id = useInvestigationStore.getState().selected[scope];
      if (!id || !rows.some((row) => row.id === id))
        useInvestigationStore.getState().select(scope, rows[0]?.id ?? '');
    } catch (error) {
      if (seq === requestSeq.current) setError(investigationError(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [clusterId, scope]);
  useEffect(() => {
    if (active) void refresh();
    return () => {
      requestSeq.current++;
    };
  }, [active, refresh, revision]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (!selectedId) {
      setRecord(null);
      return;
    }
    setDetailLoading(true);
    setExporting(false);
    setComparing(false);
    void ipc
      .investigationGet(selectedId)
      .then((value) => {
        if (!cancelled) {
          setRecord(value);
          setLookback(String(value.lookback_minutes) as '15' | '60');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRecord(null);
          setError(investigationError(error));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, selectedId, revision]);
  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [drafts]);

  const draft = record ? drafts[record.id] : undefined;
  const title = draft?.title ?? record?.title ?? '';
  const notes = draft?.notes ?? record?.notes ?? '';
  const dirty = !!record && (title !== record.title || notes !== record.notes);
  const patch = (patch: { title?: string; notes?: string }) => {
    if (!record) return;
    const next = { title, notes, ...patch };
    if (next.title === record.title && next.notes === record.notes)
      useInvestigationStore.getState().clearDraft(record.id);
    else useInvestigationStore.getState().draft(record.id, next);
  };
  const save = async () => {
    if (!record || !dirty) return;
    const id = record.id;
    setBusy(true);
    setError(null);
    try {
      const updated = await ipc.investigationUpdate(id, title, notes);
      useInvestigationStore.getState().clearDraft(id);
      setRecord(updated);
      useInvestigationStore.getState().saved(updated);
      useAppStore.getState().pushToast('success', i18n.t('Investigation notes saved.'));
    } catch (error) {
      setError(investigationError(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!record) return;
    setDeleting(false);
    setBusy(true);
    try {
      await ipc.investigationDelete(record.id);
      useInvestigationStore.getState().clearDraft(record.id);
      setRecord(null);
      await refresh();
    } catch (error) {
      setError(investigationError(error));
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      if (file.size > MAX_BUNDLE_BYTES) throw new Error('investigations:bundle-too-large');
      const text = await file.text();
      parseInvestigationBundle(text);
      const imported = await ipc.investigationImport(text);
      useInvestigationStore.getState().saved(imported);
      useInvestigationStore.getState().select(scope, imported.id);
      useAppStore.getState().pushToast('success', i18n.t('Investigation bundle opened locally.'));
    } catch (error) {
      setError(investigationError(error));
    } finally {
      setBusy(false);
    }
  };
  const canCapture = !!record?.cluster_id && statuses[record.cluster_id]?.state === 'connected';
  const captureAgain = () => {
    if (!record?.cluster_id || !canCapture) return;
    const gvk = resolveKindName(record.target.kind, []);
    if (!gvk) return;
    const object: KubeObject = {
      apiVersion: record.target.api_version,
      kind: record.target.kind,
      metadata: { name: record.target.name, namespace: record.target.namespace, uid: '' },
    };
    void startInvestigation(record.cluster_id, gvk, object, Number(lookback) as 15 | 60);
  };
  const visible = records.filter((row) =>
    `${row.title} ${row.cluster_name} ${row.target.namespace} ${row.target.name}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );

  return (
    <div className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-fg flex items-center gap-2 text-[13px] font-semibold">
            <Archive className="text-accent h-4 w-4" />
            {i18n.t('Investigations')}
          </h2>
          <p className="text-fg-dim mt-1 text-[11px]">
            {i18n.t('Frozen evidence and notes, saved on this device. Available offline.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading || busy}
            leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
          >
            {i18n.t('Refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            leftIcon={<FileInput className="h-3.5 w-3.5" />}
          >
            {i18n.t('Open bundle')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label={i18n.t('Open investigation bundle')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>
      </header>
      {capturing && (
        <div
          role="status"
          className="border-accent/20 bg-accent/5 text-accent flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[12px]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t(
            'Capturing bounded evidence… Unavailable sources will be marked in the saved investigation.',
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="border-status-error/20 bg-status-error/5 text-status-error shrink-0 border-b px-4 py-2 text-[12px]"
        >
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto @3xl/main:flex-row @3xl/main:overflow-hidden">
        <aside className="border-border flex max-h-72 w-full shrink-0 flex-col border-b @3xl/main:max-h-none @3xl/main:w-64 @3xl/main:border-r @3xl/main:border-b-0">
          <div className="relative p-3">
            <Search className="text-fg-dim pointer-events-none absolute top-[21px] left-5 h-3.5 w-3.5" />
            <Input
              className="pl-7"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={i18n.t('Search investigations…')}
              aria-label={i18n.t('Search investigations')}
            />
          </div>
          <p className="text-fg-dim px-3 pb-2 text-[10px] font-semibold tracking-[0.12em] uppercase">
            {i18n.plural(
              '{count} saved investigation',
              '{count} saved investigations',
              records.length,
            )}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {visible.map((row) => (
              <button
                key={row.id}
                disabled={busy}
                className={cn(
                  'hover:bg-fg/5 relative flex w-full flex-col gap-1 px-4 py-2.5 text-left',
                  selectedId === row.id &&
                    'bg-accent/7 before:bg-accent before:absolute before:inset-y-1 before:left-0 before:w-0.5',
                )}
                onClick={() => useInvestigationStore.getState().select(scope, row.id)}
              >
                <span className="text-fg truncate text-[12px] font-medium">
                  {drafts[row.id]?.title ?? row.title}
                  {drafts[row.id] && (
                    <span
                      className="text-status-starting ml-1.5"
                      aria-label={i18n.t('Unsaved edits')}
                    >
                      •
                    </span>
                  )}
                </span>
                <span className="text-fg-dim truncate text-[11px]">
                  {row.cluster_name} · {row.target.namespace}
                </span>
                <span className="text-fg-dim text-[10px]">
                  {new Date(row.captured_at).toLocaleString()}
                  {row.imported && <span className="text-accent ml-2">{i18n.t('Imported')}</span>}
                </span>
              </button>
            ))}
            {!loading && !visible.length && (
              <p className="text-fg-dim px-4 py-3 text-[12px]">
                {search
                  ? i18n.t('No investigations match this search.')
                  : i18n.t('No saved investigations yet.')}
              </p>
            )}
          </div>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 @3xl/main:overflow-y-auto">
          {detailLoading ? (
            <div className="text-fg-dim flex h-48 items-center justify-center gap-2 text-[12px]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading investigation…')}
            </div>
          ) : record ? (
            <div className="mx-auto max-w-5xl space-y-4 p-4">
              <div className="border-border bg-surface-raised/40 rounded-app border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label
                      className="text-fg-dim mb-1.5 block text-[10px] font-semibold tracking-[0.12em] uppercase"
                      htmlFor={`investigation-title-${scope}`}
                    >
                      {i18n.t('Investigation title')}
                    </label>
                    <Input
                      id={`investigation-title-${scope}`}
                      value={title}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) => patch({ title: event.target.value })}
                    />
                    <p className="text-fg-muted mt-2 text-[11px]">
                      {record.cluster_name} ·{' '}
                      <span className="font-mono">
                        {record.target.namespace}/{record.target.name}
                      </span>
                    </p>
                  </div>
                  <div className="flex gap-1.5 pt-5">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setComparing(true)}
                      leftIcon={<GitCompareArrows className="h-3.5 w-3.5" />}
                    >
                      {i18n.t('Compare snapshots')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={dirty || busy}
                      title={dirty ? i18n.t('Save edits before reviewing an export.') : undefined}
                      onClick={() => setExporting(true)}
                      leftIcon={<Download className="h-3.5 w-3.5" />}
                    >
                      {i18n.t('Review export')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setDeleting(true)}
                      aria-label={i18n.t('Delete investigation')}
                      leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    />
                  </div>
                </div>
                <div className="text-fg-dim mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                  <span>
                    {i18n.t('Captured {time}', {
                      time: new Date(record.captured_at).toLocaleString(),
                    })}
                  </span>
                  <span>
                    {i18n.t('Requested window: {minutes} minutes', {
                      minutes: record.lookback_minutes,
                    })}
                  </span>
                  <span>
                    {i18n.plural(
                      '{count} evidence section',
                      '{count} evidence sections',
                      record.evidence_count,
                    )}
                  </span>
                  {record.incomplete_count > 0 && (
                    <span className="text-status-starting">
                      {i18n.plural(
                        '{count} incomplete source',
                        '{count} incomplete sources',
                        record.incomplete_count,
                      )}
                    </span>
                  )}
                </div>
              </div>
              <div className="border-border rounded-app border p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label
                    className="text-fg-dim text-[10px] font-semibold tracking-[0.12em] uppercase"
                    htmlFor={`investigation-notes-${scope}`}
                  >
                    {i18n.t('Investigation notes')}
                  </label>
                  {dirty && (
                    <span className="text-status-starting text-[11px]">
                      {i18n.t('Unsaved edits')}
                    </span>
                  )}
                </div>
                <Textarea
                  id={`investigation-notes-${scope}`}
                  rows={4}
                  value={notes}
                  disabled={busy}
                  onChange={(event) => patch({ notes: event.target.value })}
                  placeholder={i18n.t(
                    'Record what you observed, what you ruled out, and what to try next…',
                  )}
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-fg-dim text-[11px]">
                    {i18n.t('Notes stay with this snapshot; evidence is never overwritten.')}
                  </p>
                  <div className="flex gap-2">
                    {dirty && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDiscarding(true)}
                        disabled={busy}
                      >
                        {i18n.t('Discard edits')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={
                        !dirty ||
                        !title.trim() ||
                        byteLength(title) > 200 ||
                        byteLength(notes) > 32 * 1024 ||
                        busy
                      }
                      onClick={() => void save()}
                      leftIcon={
                        busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )
                      }
                    >
                      {i18n.t('Save notes')}
                    </Button>
                  </div>
                </div>
                {(byteLength(title) > 200 || byteLength(notes) > 32 * 1024) && (
                  <p className="text-status-error mt-2 text-[11px]">
                    {i18n.t('Use at most 200 bytes for the title and 32 KiB for notes.')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-fg text-[12px] font-semibold">{i18n.t('Frozen evidence')}</h3>
                  <p className="text-fg-dim mt-1 max-w-2xl text-[11px] leading-relaxed">
                    {i18n.t(
                      'Snapshots show capture time. Logs and events use the requested window; metrics keep the available history or current sample. Capture samples up to 3 pods, 2 regular containers per pod, and 200 log lines per container instance.',
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={lookback}
                    onChange={setLookback}
                    options={[
                      { value: '15', label: i18n.t('Last 15 minutes') },
                      { value: '60', label: i18n.t('Last 60 minutes') },
                    ]}
                    ariaLabel={i18n.t('Capture time window')}
                    disabled={!canCapture || capturing || busy}
                  />
                  <Button
                    size="sm"
                    onClick={captureAgain}
                    disabled={!canCapture || capturing || busy}
                    title={
                      !canCapture
                        ? i18n.t('Connect the original cluster to capture a new snapshot.')
                        : i18n.t('Creates a separate investigation with fresh evidence.')
                    }
                    leftIcon={<Camera className="h-3.5 w-3.5" />}
                  >
                    {i18n.t('Capture again')}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {record.evidence.map((entry, index) => (
                  <EvidenceCard
                    key={`${record.id}-${entry.id}`}
                    evidence={entry}
                    initialOpen={index === 0}
                  />
                ))}
              </div>
              <p className="text-fg-dim flex items-start gap-2 text-[11px] leading-relaxed">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {i18n.t(
                  'Known credentials, annotations and literal environment values are masked before saving. Review logs and notes before sharing; an investigation is a bounded sample, not a complete cluster audit.',
                )}
              </p>
            </div>
          ) : (
            <div className="text-fg-dim flex min-h-64 flex-col items-center justify-center px-6 py-16 text-center">
              <Archive className="text-accent/70 mb-4 h-9 w-9" />
              <h3 className="text-fg text-[13px] font-semibold">
                {i18n.t('Keep the evidence after the incident')}
              </h3>
              <p className="mt-2 max-w-md text-[12px] leading-relaxed">
                {i18n.t(
                  'Open a pod or workload and choose Start investigation to capture its current state, logs, events, recent changes and available metrics. You can also open an exported bundle without a cluster connection.',
                )}
              </p>
            </div>
          )}
        </main>
      </div>
      {exporting && record && (
        <ExportInvestigationDialog record={record} onClose={() => setExporting(false)} />
      )}
      {comparing && record && (
        <InvestigationComparisonDialog
          key={record.id}
          record={record}
          records={records}
          onClose={() => setComparing(false)}
        />
      )}
      {deleting && record && (
        <ConfirmDialog
          title={i18n.t('Delete investigation')}
          message={i18n.t(
            'Delete {title} and its saved evidence from this device? Unsaved notes for this investigation will also be discarded.',
            { title: record.title },
          )}
          confirmLabel={i18n.t('Delete')}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(false)}
        />
      )}
      {discarding && record && (
        <ConfirmDialog
          title={i18n.t('Discard investigation edits')}
          message={i18n.t(
            'Discard unsaved title and note changes? The saved evidence will remain available.',
          )}
          confirmLabel={i18n.t('Discard edits')}
          onConfirm={() => {
            useInvestigationStore.getState().clearDraft(record.id);
            setDiscarding(false);
          }}
          onCancel={() => setDiscarding(false)}
        />
      )}
    </div>
  );
}

function EvidenceCard({
  evidence,
  initialOpen,
}: {
  evidence: InvestigationEvidence;
  initialOpen: boolean;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(initialOpen);
  const incomplete = evidence.status === 'unavailable' || evidence.status === 'truncated';
  return (
    <section className="border-border rounded-app overflow-hidden border">
      <button
        className="hover:bg-fg/5 flex w-full items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-fg shrink-0 text-[12px] font-medium">
          {evidenceKind(evidence.kind)}
        </span>
        <span
          className="text-fg-dim min-w-0 flex-1 truncate font-mono text-[11px]"
          title={evidenceLabel(evidence.label)}
        >
          {evidenceLabel(evidence.label)}
        </span>
        <span
          className={cn(
            'shrink-0 text-[10px]',
            incomplete ? 'text-status-starting' : 'text-fg-dim',
          )}
        >
          {evidenceStatus(evidence.status)}
        </span>
      </button>
      {open && (
        <div className="border-border border-t">
          {evidence.reason && (
            <p className="text-status-starting px-3 py-2 text-[11px]">
              {evidenceReason(evidence.reason)}
            </p>
          )}
          {evidence.content ? (
            <pre
              tabIndex={0}
              className="bg-surface-muted/25 text-fg-muted max-h-96 overflow-auto px-3 py-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
            >
              {evidence.content}
            </pre>
          ) : (
            <p className="text-fg-dim px-3 py-3 text-[12px]">
              {evidence.status === 'empty'
                ? i18n.t('No matching data was returned for this capture.')
                : i18n.t('No evidence was captured from this source.')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
