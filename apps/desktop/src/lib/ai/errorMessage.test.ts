import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { assistantErrorMessage } from './errorMessage';

afterEach(() => i18n.setLocale('en', false));
describe('assistant error presentation', () => {
  it('distinguishes OpenCode permission verification from a missing restricted configuration without guessing an outdated CLI', () => {
    const permissions = 'this OpenCode version did not enforce the no-tools permission policy';
    const missingAgent = 'OpenCode did not expose the isolated assistant agent';
    i18n.setLocale('en', false);
    expect(assistantErrorMessage(permissions)).toBe(
      'OpenCode’s restricted permissions could not be verified. The request was stopped before your message was sent.',
    );
    expect(assistantErrorMessage(missingAgent)).toBe(
      'OpenCode did not load the Assistant’s restricted configuration. The request was stopped before your message was sent.',
    );
    i18n.setLocale('tr', false);
    expect(assistantErrorMessage(permissions)).toBe(
      'OpenCode’un kısıtlı izinleri doğrulanamadı. İstek, mesajınız gönderilmeden durduruldu.',
    );
    expect(assistantErrorMessage(missingAgent)).toBe(
      'OpenCode, Asistanın kısıtlı yapılandırmasını yüklemedi. İstek, mesajınız gönderilmeden durduruldu.',
    );
  });
  it('translates local agent discovery, login and network policy errors', () => {
    i18n.setLocale('tr', false);
    for (const message of [
      'local assistant agents may use cloud services; remote providers must be allowed and local-only mode must be off',
      'local assistant agent is not installed or is not executable; install it and refresh discovery',
      'local assistant agents use their own sign-in; no API key is stored in Kubepit',
      'this local agent cannot disable its host tools and integrations; choose another assistant provider',
      'the local agent timed out',
      'could not start the local agent; check its installation and sign-in',
      'the local agent exited unsuccessfully; check its CLI sign-in, model access and version',
      'the local agent sent invalid JSON',
      'Claude attempted a tool call',
      'Claude did not disable its tools and MCP servers; update the CLI',
      'the selected model is not in the local agent catalog; refresh the model list',
      'the selected reasoning effort is not supported by this local agent model',
      'the selected service tier is not supported by this local agent model',
      'fast mode is not available for this local agent model',
      'Claude did not return its native model catalog',
      'Claude returned an oversized model catalog',
      'Codex did not return its native model catalog',
      'Codex returned an oversized model catalog',
      'Codex returned an invalid model catalog cursor',
      'OpenCode model discovery timed out',
      'OpenCode does not advertise separate service-tier or fast-mode controls; select one of its model variants instead',
      'choose an explicit OpenCode model before selecting a variant',
      'the selected OpenCode model is not in its connected model catalog; refresh models or choose the agent default',
      'the selected variant is not offered by this OpenCode model; refresh models and choose an available variant',
      'OpenCode returned no provider catalog',
      'OpenCode returned no provider connection metadata',
      'OpenCode returned too many connected models',
      'OpenCode provider configuration is invalid',
      'the local agent model configuration could not be read; check its settings file',
      'OpenCode provider configuration is too large',
      'could not read OpenCode provider configuration or its referenced credential file',
      'OpenCode provider SDK is not bundled; external provider packages cannot run with Assistant permissions',
      'OpenCode provider options require unsupported host access; use API-key or OAuth provider settings',
      'local assistant agent options must be at most 128 bytes and contain no control characters',
    ])
      expect(assistantErrorMessage(message)).not.toBe(message);
  });
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
