import * as i18n from '@/i18n/core';
import type { WorkloadLogEvent } from '@/types';
import { formatLogLine, stripAnsi, truncateAnsi, type LogFormatOptions } from '../logs/format';
import { MAX_LOG_LINES, type LogEntry } from '../logs/logBuffer';

/**
 * Pure state behind the merged workload log view: the line buffer (each
 * entry remembers its source), the source registry that folds backend
 * events into legend rows, visibility filters and the `pod/container`
 * prefix formatting. No React, no I/O.
 */

/** Source id of marker lines the view writes itself (restart, gone, warning). */
export const SYSTEM_SOURCE = -1;

export interface MergedEntry extends LogEntry {
  source: number;
  /** Marker lines only. */
  tone?: 'info' | 'warn' | 'error';
}

export type SourceState = 'live' | 'ended' | 'failed' | 'removed' | 'skipped';

export interface LogSource {
  id: number;
  pod: string;
  container: string;
  state: SourceState;
  /** Lines received since the stream (re)started or the view was cleared. */
  lines: number;
  restarts: number;
  /** Why the stream failed (`failed`). */
  message: string | null;
}

/** Bounded line buffer; the head is trimmed in batches to stay near `max`. */
export class MergedLogBuffer {
  entries: MergedEntry[] = [];
  private nextSeq = 0;

  constructor(private readonly max = MAX_LOG_LINES) {}

  add(source: number, lines: string[], tone?: MergedEntry['tone']): MergedEntry[] {
    const added = lines.map((text) => ({ seq: this.nextSeq++, text, source, tone }));
    for (const entry of added) this.entries.push(entry);
    if (this.entries.length > this.max * 1.1) this.entries = this.entries.slice(-this.max);
    return added;
  }

  clear(): void {
    this.entries = [];
  }

  get length(): number {
    return this.entries.length;
  }

  bySeq(seq: number): MergedEntry | undefined {
    const first = this.entries[0];
    if (!first) return undefined;
    const entry = this.entries[seq - first.seq];
    return entry?.seq === seq ? entry : undefined;
  }
}

const sourceKey = (pod: string, container: string) => `${pod}\u0000${container}`;

/** A marker line to write for an event (restart, failure, pod gone, warning). */
export interface Marker {
  text: string;
  tone: NonNullable<MergedEntry['tone']>;
}

/**
 * Legend rows built from backend events. Ids are stable for the life of the
 * registry; `reset` (new stream) forgets sources but not pod colours, so a
 * pod keeps its colour when options change.
 */
export class SourceRegistry {
  private byKey = new Map<string, LogSource>();
  private byId = new Map<number, LogSource>();
  private nextId = 0;
  private colors = new Map<string, number>();
  /** Bumped on every change, for cheap React snapshots. */
  version = 0;

  reset(): void {
    this.byKey.clear();
    this.byId.clear();
    this.version++;
  }

  get(id: number): LogSource | undefined {
    return this.byId.get(id);
  }

  list(): LogSource[] {
    return [...this.byKey.values()].sort(
      (a, b) => a.pod.localeCompare(b.pod) || a.container.localeCompare(b.container),
    );
  }

  /** Colour slot of a pod, assigned in order of appearance. */
  colorIndex(pod: string): number {
    let index = this.colors.get(pod);
    if (index === undefined) {
      index = this.colors.size;
      this.colors.set(pod, index);
    }
    return index;
  }

  private ensure(pod: string, container: string): { source: LogSource; created: boolean } {
    const key = sourceKey(pod, container);
    const existing = this.byKey.get(key);
    if (existing) return { source: existing, created: false };
    const source: LogSource = {
      id: this.nextId++,
      pod,
      container,
      state: 'live',
      lines: 0,
      restarts: 0,
      message: null,
    };
    this.byKey.set(key, source);
    this.byId.set(source.id, source);
    this.colorIndex(pod);
    return { source, created: true };
  }

