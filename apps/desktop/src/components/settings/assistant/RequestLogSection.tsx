import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyableCodeBlock } from '@/components/ui/CopyableCodeBlock';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { pickSavePath } from '@/components/workbench/dock/shared/saveFile';
import { downloadText } from '@/components/workbench/dock/shared/platform';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type {
  AiLogDetail,
  AiLogEntry,
  AiLogFilter,
  AiLogPage,
  AiUsage,
  HistoryStatus,
} from '@/types';
import { SettingsSection } from '../SettingsView';
import { errorText } from './Fields';

const money = (value: number) =>
  i18n.number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
function usageText(usage: AiUsage) {
  return i18n.t('{input} in · {output} out · {cached} cached', {
    input: i18n.number(usage.input_tokens),
    output: i18n.number(usage.output_tokens),
    cached: i18n.number(usage.cache_read_tokens + usage.cache_write_tokens),
  });
}

export function RequestLogSection() {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const logging = useAppStore((s) => s.settings?.ai.log_requests);
  const [cluster, setCluster] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<AiLogPage | null>(null);
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const filter = useCallback(
    (cursor: string | null = null): AiLogFilter => ({
      cluster_ids: cluster ? [cluster] : [],
      text: query || null,
      since: null,
      cursor,
      limit: 50,
    }),
    [cluster, query],
  );
  const load = useCallback(
    async (cursor: string | null = null) => {
      const id = ++generation.current;
      setBusy(true);
      setError(null);
      if (cursor === null) setPage(null);
      try {
        const next = await ipc.aiLogList(filter(cursor));
        if (id !== generation.current) return;
        setPage((previous) =>
          cursor && previous ? { ...next, entries: [...previous.entries, ...next.entries] } : next,
        );
      } catch (e) {
        if (id === generation.current) setError(errorText(e));
      } finally {
        if (id === generation.current) setBusy(false);
      }
    },
    [filter],
  );
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load, revision]);
  useEffect(() => {
    let alive = true;
    void ipc.historyStatus().then(
      (s) => {
        if (alive) setHistory(s);
      },
      (e) => {
        if (alive) setError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [revision, logging]);
  const refresh = () => setRevision((value) => value + 1);
  const clear = () =>
    useAppStore.getState().requestConfirm({
      title: i18n.t('Clear assistant request log?'),
      message: i18n.t('All assistant requests and responses will be deleted from this computer.'),
      confirmLabel: i18n.t('Clear'),
      tone: 'danger',
      onConfirm: async () => {
        await ipc.historyClear('ai', null);
        refresh();
      },
    });
  const exportLog = async () => {
    setExporting(true);
    try {
      const content = await ipc.aiLogExport({ ...filter(), limit: 100000 });
      const name = `kubepit-assistant-${new Date().toISOString().slice(0, 10)}.jsonl`;
      if (!isTauri) {
        downloadText(name, content);
        return;
      }
      const path = await pickSavePath(name, {
        name: i18n.t('JSON lines'),
        extensions: ['jsonl', 'json'],
      });
      if (!path) return;
      await ipc.saveTextFile(path, content);
      useAppStore.getState().pushToast('success', i18n.t('Saved {path}', { path }));
    } catch (e) {
      useAppStore.getState().pushToast('error', assistantErrorMessage(errorText(e)));
    } finally {
      setExporting(false);
    }
  };
  return (
    <SettingsSection
      title={i18n.t('Assistant request log')}
      trailing={
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" disabled={busy} onClick={refresh}>
            {i18n.t('Refresh')}
          </Button>
          <Button size="xs" variant="ghost" disabled={exporting} onClick={() => void exportLog()}>
            {i18n.t('Export')}
          </Button>
          <Button size="xs" variant="ghost" onClick={clear}>
            {i18n.t('Clear')}
          </Button>
        </div>
      }
    >
      {!logging && (
        <p className="text-fg-dim mb-2 text-[11px]">
          {i18n.t('Request logging is off. Existing requests remain available.')}
        </p>
      )}
      {history && (!history.available || !history.recording) && (
        <p className="text-status-starting mb-2 text-[11px]">
          {i18n.t('History recording is unavailable in this app session.')}
          {history.error && <span className="mt-1 block">{history.error}</span>}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          value={cluster}
          onChange={setCluster}
          ariaLabel={i18n.t('Filter requests by cluster')}
          options={[
            { value: '', label: i18n.t('All clusters') },
            ...clusters.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <Input
          className="min-w-0 flex-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={i18n.t('Filter assistant requests…')}
          aria-label={i18n.t('Filter assistant requests…')}
        />
      </div>
      {page && (
        <div className="text-fg-dim mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span>{i18n.plural('{count} request', '{count} requests', page.total)}</span>
          <span>{usageText(page.usage)}</span>
          {page.cost !== null && <span>{i18n.t('Cost: {cost}', { cost: money(page.cost) })}</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-status-error mb-2 text-[11px]">
          {assistantErrorMessage(error)}
        </p>
      )}
      {busy && !page && <p className="text-fg-dim text-[12px]">{i18n.t('Loading requests…')}</p>}
      {page?.entries.length === 0 && (
        <p className="text-fg-dim text-[12px]">
          {i18n.t('No assistant requests match these filters.')}
        </p>
      )}
      <div className="divide-border/60 divide-y">
        {page?.entries.map((entry) => (
          <LogEntry key={`${revision}:${entry.id}`} entry={entry} />
        ))}
      </div>
      {page?.next_cursor && (
        <Button
          size="xs"
          variant="secondary"
          disabled={busy}
          onClick={() => void load(page.next_cursor)}
        >
          {i18n.t('Load more')}
        </Button>
      )}
    </SettingsSection>
  );
}

function LogEntry({ entry }: { entry: AiLogEntry }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AiLogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || detail) return;
    let alive = true;
    setError(null);
    void ipc.aiLogGet(entry.id).then(
      (value) => {
        if (alive) setDetail(value);
      },
      (e) => {
        if (alive) setError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [open, entry.id, detail, attempt]);
  const outcomes = {
    ok: i18n.t('Completed'),
    error: i18n.t('Failed'),
    cancelled: i18n.t('Cancelled'),
    refused: i18n.t('Refused'),
  };
  return (
    <div className="py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="hover:bg-fg/5 flex w-full min-w-0 flex-col gap-1 rounded px-2 py-1 text-left"
      >
        <span className="text-fg flex w-full flex-wrap items-baseline gap-x-3 text-[12px]">
          <span className="min-w-0 truncate">{entry.model}</span>
          <span className="text-fg-dim text-[11px]">{entry.cluster_name ?? '—'}</span>
          <span className="text-fg-dim ml-auto text-[11px]">
            {i18n.date(entry.ts, { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        </span>
        <span className="text-fg-dim flex flex-wrap gap-x-3 text-[10.5px]">
          <span>{outcomes[entry.outcome]}</span>
          <span>{usageText(entry.usage)}</span>
          {entry.cost !== null && <span>{money(entry.cost)}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-2 px-2">
          {entry.error && (
            <p className="text-status-error mb-2 text-[11px]">
              {assistantErrorMessage(entry.error)}
            </p>
          )}
          {error && (
            <p role="alert" className="text-status-error text-[11px]">
              {assistantErrorMessage(error)}
              <Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                {i18n.t('Retry')}
              </Button>
            </p>
          )}
          {!detail && !error && (
            <p className="text-fg-dim text-[11px]">{i18n.t('Loading request…')}</p>
          )}
          {detail && (
            <>
              <Payload label={i18n.t('Request')} value={detail.request} />
              <Payload label={i18n.t('Response')} value={detail.response} />
              <Payload label={i18n.t('Tools')} value={JSON.stringify(detail.tools, null, 2)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Payload({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3">
      <h4 className="text-fg-dim mb-1 text-[10px] font-medium tracking-wide uppercase">{label}</h4>
      <CopyableCodeBlock
        raw={value}
        preClassName="max-h-64 whitespace-pre-wrap break-words text-[11px]"
      >
        <code>{value}</code>
      </CopyableCodeBlock>
    </div>
  );
}
