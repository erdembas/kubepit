import { describe, expect, it } from 'vitest';
import { cleanupMessage } from './model';

// Codes are fixed strings from the Rust backend and the demo backend; each
// maps to its own user-facing sentence, unknown values pass through.

describe('cleanupMessage', () => {
  const codes = [
    'namespace-cleanup:system-namespace',
    'namespace-cleanup:not-found',
    'namespace-cleanup:invalid-namespace',
    'namespace-cleanup:confirm-mismatch',
    'namespace-cleanup:terminating',
    'namespace-cleanup:inventory-partial',
    'namespace-cleanup:partial',
    'namespace-cleanup:disconnected',
    'read-only',
  ];

  it('maps every fixed code to its own sentence', () => {
    const messages = codes.map((code) => cleanupMessage(code));
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });

  it('recognizes the read-only error prose of both backends', () => {
    expect(cleanupMessage('Cluster "prod" is read-only: purge a namespace is not allowed')).toBe(
      cleanupMessage('read-only'),
    );
    expect(
      cleanupMessage('Cluster "prod" is read-only in Kubepit; mutating commands are blocked.'),
    ).toBe(cleanupMessage('read-only'));
  });

  it('keeps the code after a longer error chain (anyhow prefixes)', () => {
    expect(cleanupMessage('failed to read the namespace: namespace-cleanup:not-found')).toBe(
      cleanupMessage('namespace-cleanup:not-found'),
    );
  });

  it('passes unknown errors and Error objects through', () => {
    expect(cleanupMessage('boom')).toBe('boom');
    expect(cleanupMessage(new Error('pods "web" forbidden'))).toBe('pods "web" forbidden');
  });
});