  /** Fold one event; returns the source it concerns and an optional marker. */
  apply(event: WorkloadLogEvent): { source: LogSource | null; marker: Marker | null } {
    const label = `${event.pod}/${event.container}`;
    switch (event.kind) {
      case 'warning':
        this.version++;
        return { source: null, marker: { text: event.message ?? '', tone: 'warn' } };
      case 'lines': {
        const { source } = this.ensure(event.pod, event.container);
        source.lines += event.lines.length;
        this.version++;
        return { source, marker: null };
      }
      case 'source-added': {
        const { source, created } = this.ensure(event.pod, event.container);
        const restarted = !created && source.state !== 'skipped';
        if (restarted) source.restarts++;
        source.state = 'live';
        source.message = null;
        this.version++;
        return {
          source,
          marker: restarted
            ? { text: i18n.t('{source} restarted', { source: label }), tone: 'info' }
            : null,
        };
      }
      case 'source-ended': {
        const { source } = this.ensure(event.pod, event.container);
        source.state = event.message ? 'failed' : 'ended';
        source.message = event.message;
        this.version++;
        return {
          source,
          marker: event.message ? { text: `${label}: ${event.message}`, tone: 'error' } : null,
        };
      }
      case 'source-removed': {
        const { source } = this.ensure(event.pod, event.container);
        source.state = 'removed';
        this.version++;
        const podGone = this.list().every((s) => s.pod !== event.pod || s.state === 'removed');
        return {
          source,
          marker: podGone
            ? { text: i18n.t('Pod {pod} is gone', { pod: event.pod }), tone: 'info' }
            : null,
        };
      }
      case 'source-skipped': {
        const { source } = this.ensure(event.pod, event.container);
        source.state = 'skipped';
        this.version++;
        return { source, marker: null };
      }
    }
  }

  /** Forget line counts (Clear). */
  resetCounts(): void {
    for (const source of this.byKey.values()) source.lines = 0;
    this.version++;
  }
}

/** Pods and containers the user hid in the legend. */
export interface SourceFilter {
  hiddenPods: ReadonlySet<string>;
  hiddenContainers: ReadonlySet<string>;
}

export function isVisible(
  entry: MergedEntry,
  registry: SourceRegistry,
  filter: SourceFilter,
): boolean {
  if (entry.source === SYSTEM_SOURCE) return true;
  const source = registry.get(entry.source);
  if (!source) return true;
  return !filter.hiddenPods.has(source.pod) && !filter.hiddenContainers.has(source.container);
}

