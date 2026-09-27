import type { IMarker, Terminal } from '@xterm/xterm';

// Ported from RunHQ `log-xterm/markers.ts` + `pointer.ts`: every written
// entry gets an xterm marker so a pointer row maps back to the source line —
// even after wrapping, truncation or scrollback trimming.

export interface LineMarker {
  marker: IMarker | undefined;
  seq: number;
}

export function appendLineWithMarker(
  term: Terminal,
  seq: number,
  bytes: string,
  markers: LineMarker[],
): void {
  // xterm parses writes asynchronously. Register at the cursor position after
  // preceding writes, otherwise a replay gives every entry the same marker.
  term.write('', () => {
    markers.push({ marker: term.registerMarker(0), seq });
  });
  term.write(bytes);
}

export function disposeMarkers(markers: LineMarker[]): void {
  for (const { marker } of markers) if (marker && !marker.isDisposed) marker.dispose();
  markers.length = 0;
}

/** Drop markers xterm already disposed with trimmed scrollback. */
export function pruneMarkers(markers: LineMarker[]): void {
  let idx = 0;
  while (idx < markers.length && (markers[idx]!.marker?.isDisposed ?? true)) idx++;
  if (idx > 0) markers.splice(0, idx);
}

/** Source line under a viewport pixel row, or null outside the text. */
export function seqAtPointer(
  term: Terminal,
  markers: LineMarker[],
  screen: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const rect = screen.getBoundingClientRect();
  const inside =
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  if (!inside || rect.height <= 0 || term.buffer.active.type === 'alternate') return null;
  const localRow = Math.floor((clientY - rect.top) / (rect.height / Math.max(1, term.rows)));
  if (localRow < 0 || localRow >= term.rows) return null;
  const absY = term.buffer.active.viewportY + localRow;
  for (let i = markers.length - 1; i >= 0; i--) {
    const { marker, seq } = markers[i]!;
    if (!marker || marker.isDisposed) continue;
    if (marker.line <= absY) return seq;
  }
  return null;
}
