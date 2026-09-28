import type { SelectOption } from '@/components/ui/Select';
import type { ClusterId } from '@/types';
import { manifestWizards, openWizardEntry, wizardById } from './catalog';
import type { WizardResultHandler } from './wizardStore';

/** Wizard entries of the create editor's template picker (`wizard:<id>` values). */

const PREFIX = 'wizard:';

export function editorWizardOptions(): SelectOption[] {
  return manifestWizards().map((w) => ({
    value: `${PREFIX}${w.id}`,
    label: w.label(),
    description: w.command,
  }));
}

/** Opens the wizard behind a picker value; false when `value` is a plain template. */
export function openEditorWizard(
  value: string,
  clusterId: ClusterId,
  namespace: string,
  onYaml: WizardResultHandler,
): boolean {
  if (!value.startsWith(PREFIX)) return false;
  const entry = wizardById(value.slice(PREFIX.length));
  if (entry) openWizardEntry(entry, clusterId, namespace, onYaml);
  return true;
}
