import { describe, expect, it } from 'vitest';
import { condenseLogs } from './logs';

/** `n` distinct INFO lines (words, not digits, differ, so they never collapse). */
function infoLines(n: number, from = 0): string[] {
  const word = (i: number) => Array.from(String(i), (d) => 'abcdefghij'[Number(d)]).join('');
  return Array.from({ length: n }, (_, i) => `INFO user ${word(from + i)} signed in`);
}

describe('condenseLogs', () => {
  it('keeps every error record with its stack frames and the tail', () => {
    const out = condenseLogs([
      ...infoLines(300),
      'ERROR boom',
      '\tat a.B.c(B.java:1)',
      'Caused by: x',
      ...infoLines(50, 300),
    ]);
    expect(out.text).toContain('ERROR boom');
    expect(out.text).toContain('\tat a.B.c(B.java:1)');
    expect(out.text).toContain('Caused by: x');
    expect(out.text).toContain('INFO user dej signed in'); // the last line (349)
    expect(out.text).not.toContain('INFO user a signed in'); // an old unique info line
    expect(out.text.split('\n').length).toBeLessThanOrEqual(200 + 2);
    expect(out.lines).toBe(out.text.split('\n').length);
  });

  it('collapses repeated messages with a count', () => {
    const out = condenseLogs(
      Array.from({ length: 50 }, (_, i) => `INFO GET /healthz 200 in ${i}ms`),
    );
    expect(out.text).toMatch(/\(×50\)/);
    expect(out.collapsed).toBe(49);
    // The most recent example is shown.
    expect(out.text).toContain('INFO GET /healthz 200 in 49ms');
  });

  it('normalizes hex ids and UUIDs before collapsing', () => {
    const out = condenseLogs([
      'WARN retry request 3f9a2c1b for 1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      'WARN retry request 77aa01ff for 6fa459ea-ee8a-3ca4-894e-db77e160355e',
    ]);
    expect(out.text).toMatch(/\(×2\) WARN retry request 77aa01ff/);
  });

  it('reports level counts in the header', () => {
    const out = condenseLogs(['ERROR a', 'WARN b']);
    expect(out.text.split('\n')[0]).toContain('error=1');
    expect(out.text.split('\n')[0]).toContain('warn=1');
    expect(out.levels.error).toBe(1);
  });

  it('caps stack frames, removes ANSI codes and the Kubernetes timestamp prefix', () => {
    const frames = Array.from(
      { length: 80 },
      (_, i) => `\tat app.Handler.step${i}(Handler.java:${i})`,
    );
    const out = condenseLogs([
      '2026-09-29T10:00:00.123456789Z \x1b[31mERROR\x1b[0m request failed',
      ...frames,
      ...infoLines(60),
    ]);
    expect(out.text).toContain('ERROR request failed');
    expect(out.text).not.toContain('\x1b[');
    expect(out.text).not.toContain('2026-09-29T10:00:00.123456789Z');
    expect(out.text).toContain('step29(');
    expect(out.text).not.toContain('step30(');
    expect(out.text).toMatch(/… 50 more lines/);
  });

  it('keeps at most 60 error records, the newest ones, and never exceeds maxLines', () => {
    const name = (i: number) =>
      String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
    const raw = Array.from({ length: 150 }, (_, i) => [
      `ERROR job ${name(i)} failed`,
      '\tat x.Y.z(Y.java:1)',
    ]).flat();
    const out = condenseLogs(raw, { tail: 0 });
    expect(out.text.split('\n').length).toBeLessThanOrEqual(200);
    expect(out.text).toContain('ERROR job tf failed'); // the newest error (149)
    expect(out.text).not.toContain('ERROR job aa failed'); // the oldest one
    const shown = out.text.split('\n').filter((l) => l.startsWith('ERROR')).length;
    expect(shown).toBeLessThanOrEqual(60);
  });

  it('handles empty input', () => {
    const out = condenseLogs([]);
    expect(out.text.split('\n')[0]).toContain('error=0');
    expect(out.collapsed).toBe(0);
  });
});
