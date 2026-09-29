import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/defaults';
import { selectLocalAgent } from './localAgents';
import type { AiProviderConfig, AiSettings, AiStatus } from '@/types';
import {
  baseUrlProblem,
  hasBlockingIssues,
  isLoopbackUrl,
  settingsIssues,
  type SettingsIssue,
} from './settingsIssues';

// The defaults with the assistant turned on (readiness issues are errors then).
const ai = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...structuredClone(DEFAULT_AI_SETTINGS),
  enabled: true,
  ...patch,
});

// `ai()` with `id` active and its provider changed by `patch`.
const active = (id: string, patch: Partial<AiProviderConfig> = {}): AiSettings => {
  const base = ai({ active_provider: id });
  return {
    ...base,
    providers: base.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  };
};

// An `ai_status` answer for the default providers; `keys` marks stored keys.
const status = (
  keys: Record<string, boolean> = {},
  patch: Partial<AiStatus> = {},
  keyErrors: Record<string, string> = {},
): AiStatus => ({
  enabled: true,
  local_only: false,
  remote_allowed: true,
  keychain: 'macOS Keychain',
  providers: DEFAULT_AI_SETTINGS.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    local: p.id === 'ollama',
    has_key: keys[p.id] ?? false,
    key_error: keyErrors[p.id] ?? null,
    allowed: true,
  })),
  ...patch,
});

const fields = (issues: SettingsIssue[]) => issues.map((i) => i.field);
const errors = (issues: SettingsIssue[]) => fields(issues.filter((i) => i.severity === 'error'));

