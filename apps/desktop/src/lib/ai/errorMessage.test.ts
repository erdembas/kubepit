import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { assistantErrorMessage } from './errorMessage';

afterEach(() => i18n.setLocale('en', false));
describe('assistant error presentation', () => {
  it('translates existing raw core errors lazily when the locale changes', () => {
    const raw = 'assistant preview expired';
    i18n.setLocale('en', false);
    expect(assistantErrorMessage(raw)).toBe(
      'This context preview expired. Review the request again before sending.',
    );
    i18n.setLocale('tr', false);
    expect(assistantErrorMessage(raw)).toBe(
      'Bu bağlam önizlemesinin süresi doldu. Göndermeden önce isteği yeniden gözden geçirin.',
    );
    expect(raw).toBe('assistant preview expired');
  });
  it('preserves provider, server and unknown technical diagnostics verbatim', () => {
    const technical = 'HTTP 429 overloaded_error: "assistant preview expired"\nrequest_id=req_123';
    for (const locale of ['en', 'tr'] as const) {
      i18n.setLocale(locale, false);
      expect(assistantErrorMessage(technical)).toBe(technical);
      expect(assistantErrorMessage('Connection reset by peer (os error 54)')).toBe(
        'Connection reset by peer (os error 54)',
      );
    }
  });
  it('preserves supplied names, addresses and keychain diagnostics inside translated explanations', () => {
    i18n.setLocale('tr', false);
    expect(
      assistantErrorMessage(
        'The key was saved for https://my-provider.example:8443; set it again for this address.',
      ),
    ).toContain('https://my-provider.example:8443');
    const error = assistantErrorMessage(
      'could not store the My Private Model API key in the macOS Keychain: OSStatus -25293',
    );
    expect(error).toContain('My Private Model');
    expect(error).toContain('macOS Keychain');
    expect(error).toContain('OSStatus -25293');
    expect(error).not.toContain('could not store');
  });
});