/** Pods with at least one source that is not gone (tab title). */
export function livePodCount(sources: LogSource[]): number {
  return new Set(sources.filter((s) => s.state !== 'removed').map((s) => s.pod)).size;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export interface PodRow {
  pod: string;
  color: number;
  state: SourceState;
  lines: number;
  restarts: number;
  message: string | null;
}

export interface ContainerRow {
  container: string;
  lines: number;
}

/** Pods and containers of the merged view, aggregated from the sources. */
export function legendRows(
  sources: LogSource[],
  colorIndex: (pod: string) => number,
): { pods: PodRow[]; containers: ContainerRow[] } {
  const pods = new Map<string, LogSource[]>();
  const containers = new Map<string, number>();
  for (const s of sources) {
    pods.set(s.pod, [...(pods.get(s.pod) ?? []), s]);
    containers.set(s.container, (containers.get(s.container) ?? 0) + s.lines);
  }
  const podRows = [...pods.entries()].map(([pod, list]): PodRow => {
    const states = new Set(list.map((s) => s.state));
    const state: SourceState = states.has('live')
      ? 'live'
      : states.has('failed')
        ? 'failed'
        : states.size === 1
          ? list[0]!.state
          : 'ended';
    return {
      pod,
      color: colorIndex(pod),
      state,
      lines: list.reduce((n, s) => n + s.lines, 0),
      restarts: list.reduce((n, s) => n + s.restarts, 0),
      message: list.find((s) => s.message)?.message ?? null,
    };
  });
  return {
    pods: podRows,
    containers: [...containers.entries()]
      .map(([container, lines]) => ({ container, lines }))
      .sort((a, b) => a.container.localeCompare(b.container)),
  };
}

// ---------------------------------------------------------------------------
// Prefix formatting
// ---------------------------------------------------------------------------

/** Prefix column cap; longer labels are shortened in the middle. */
export const MAX_LABEL_WIDTH = 36;
/** Beyond this, the pod name prefix every pod shares (`web-7c9d8b6f5-`) is dropped. */
const STRIP_ABOVE = 28;

/** Prefix column: its width and how many leading pod-name characters to drop. */
export interface LabelLayout {
  width: number;
  strip: number;
}

export function labelLayout(sources: Iterable<LogSource>): LabelLayout {
  const list = [...sources];
  if (list.length === 0) return { width: 8, strip: 0 };
  const longest = Math.max(...list.map((s) => s.pod.length + 1 + s.container.length));
  let strip = 0;
  if (longest > STRIP_ABOVE) {
    const pods = [...new Set(list.map((s) => s.pod))];
    let prefix = pods[0]!;
    for (const pod of pods) while (!pod.startsWith(prefix)) prefix = prefix.slice(0, -1);
    // Cut after a '-' so the unique suffix (`x2kqp`, `0`) stays whole.
    const cut = prefix.lastIndexOf('-') + 1;
    if (cut >= 4 && pods.every((pod) => pod.length > cut)) strip = cut;
  }
  const widest = Math.max(...list.map((s) => s.pod.length - strip + 1 + s.container.length));
  return { width: Math.min(Math.max(widest, 8), MAX_LABEL_WIDTH), strip };
}

function middleEllipsis(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  // Keep the tail: generated pod names end in their unique hash.
  const tail = Math.min(Math.ceil((width - 1) / 2), 6);
  return `${text.slice(0, width - 1 - tail)}…${text.slice(text.length - tail)}`;
}

/** `pod/container` for the prefix column, shortened to `width` (pod first) and padded. */
export function sourceLabel(pod: string, container: string, layout: LabelLayout): string {
  const { width } = layout;
  const name = layout.strip > 0 && pod.length > layout.strip ? pod.slice(layout.strip) : pod;
  const full = `${name}/${container}`;
  if (full.length <= width) return full.padEnd(width);
  const podRoom = width - container.length - 1;
  const label =
    podRoom >= 8 ? `${middleEllipsis(name, podRoom)}/${container}` : middleEllipsis(full, width);
  return label.padEnd(width);
}

/** Categorical theme tokens used for pod colours (never red: that is for errors). */
export const POD_COLOR_TOKENS = [
  '--cat-frontend',
  '--cat-backend',
  '--cat-database',
  '--cat-tooling',
  '--cat-worker',
  '--cat-infra',
] as const;

/** `r;g;b` for xterm truecolour SGR, read from the current theme's tokens. */
export function readPodPalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  return POD_COLOR_TOKENS.map((token) => {
    const parts = style.getPropertyValue(token).trim().split(/\s+/).filter(Boolean);
    return parts.length === 3 ? parts.join(';') : '128;128;128';
  });
}

/** CSS colour of a pod slot (legend dots), theme-aware through the tokens. */
export function podCssColor(index: number): string {
  return `rgb(var(${POD_COLOR_TOKENS[index % POD_COLOR_TOKENS.length]}))`;
}

export interface MergedFormat {
  registry: SourceRegistry;
  palette: string[];
  layout: LabelLayout;
}

/** Bytes written to xterm for one merged entry: coloured prefix + formatted line. */
export function formatMergedEntry(
  entry: MergedEntry,
  fmt: MergedFormat,
  opts: LogFormatOptions,
): string {
  if (entry.source === SYSTEM_SOURCE) {
    const color = entry.tone === 'error' ? '31' : entry.tone === 'warn' ? '33' : '2';
    const line = `\x1b[${color}m── ${entry.text} ──\x1b[0m`;
    return `${!opts.wrap && opts.cols > 8 ? truncateAnsi(line, opts.cols) : line}\r\n`;
  }
  const source = fmt.registry.get(entry.source);
  if (!source) return formatLogLine(entry.text, opts);
  const rgb = fmt.palette[fmt.registry.colorIndex(source.pod) % fmt.palette.length];
  const prefix = `\x1b[38;2;${rgb}m${sourceLabel(source.pod, source.container, fmt.layout)}\x1b[39m `;
  // The body is truncated to what is left after the prefix column.
  const cols = opts.cols > 0 ? Math.max(8, opts.cols - fmt.layout.width - 1) : opts.cols;
  return prefix + formatLogLine(entry.text, { wrap: opts.wrap, cols });
}

/** Plain text export: `pod/container  line`, ANSI stripped. */
export function exportText(entries: MergedEntry[], registry: SourceRegistry): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.source === SYSTEM_SOURCE) continue;
    const source = registry.get(entry.source);
    const label = source ? `${source.pod}/${source.container}` : '?';
    lines.push(`${label} ${stripAnsi(entry.text)}`);
  }
  return lines.join('\n');
}
