import * as i18n from '@/i18n/core';

/**
 * Localize only errors owned by the assistant core. Keep stored errors raw and
 * call this while rendering, so an existing error follows a locale change.
 * Unknown provider/server messages and technical diagnostics remain verbatim.
 * Exact strings and anchored templates deliberately avoid rewriting model text.
 */
const addressLabel = (address: string) =>
  address === 'this address' ? i18n.t('this address') : address;

export function assistantErrorMessage(message: string): string {
  switch (message) {
    case 'assistant is not enabled':
      return i18n.t('The assistant is turned off. Enable it in Assistant settings.');
    case 'assistant provider changed; preview the request again':
    case 'assistant settings changed; preview the request again':
      return i18n.t('Assistant settings changed. Review the request again before sending.');
    case 'choose an assistant model first':
      return i18n.t('Choose a model in Assistant settings.');
    case 'assistant is not enabled for this cluster':
      return i18n.t('Enable the assistant for this cluster before sending context.');
    case 'a namespace or object requires a cluster':
      return i18n.t('Select a cluster before asking about a namespace or object.');
    case 'an API key is required for this assistant provider':
      return i18n.t('Set an API key for this provider in Assistant settings.');
    case 'unknown assistant provider':
    case 'choose an assistant provider first':
    case 'no assistant provider given':
      return i18n.t('Choose a model provider in Assistant settings.');
    case 'assistant context is too large':
      return i18n.t(
        'This request contains too much context. Remove some sections or shorten the message.',
      );
    case 'assistant section identifiers must be unique and at most 2048 bytes':
      return i18n.t('The context sections have invalid identifiers. Gather the context again.');
    case 'assistant session expired; start a new conversation':
    case 'assistant session expired':
      return i18n.t('This assistant conversation expired. Start a new chat.');
    case 'an assistant run is already active in this session':
      return i18n.t(
        'This conversation already has a running request. Wait for it to finish or stop it.',
      );
    case 'assistant session settings or scope changed; start a new conversation':
      return i18n.t('The conversation settings or scope changed. Start a new chat.');
    case 'too many active assistant sessions':
      return i18n.t(
        'Too many assistant conversations are active. Close a conversation and try again.',
      );
    case 'assistant conversation exceeds the context budget; start a new conversation or shorten the message':
    case 'assistant conversation exceeds the context budget':
      return i18n.t(
        'This conversation exceeds the context budget. Start a new chat or shorten the message.',
      );
    case 'assistant request exceeds the context budget':
      return i18n.t(
        'This request exceeds the context budget. Remove some sections or shorten the message.',
      );
    case 'assistant preview expired':
      return i18n.t('This context preview expired. Review the request again before sending.');
    case 'assistant preview is stale; preview the request again':
      return i18n.t(
        'This context preview is out of date. Review the request again before sending.',
      );
    case 'assistant tool decision is no longer pending':
      return i18n.t('This tool result is no longer waiting for approval.');
    case 'assistant run ended':
      return i18n.t('This assistant request has ended.');
    case 'provider returned empty or duplicate tool calls':
      return i18n.t('The provider returned invalid tool calls. Try the request again.');
    case 'the API key is empty':
      return i18n.t('Enter an API key.');
    case 'the API key is longer than 8 KiB':
      return i18n.t('The API key is too long. Enter a key no longer than 8 KiB.');
    case 'the API key must not contain spaces or line breaks':
    case 'the API key contains characters that cannot be sent in a header':
      return i18n.t('The API key must not contain spaces, line breaks or control characters.');
    case 'The stored key is not bound to an address (saved by an older version or another app); set it again.':
      return i18n.t('The stored key has no provider address. Set it again for this provider.');
  }

  let match: RegExpExecArray | null;
  if ((match = /^there is no assistant provider (.+)$/.exec(message)))
    return i18n.t('Assistant provider {provider} is no longer configured.', {
      provider: match[1]!,
    });
  if ((match = /^cluster (.+) is not registered$/.exec(message)))
    return i18n.t('Cluster {cluster} is no longer registered.', { cluster: match[1]! });
  if ((match = /^(.+) is a production cluster: confirm to enable the assistant$/.exec(message)))
    return i18n.t('Confirm the production cluster {cluster} before enabling the assistant.', {
      cluster: match[1]!,
    });
  if ((match = /^The key was saved for (.+); set it again for this address\.$/.exec(message)))
    return i18n.t('The key was saved for {address}. Set it again for the current address.', {
      address: addressLabel(match[1]!),
    });
  if (
    (match =
      /^The key was saved for a provider of type (.+); set it again for this provider\.$/.exec(
        message,
      ))
  )
    return i18n.t('The key was saved for provider type {type}. Set it again for this provider.', {
      type: match[1]!,
    });
  if ((match = /^(.+) has no valid base URL: set one before its API key$/.exec(message)))
    return i18n.t('Set a valid base URL for {provider} before storing its API key.', {
      provider: match[1]!,
    });
  if (
    (match =
      /^(.+) uses plain http:\/\/ to another computer \((.+)\): API keys are only sent over https:\/\/ or to this computer$/.exec(
        message,
      ))
  )
    return i18n.t(
      '{provider} uses an insecure remote address ({address}). API keys require HTTPS or a local address.',
      { provider: match[1]!, address: match[2]! },
    );
  if (
    (match = /^local-only mode is on: (.+) is not a loopback address, so nothing was sent$/.exec(
      message,
    ))
  )
    return i18n.t('Local-only mode blocked {address}. Nothing was sent.', {
      address: addressLabel(match[1]!),
    });
  if (
    (match =
      /^remote model providers are not allowed in this process: (.+) is not a loopback address, so nothing was sent$/.exec(
        message,
      ))
  )
    return i18n.t(
      'This app session cannot reach the remote provider {address}. Nothing was sent.',
      { address: addressLabel(match[1]!) },
    );
  if (
    (match =
      /^an API key is only sent over HTTPS or to a loopback address: (.+) uses plain http, so nothing was sent$/.exec(
        message,
      ))
  )
    return i18n.t(
      'The API key cannot be sent to the insecure address {address}. Use HTTPS or a local address.',
      { address: addressLabel(match[1]!) },
    );
  if ((match = /^could not store the (.+) API key in the (.+): ([\s\S]+)$/.exec(message)))
    return i18n.t('Could not store the API key for {provider} in {keychain}: {error}', {
      provider: match[1]!,
      keychain: match[2]!,
      error: match[3]!,
    });
  if ((match = /^could not remove the API key from the (.+): ([\s\S]+)$/.exec(message)))
    return i18n.t('Could not remove the API key from {keychain}: {error}', {
      keychain: match[1]!,
      error: match[2]!,
    });
  return message;
}