describe('settingsIssues', () => {
  it('allows CLI login and a default model without a base URL, but refuses local-only mode', () => {
    const initial = ai();
    const configured = {
      ...initial,
      ...selectLocalAgent(initial, {
        kind: 'codex-cli',
        name: 'Codex',
        executable: '/bin/codex',
        source: 'PATH',
        available: true,
        supported: true,
      }),
    };
    configured.providers.at(-1)!.model = '';
    const s = status(
      {},
      {
        providers: [
          {
            id: 'codex-cli',
            kind: 'codex-cli',
            local: false,
            has_key: false,
            key_error: null,
            allowed: true,
          },
        ],
      },
    );
    expect(settingsIssues(configured, s)).toEqual([]);
    expect(errors(settingsIssues({ ...configured, local_only: true }, s))).toEqual([
      'active_provider',
    ]);
    expect(settingsIssues({ ...configured, local_only: true }, s)[0]!.message).toContain(
      'cloud models',
    );
    s.providers[0]!.allowed = false;
    expect(fields(settingsIssues(configured, s))).toEqual(['providers.codex-cli.executable']);
    expect(hasBlockingIssues(settingsIssues(configured, s))).toBe(false);
  });
  it('flags an empty model for the active OpenAI-compatible provider', () => {
    expect(fields(settingsIssues(active('openai', { model: '' }), status()))).toContain(
      'providers.openai.model',
    );
    expect(errors(settingsIssues(active('ollama', { model: ' ' }), status()))).toContain(
      'providers.ollama.model',
    );
    // Only the active provider needs a model; Anthropic falls back to its default.
    expect(fields(settingsIssues(ai(), status({ anthropic: true })))).not.toContain(
      'providers.openai.model',
    );
  });

  it('flags a remote active provider under local-only mode', () => {
    const issues = settingsIssues(ai({ local_only: true }), status({ anthropic: true }));
    expect(errors(issues)).toContain('active_provider');
    expect(hasBlockingIssues(issues)).toBe(true);
    // A loopback provider is fine in local-only mode.
    expect(
      settingsIssues(
        { ...active('ollama', { model: 'llama3.1:8b' }), local_only: true },
        status({ anthropic: true }),
      ),
    ).toEqual([]);
  });

  it('warns when this process cannot reach remote providers', () => {
    const issues = settingsIssues(ai(), status({ anthropic: true }, { remote_allowed: false }));
    expect(fields(issues)).toEqual(['active_provider']);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('flags a missing key for the active remote provider', () => {
    const issues = settingsIssues(ai(), status());
    expect(fields(issues)).toEqual(['providers.anthropic.key']);
    // Keys are not part of the draft: the issue never blocks Save.
    expect(hasBlockingIssues(issues)).toBe(false);
    // Ollama and a loopback OpenAI-compatible server need no key.
    expect(settingsIssues(active('ollama', { model: 'llama3.1:8b' }), status())).toEqual([]);
    expect(
      settingsIssues(
        active('openai', { model: 'qwen', base_url: 'http://127.0.0.1:1234/v1' }),
        status(),
      ),
    ).toEqual([]);
    // A remote OpenAI-compatible endpoint does.
    expect(fields(settingsIssues(active('openai', { model: 'gpt' }), status()))).toEqual([
      'providers.openai.key',
    ]);
  });

  it('accepts the defaults with a stored key', () => {
    expect(settingsIssues(ai(), status({ anthropic: true }))).toEqual([]);
    expect(
      settingsIssues(structuredClone(DEFAULT_AI_SETTINGS), status({ anthropic: true })),
    ).toEqual([]);
  });

  it('accepts the defaults before the status is known', () => {
    expect(settingsIssues(ai(), null)).toEqual([]);
  });

  it('rejects non-http base URLs and negative prices', () => {
    const settings: AiSettings = {
      ...active('anthropic', { base_url: 'ftp://api.anthropic.com' }),
      prices: [
        {
          model: 'claude-opus-5',
          input_per_mtok: -1,
          output_per_mtok: 10,
          cache_write_per_mtok: null,
          cache_read_per_mtok: -0.5,
        },
      ],
    };
    const issues = settingsIssues(settings, status({ anthropic: true }));
    expect(errors(issues)).toEqual(
      expect.arrayContaining([
        'providers.anthropic.base_url',
        'prices.0.input_per_mtok',
        'prices.0.cache_read_per_mtok',
      ]),
    );
    expect(fields(issues)).not.toContain('prices.0.output_per_mtok');
    expect(fields(issues)).not.toContain('prices.0.cache_write_per_mtok');
  });

  it('requires a model and a price for every price row, once per model', () => {
    const price = {
      model: 'm',
      input_per_mtok: 1,
      output_per_mtok: 2,
      cache_write_per_mtok: null,
      cache_read_per_mtok: null,
    };
    const issues = settingsIssues(
      ai({
        prices: [
          price,
          { ...price, model: ' m ' },
          { ...price, model: ' ', output_per_mtok: Number.NaN },
        ],
      }),
      status({ anthropic: true }),
    );
    expect(errors(issues)).toEqual([
      'prices.1.model',
      'prices.2.model',
      'prices.2.output_per_mtok',
    ]);
  });

  it('flags every invalid base URL, active or not', () => {
    for (const url of [
      '',
      'api.openai.com/v1',
      'https://user:pw@api.openai.com',
      'https://api.openai.com/v1?api-version=1',
      'https://api.openai.com/#x',
      'https://api openai.com',
      'http://evil\\@127.0.0.1',
      'https://:443',
    ]) {
      const issues = settingsIssues(
        {
          ...ai(),
          providers: ai().providers.map((p) => (p.id === 'openai' ? { ...p, base_url: url } : p)),
        },
        status({ anthropic: true }),
      );
      expect(errors(issues), url).toEqual(['providers.openai.base_url']);
    }
  });

  it('flags no chosen provider', () => {
    expect(errors(settingsIssues(ai({ active_provider: null }), status()))).toEqual([
      'active_provider',
    ]);
    expect(errors(settingsIssues(ai({ active_provider: 'gone' }), status()))).toEqual([
      'active_provider',
    ]);
  });

  it("flags a stored key that cannot be used on that provider's key field", () => {
    const issues = settingsIssues(
      ai(),
      status({ anthropic: true }, {}, { openai: 'The key was saved for https://old.example.' }),
    );
    expect(fields(issues)).toEqual(['providers.openai.key']);
    expect(issues[0]!.message).toContain('https://old.example');
    expect(hasBlockingIssues(issues)).toBe(false);
    // On the active provider it replaces the "no key" issue.
    const own = settingsIssues(ai(), status({}, {}, { anthropic: 'The keychain is locked.' }));
    expect(fields(own)).toEqual(['providers.anthropic.key']);
    expect(own[0]!.message).toContain('The keychain is locked.');
  });

  it('flags a remote http:// base URL on a provider that sends a key', () => {
    // Anthropic always sends its key.
    expect(
      errors(
        settingsIssues(
          active('anthropic', { base_url: 'http://proxy.corp:8080' }),
          status({ anthropic: true }),
        ),
      ),
    ).toEqual(['providers.anthropic.base_url']);
    // Another provider only when a key is stored for it (a warning while inactive).
    const openai = {
      ...ai(),
      providers: ai().providers.map((p) =>
        p.id === 'openai' ? { ...p, base_url: 'http://gateway.corp/v1' } : p,
      ),
    };
    expect(settingsIssues(openai, status({ anthropic: true }))).toEqual([]);
    const withKey = settingsIssues(openai, status({ anthropic: true, openai: true }));
    expect(fields(withKey)).toEqual(['providers.openai.base_url']);
    expect(hasBlockingIssues(withKey)).toBe(false);
    // Loopback over http is fine.
    expect(
      settingsIssues(
        active('anthropic', { base_url: 'http://127.0.0.1:4000' }),
        status({ anthropic: true }),
      ),
    ).toEqual([]);
  });

  it('keeps max_context_tokens within 2 000–900 000', () => {
    for (const n of [1999, 900_001, 2500.5, Number.NaN])
      expect(
        errors(settingsIssues(ai({ max_context_tokens: n }), status({ anthropic: true }))),
        String(n),
      ).toEqual(['max_context_tokens']);
    for (const n of [2000, 900_000])
      expect(settingsIssues(ai({ max_context_tokens: n }), status({ anthropic: true }))).toEqual(
        [],
      );
  });

  it('requires positive token limits', () => {
    expect(
      errors(
        settingsIssues(
          active('anthropic', { max_output_tokens: 0, context_window: -5 }),
          status({ anthropic: true }),
        ),
      ),
    ).toEqual(['providers.anthropic.context_window', 'providers.anthropic.max_output_tokens']);
  });

  it('reports readiness as warnings while the assistant is off', () => {
    const issues = settingsIssues(
      { ...active('openai', { model: '' }), enabled: false, local_only: true },
      status(),
    );
    expect(fields(issues)).toEqual(
      expect.arrayContaining(['active_provider', 'providers.openai.model', 'providers.openai.key']),
    );
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('translates messages', async () => {
    const i18n = await import('@/i18n/core');
    i18n.setLocale('tr', false);
    try {
      const [issue] = settingsIssues(ai({ active_provider: null }), status());
      expect(issue!.message).not.toBe('Choose a provider.');
    } finally {
      i18n.setLocale('en', false);
    }
  });
});

describe('base URLs', () => {
  it('recognizes loopback hosts strictly, like the backend', () => {
    for (const url of [
      'http://127.0.0.1:11434',
      'http://127.9.8.7',
      'https://localhost:8443/v1',
      'http://LOCALHOST',
      'http://[::1]:11434',
      '  http://127.0.0.1:4000/  ',
    ])
      expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of [
      'https://api.anthropic.com',
      'http://10.0.0.1:11434',
      'http://localhost.evil.example',
      'http://127.0.0.1@evil.example',
      'ftp://127.0.0.1',
      '127.0.0.1:11434',
      '',
      'not a url',
      'http://0.0.0.0:11434',
      'http://[::ffff:127.0.0.1]',
      'http://localhost.',
      'http://127.0.0.1\\@evil',
      'http://evil\\@127.0.0.1',
      'http://[::1]x:4000',
      'http://127.1',
    ])
      expect(isLoopbackUrl(url), url).toBe(false);
  });

  it('accepts plain http(s) URLs with a path and a port', () => {
    for (const url of [
      'https://api.anthropic.com',
      'https://api.openai.com/v1/',
      'http://127.0.0.1:11434',
      'https://gateway.example:8443/openai/v1',
    ])
      expect(baseUrlProblem(url), url).toBeNull();
  });
});
