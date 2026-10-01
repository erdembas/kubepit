import actionIds from '../../../../shared/changelog/action-ids.json';

/** Data only: release prose cannot invent commands, arguments, or automatic probes. */
export type ChangelogAction =
  'fleet-search' | 'investigations' | 'connection-doctor' | 'network-diagnostics' | 'image-matrix';

export function isChangelogAction(value: unknown): value is ChangelogAction {
  return typeof value === 'string' && actionIds.includes(value);
}

export function needsCluster(action: ChangelogAction): boolean {
  return action === 'connection-doctor' || action === 'network-diagnostics';
}

export function canOpenForCluster(action: ChangelogAction, connected: boolean): boolean {
  // The doctor explicitly works before connecting. Network sources require an existing session.
  return action !== 'network-diagnostics' || connected;
}
