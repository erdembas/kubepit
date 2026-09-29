/**
 * Redaction placeholders in assistant answers (spec D8, D10). `__IP_n__`
 * and `__HOST_n__` are session pseudonyms the backend can map back
 * (`AiPreview.placeholders`, `done.placeholders`), restored locally before a
 * suggestion is used. `__SECRET__` and `__TOKEN__` replaced values that
 * never left the machine and can never be restored: a suggestion carrying
 * one must not reach the apply review or the clipboard.
 */

const RESTORABLE_RE = /__(?:IP|HOST)_\d+__/g;
const UNRESTORABLE_RE = /__(?:SECRET|TOKEN)__/g;

const unique = (values: Iterable<string>) => [...new Set(values)];

/** The IP and host placeholders of `text`, each once, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return unique(text.match(RESTORABLE_RE) ?? []);
}

/** Replaces known IP / host placeholders; `missing` lists the unknown ones once each. */
export function restorePlaceholders(
  text: string,
  map: Readonly<Record<string, string>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const restored = text.replace(RESTORABLE_RE, (marker) => {
    const value = Object.prototype.hasOwnProperty.call(map, marker) ? map[marker] : undefined;
    if (value !== undefined) return value;
    if (!missing.includes(marker)) missing.push(marker);
    return marker;
  });
  return { text: restored, missing };
}

/** `__SECRET__` / `__TOKEN__` markers in `text`, each once. */
export function unrestorableMarkers(text: string): string[] {
  return unique(text.match(UNRESTORABLE_RE) ?? []);
}
