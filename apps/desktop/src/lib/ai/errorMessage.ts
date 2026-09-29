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
    case 'the local agent model configuration could not be read; check its settings file':
      return i18n.t(
        'Could not read the agent’s model configuration. Check its settings file and permissions, then refresh the models.',
      );
    case 'OpenCode provider configuration is invalid':
      return i18n.t(
        'OpenCode provider configuration is invalid. Check its configuration file, then refresh the models.',
      );
    case 'OpenCode provider configuration is too large':
      return i18n.t(
        'OpenCode provider configuration exceeds the size limit. Reduce its size, then refresh the models.',
      );
    case 'could not read OpenCode provider configuration or its referenced credential file':
      return i18n.t(
        'Could not read OpenCode provider configuration or its credential file. Check file paths and permissions, then refresh the models.',
      );
    case 'OpenCode provider SDK is not bundled; external provider packages cannot run with Assistant permissions':
      return i18n.t(
        'This OpenCode provider uses an external SDK that cannot run with Assistant permissions. Choose a provider supported by the bundled OpenCode SDKs.',
      );
    case 'OpenCode provider options require unsupported host access; use API-key or OAuth provider settings':
      return i18n.t(
        'This OpenCode provider requires host access that Assistant does not allow. Use API-key or OAuth provider settings.',
      );
    case 'local assistant agent options must be at most 128 bytes and contain no control characters':
      return i18n.t(
        'Agent options must be at most 128 bytes and cannot contain control characters.',
      );
    case 'OpenCode does not advertise separate service-tier or fast-mode controls; select one of its model variants instead':
      return i18n.t(
        'OpenCode does not offer separate service tier or fast mode controls. Choose an available model variant.',
      );
    case 'choose an explicit OpenCode model before selecting a variant':
      return i18n.t('Choose an OpenCode model before choosing a variant.');
    case 'the selected variant is not offered by this OpenCode model; refresh models and choose an available variant':
      return i18n.t(
        'This OpenCode model does not offer the selected variant. Refresh the models and choose an available variant.',
      );
    case 'the selected local agent model does not support these options; refresh its model catalog':
      return i18n.t(
        'A saved option is not advertised for this model. Choose an available value or restore the agent default.',
      );
    case 'the selected model is not in the local agent catalog; refresh the model list':
    case 'the selected OpenCode model is not in its connected model catalog; refresh models or choose the agent default':
      return i18n.t(
        'This model is not in the agent catalog. Refresh the models and choose an available model.',
      );
    case 'the selected reasoning effort is not supported by this local agent model':
      return i18n.t(
        'This model does not support the selected reasoning effort. Choose an available effort or use the agent default.',
      );
    case 'the selected service tier is not supported by this local agent model':
      return i18n.t(
        'This model does not support the selected service tier. Choose an available tier or use the agent default.',
      );
    case 'fast mode is not available for this local agent model':
      return i18n.t(
        'Fast mode is not available for this model. Turn it off or choose a model that supports it.',
      );
    case 'Claude did not return its native model catalog':
    case 'OpenCode returned no provider catalog':
    case 'OpenCode returned no provider connection metadata':
    case 'Codex did not return its native model catalog':
    case 'Codex returned an invalid model catalog cursor':
      return i18n.t(
        'The agent did not return a valid model catalog. Check its CLI login and version, then refresh.',
      );
    case 'Claude returned an oversized model catalog':
    case 'OpenCode returned too many connected models':
    case 'Codex returned an oversized model catalog':
      return i18n.t(
        'The agent model catalog exceeded the size limit. Update its CLI and refresh the models.',
      );
    case 'local assistant agents may use cloud services; remote providers must be allowed and local-only mode must be off':
    case 'local agent CLIs contact remote providers; remote access must be enabled and local-only mode must be off':
      return i18n.t(
        'Local agents may use cloud models. Allow remote providers and turn local-only mode off before using this agent.',
      );
    case 'local assistant agent is not installed or is not executable; install it and refresh discovery':
    case 'the local agent executable was not found; install it and sign in using its CLI':
    case 'OpenCode CLI was not found':
      return i18n.t('This agent was not found. Install it, then refresh local agents.');
    case 'local assistant agents use their own sign-in; no API key is stored in Kubepit':
      return i18n.t(
        'Sign in through the agent’s command-line tool. Kubepit uses that login and does not store an API key for it.',
      );
    case 'this local agent cannot disable its host tools and integrations; choose another assistant provider':
    case 'this local agent protocol is not supported':
    case 'OpenCode remote authentication configuration cannot be isolated; choose another assistant provider':
    case 'managed OpenCode configuration cannot be isolated; choose another assistant provider':
      return i18n.t(
        'This agent cannot run with Assistant permissions yet. Choose another provider.',
      );
    case 'the local agent timed out':
    case 'OpenCode response timed out':
    case 'OpenCode model discovery timed out':
    case 'OpenCode request timed out':
      return i18n.t(
        'The local agent timed out. Check its CLI login and connection, then try again.',
      );
    case 'the local agent prompt is too large':
      return i18n.t(
        'This request contains too much context. Remove some sections or shorten the message.',
      );
    case 'could not create a private local agent directory':
    case 'could not resolve the local agent directory':
    case 'could not start the local agent; check its installation and sign-in':
    case 'the local agent input is closed':
    case 'could not write to the local agent':
    case 'could not encode the local agent request':
    case 'could not wait for the local agent':
    case 'could not read the local agent output':
    case 'could not encode the local assistant request':
    case 'could not create the OpenCode loopback client':
    case 'could not subscribe to OpenCode events':
    case 'OpenCode refused its event stream':
    case 'OpenCode event stream failed':
    case 'OpenCode local API request failed':
    case 'OpenCode local API response failed':
    case 'OpenCode server did not become ready; update the CLI and retry':
      return i18n.t(
        'Could not start or communicate with the local agent. Check its installation, CLI login and file permissions.',
      );
    case 'the local agent exited unsuccessfully; check its CLI sign-in, model access and version':
    case 'Claude could not complete the request; check the CLI sign-in, model access and usage limits':
    case 'Codex could not complete the request; check the CLI sign-in, model access and version':
    case 'OpenCode could not complete the model request; check its login and model':
    case 'OpenCode model request failed; check its login and model':
    case 'could not inspect OpenCode authentication configuration':
    case 'OpenCode authentication configuration is invalid or too large':
    case 'OpenCode authentication configuration is too large':
    case 'OpenCode authentication configuration is invalid':
      return i18n.t(
        'The local agent could not complete the request. Check its CLI login, model access, usage limits and version.',
      );
    case 'the local agent response exceeded the output limit':
    case 'the local agent stream exceeded the output limit':
    case 'the local agent error stream exceeded the output limit':
    case 'the local agent sent an oversized event':
    case 'OpenCode metadata response was too large':
    case 'OpenCode answer exceeded the response limit':
    case 'OpenCode emitted too many messages':
    case 'OpenCode emitted too many parts':
    case 'Codex sent too many answer items':
      return i18n.t(
        'The local agent exceeded the response size limit. Shorten the request and try again.',
      );
    case 'the local agent sent invalid JSON':
    case 'Claude sent an invalid text event':
    case 'Claude sent an invalid text block':
    case 'Claude stopped without a complete result':
    case 'OpenCode returned an invalid session ID':
    case 'OpenCode ended without a completed answer':
    case 'OpenCode returned malformed event JSON':
    case 'OpenCode local API returned malformed JSON':
    case 'OpenCode rewrote an already streamed answer':
    case 'Codex did not return a thread id':
    case 'Codex did not start a turn':
    case 'Codex sent an invalid text event':
    case 'Codex stopped without a complete result':
    case 'Codex did not return its effective configuration':
    case 'Codex returned an invalid MCP configuration':
    case 'Codex sent an invalid RPC response':
    case 'Codex stopped during initialization':
      return i18n.t('The local agent returned an invalid response. Update its CLI and try again.');
    case 'local agents accept explicit conversation context only; tools must be disabled':
    case 'local agents cannot accept tool results':
    case 'local agents cannot accept tool calls':
    case 'Claude attempted a tool call':
    case 'Claude requested unsupported local access':
    case 'OpenCode requested a host tool despite the no-tools policy':
    case 'OpenCode requested access despite the no-tools policy':
    case 'Codex attempted an unsupported local tool':
    case 'Codex requested unsupported local access':
    case 'local agents cannot use assistant tools':
    case 'local agents cannot receive tool histories':
      return i18n.t(
        'The agent requested access outside the previewed context. Update its CLI or choose another agent.',
      );
    case 'this OpenCode version did not enforce the no-tools permission policy':
      return i18n.t(
        'OpenCode’s restricted permissions could not be verified. The request was stopped before your message was sent.',
      );
    case 'OpenCode did not expose the isolated assistant agent':
      return i18n.t(
        'OpenCode did not load the Assistant’s restricted configuration. The request was stopped before your message was sent.',
      );
    case 'Claude did not disable its tools and MCP servers; update the CLI':
    case 'Claude streamed before confirming tool isolation':
    case 'Claude replied before confirming tool isolation':
    case 'Claude completed before confirming tool isolation':
    case 'Codex cannot confirm disabled environment access; update the CLI':
    case 'Codex did not accept the required isolation settings':
      return i18n.t(
        'The agent could not confirm that its tools and integrations are disabled. Update its CLI or choose another agent.',
      );
    case 'OpenCode models use provider/model IDs':
      return i18n.t(
        'For OpenCode, enter a model as provider/model, for example anthropic/claude-sonnet-4-5.',
      );
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
  if ((match = /^local agent: ([\s\S]+)$/.exec(message)))
    return i18n.t('Local agent error: {error}', { error: match[1]! });
  if ((match = /^OpenCode local API returned (.+)$/.exec(message)))
    return i18n.t('OpenCode returned an error: {status}', { status: match[1]! });
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
