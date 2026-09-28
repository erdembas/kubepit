/**
 * ANSI escape handling shared by the log parsers and the xterm log views.
 */

// eslint-disable-next-line no-control-regex
const ANSI_ALL_RE =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9]|[=>DEMHcp78])/g;

/** The text without any escape sequence (colours, cursor moves, OSC titles). */
export function stripAnsi(input: string): string {
  return input.includes('\x1b') ? input.replace(ANSI_ALL_RE, '') : input;
}

/** RFC 3339 prefix the API server adds with `timestamps=true` (group 1). */
export const K8S_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})) /;

/** `{ ts, body }`: the Kubernetes timestamp prefix (if any) and the rest. */
export function splitK8sTimestamp(text: string): { ts: string | null; body: string } {
  // Cheap guard: every prefix starts with a 4-digit year and a dash.
  if (text.length < 21 || text.charCodeAt(4) !== 45 /* - */) return { ts: null, body: text };
  const match = K8S_TIMESTAMP_RE.exec(text);
  return match ? { ts: match[1]!, body: text.slice(match[0].length) } : { ts: null, body: text };
}
