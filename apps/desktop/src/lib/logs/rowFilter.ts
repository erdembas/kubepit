import type { LogRecord, RecordIndex } from './records';

/**
 * The visible rows of the structured view, kept incrementally: while the
 * predicate stays the same, only records added since the last update are
 * tested (streams append at ~10k lines/s without re-filtering 50k rows);
 * trimmed records fall off the front. A new predicate key recomputes.
 */
export class RowFilter {
  rows: LogRecord[] = [];
  private key: string | null = null;
  /** Highest record id tested so far. */
  private lastId = -1;
  private index: RecordIndex | null = null;

  /**
   * Bring `rows` up to date. `maxId` hides records newer than a pause
   * point. Returns true when `rows` changed.
   */
  update(
    index: RecordIndex,
    key: string,
    test: (record: LogRecord) => boolean,
    maxId = Infinity,
  ): boolean {
    const records = index.records;
    if (key !== this.key || index !== this.index) {
      this.key = key;
      this.index = index;
      this.rows = [];
      this.lastId = -1;
    }
    let changed = false;
    // Trimmed or cleared records leave the front (or everything).
    const first = records[0];
    if (!first) {
      if (this.rows.length) {
        this.rows = [];
        changed = true;
      }
      this.lastId = -1;
      return changed;
    }
    if (this.rows.length && this.rows[0]!.id < first.id) {
      let cut = 0;
      while (cut < this.rows.length && this.rows[cut]!.id < first.id) cut++;
      this.rows = this.rows.slice(cut);
      changed = true;
    }
    if (this.lastId > records[records.length - 1]!.id) {
      // The index was cleared and refilled: start over.
      this.rows = [];
      this.lastId = -1;
      changed = true;
    }
    // New records: binary search for the first id past `lastId`.
    let lo = 0;
    let hi = records.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (records[mid]!.id <= this.lastId) lo = mid + 1;
      else hi = mid;
    }
    const added: LogRecord[] = [];
    for (let i = lo; i < records.length; i++) {
      const record = records[i]!;
      if (record.id > maxId) break;
      this.lastId = record.id;
      if (test(record)) added.push(record);
    }
    if (added.length) {
      // No spread: JavaScriptCore caps argument counts around 65k.
      const next = this.rows.slice();
      for (const record of added) next.push(record);
      this.rows = next;
      changed = true;
    }
    return changed;
  }

  reset(): void {
    this.rows = [];
    this.key = null;
    this.lastId = -1;
    this.index = null;
  }
}
