/** Live, local editor text; never persisted or sent to providers by this registry. */
const drafts = new Map<string, string>();
export function setEditorDraft(tabId: string, text: string): void {
  drafts.set(tabId, text);
}
export function getEditorDraft(tabId: string): string | undefined {
  return drafts.get(tabId);
}
export function clearEditorDraft(tabId: string): void {
  drafts.delete(tabId);
}

export type EditorReplacementResult = 'replaced' | 'closed' | 'changed' | 'cancelled';
/** Validation may wait for a schema. Consent covers the latest draft after that wait. */
export async function reviewEditorReplacement(ports: {
  validate: () => Promise<void>;
  read: () => { text: string; dirty: boolean } | null;
  confirm: () => Promise<boolean>;
  replace: () => void;
}): Promise<EditorReplacementResult> {
  await ports.validate();
  const reviewed = ports.read();
  if (!reviewed) return 'closed';
  if (reviewed.dirty && !(await ports.confirm())) return 'cancelled';
  const latest = ports.read();
  if (!latest) return 'closed';
  if (latest.text !== reviewed.text) return 'changed';
  // No asynchronous boundary between the final check and replacement.
  ports.replace();
  return 'replaced';
}
