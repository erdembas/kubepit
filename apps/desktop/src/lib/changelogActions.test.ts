import { describe, expect, it } from 'vitest';
import { canOpenForCluster, isChangelogAction, needsCluster } from './changelogActions';

describe('changelog feature navigation', () => {
  it('accepts only known destinations without commands or cluster parameters', () => {
    for (const value of [
      'fleet-search',
      'investigations',
      'connection-doctor',
      'network-diagnostics',
      'image-matrix',
    ])
      expect(isChangelogAction(value)).toBe(true);
    for (const value of [
      'connect',
      'delete-pod',
      'connection-doctor?cluster=prod',
      'https://example.com',
      null,
      {},
    ])
      expect(isChangelogAction(value)).toBe(false);
  });
  it('keeps local views and pre-connection diagnosis available without a session', () => {
    expect(needsCluster('investigations')).toBe(false);
    expect(needsCluster('fleet-search')).toBe(false);
    expect(needsCluster('image-matrix')).toBe(false);
    expect(needsCluster('connection-doctor')).toBe(true);
    expect(canOpenForCluster('connection-doctor', false)).toBe(true);
    expect(canOpenForCluster('network-diagnostics', false)).toBe(false);
    expect(canOpenForCluster('network-diagnostics', true)).toBe(true);
  });
});
