import * as i18n from '@/i18n/core';

/** The OS credential store that keychain mode keeps imported kubeconfigs in. */
export function credentialStoreName(platform: string | null | undefined): string {
  return platform === 'macos'
    ? i18n.t('macOS Keychain')
    : platform === 'windows'
      ? i18n.t('Windows Credential Manager')
      : i18n.t('Secret Service (GNOME Keyring, KWallet)');
}
