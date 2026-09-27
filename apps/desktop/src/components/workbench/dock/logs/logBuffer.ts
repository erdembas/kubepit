import { stripAnsi } from './format';

export interface LogEntry {
  /** Monotonic per buffer; survives head trimming, so it doubles as an address. */
  seq: number;
  /** Raw line without the trailing newline (may contain ANSI). */
  text: string;
}

/** Memory bound shared by the buffer and the xterm scrollback. */
export const MAX_LOG_LINES = 50_000;

/**
 * Line buffer behind a logs tab. Chunks from the stream can split lines
 * anywhere, so an incomplete tail is carried until its newline arrives (or
 * the stream ends). The head is trimmed in batches to stay near `max`.
 */
export class LogBuffer {
  entries: LogEntry[] = [];
  private carry = '';
  private nextSeq = 0;

  constructor(private readonly max = MAX_LOG_LINES) {}

  push(data: string): LogEntry[] {
    const parts = (this.carry + data).split('\n');
    this.carry = parts.pop() ?? '';
    return this.add(parts);
  }

  /** Emit the carried partial line (stream finished without a final newline). */
  flush(): LogEntry[] {
    if (!this.carry) return [];
    const rest = this.carry;
    this.carry = '';
    return this.add([rest]);
  }

  clear(): void {
    this.entries = [];
    this.carry = '';
  }

  get length(): number {
    return this.entries.length;
  }

  bySeq(seq: number): LogEntry | undefined {
    const first = this.entries[0];
    if (!first) return undefined;
    const entry = this.entries[seq - first.seq];
    return entry?.seq === seq ? entry : undefined;
  }

  /** Plain text of every retained line (ANSI stripped) for copy / download. */
  text(): string {
    return this.entries.map((entry) => stripAnsi(entry.text)).join('\n');
  }

  private add(lines: string[]): LogEntry[] {
    const added = lines.map((line) => ({
      seq: this.nextSeq++,
      text: line.endsWith('\r') ? line.slice(0, -1) : line,
    }));
    if (added.length === 0) return added;
    // No spread: JavaScriptCore caps argument counts around 65k.
    for (const entry of added) this.entries.push(entry);
    if (this.entries.length > this.max * 1.1) this.entries = this.entries.slice(-this.max);
    return added;
  }
}
