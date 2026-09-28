# More Languages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise Kubepit's i18n from English/Turkish to N locales, with per-locale plurals, locale-aware formatting, lazy catalogs, fallback and detection, casing fixes, an N-locale checker with coverage and draft markers, a contributor workflow, and six new locales shipped as flagged drafts: `de`, `es`, `fr`, `pt-BR`, `zh-CN`, `ja`.

**Architecture:** A single registry (`src/i18n/locales.json`) drives the runtime (`src/i18n/core.ts`), the pickers, the checker (`scripts/i18n/*.mjs`) and a draft tool (`scripts/i18n-drafts.mjs`). English stays statically imported as the source and fallback. Other catalogs load lazily through `import.meta.glob`, and `plural()` resolves CLDR categories with object forms on the `other` key. Draft status lives in per-locale `drafts.json` sidecars, so catalog values stay plain strings.

**Tech Stack:** TypeScript, React 18, Vite 5 (`import.meta.glob`), `Intl` (PluralRules, NumberFormat, DateTimeFormat, RelativeTimeFormat, ListFormat, Collator), Node 22 ESM scripts with `node:test`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-more-languages-design.md`

## Global Constraints

- IPC contract: this plan adds no command. If a task needs one, change `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` together. The locale stays frontend-only (localStorage `kp-locale`).
- Design: the UI must stay visually identical to RunHQ. Use tokens from `src/styles/theme.css`, primitives from `src/components/ui/`, 11–13px UI text, uppercase tracked labels (with the CJK letter-spacing exception from Task 7), `bg-fg/N` hover pads and the accent strip for active rows. No chart or UI libraries, and no i18n libraries (no i18next, no FormatJS). Layouts use container queries.
- i18n: every new user-visible string ships in English **and** Turkish in the same task. The six new locales get their strings through the draft tasks (9–14) and the draft tool. Use `import * as i18n from '@/i18n'` in components and `@/i18n/core` in pure helpers. Use `i18n.t` / `rich` / `plural`, never concatenated fragments. `pnpm i18n:check` passes. Never translate Kubernetes data, kinds used as identifiers, API groups, YAML, logs, commands, product names or user content.
- Kubernetes nouns stay English in every locale, per `scripts/i18n/glossary.json` (Task 6): Cluster, Namespace, Pod, Node, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Service, Ingress, Secret, ConfigMap, PersistentVolume(Claim), StorageClass, Helm, chart, release, kubeconfig, context, kubectl.
- Registry values are copied verbatim into `locales.json`:

  | code | name | short | format | status | required |
  |---|---|---|---|---|---|
  | `en` | English | `EN` | `en-US` | `source` | true |
  | `tr` | Türkçe | `TR` | `tr-TR` | `reviewed` | true |
  | `de` | Deutsch | `DE` | `de-DE` | `draft` | false |
  | `es` | Español | `ES` | `es-ES` | `draft` | false |
  | `fr` | Français | `FR` | `fr-FR` | `draft` | false |
  | `pt-BR` | Português (Brasil) | `PT` | `pt-BR` | `draft` | false |
  | `zh-CN` | 简体中文 | `中文` | `zh-CN` | `draft` | false |
  | `ja` | 日本語 | `日本語` | `ja-JP` | `draft` | false |

  `tr` additionally sets `lowercaseDateNames: true`.
- Safety: tests never connect to clusters or cloud accounts and never read real user files. Script tests use in-memory fixtures and `fs.mkdtempSync(os.tmpdir())` directories.
- `read_only` and backend commands are untouched. No background work is added.
- The six checks pass at the end of every task that touches their area: `pnpm typecheck` · `pnpm i18n:check` · `pnpm test` · `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`. `pnpm dev:ui` keeps working. After Task 5, `pnpm test` also runs `node --test scripts/i18n/`.

## Review Focus

- **A saved locale that no longer exists, or garbage in `kp-locale`**, such as a locale removed from the registry or `"xx"`: boot falls back to system detection and never throws or renders blank. Tested in Task 2 (`unknown_saved_locale_falls_back_to_detection`).
- **A chunk fails to load** (a corrupt install, or a dev server restart mid-switch): the current language stays, the UI remains usable, and a warning is logged. Tested in Task 3 (`failed_load_keeps_the_current_locale`).
- **A missing key in a draft locale**, such as a key added after drafting: that string shows in English while the rest stays translated, with no raw key and no `undefined`. Tested in Task 3 (`missing_keys_fall_back_per_key`).
- **Two windows switch language at once** (storage events): both windows end on the last value written, and neither window stays half-switched. Tested in Task 3 (`storage_event_switches_after_loading`).
- **Kubernetes identifiers in uppercase labels under `tr` and `de`**: `apiextensions.k8s.io` renders as `APIEXTENSIONS.K8S.IO`, not with a dotted İ, and `compareIds` gives the same order in every locale. Tested in Task 4 (`compare_ids_is_locale_independent`) plus the Task 7 manual check.

---

## File Structure

- `apps/desktop/src/i18n/locales.json`: create. The registry (D1).
- `apps/desktop/src/i18n/locales.ts`: create. `LOCALE_CODES`, `Locale`, `LOCALE_REGISTRY`, `localeInfo`, `resolveLocale`, `fallbackChain`.
- `apps/desktop/src/i18n/core.ts`: modify. Registry-driven runtime, lazy catalogs, plural categories, cached formatters, new helpers.
- `apps/desktop/src/i18n/index.tsx`: modify. Re-exports; `useLocale` fallback type.
- `apps/desktop/src/i18n/{core,format,locales}.test.ts`: create.
- `apps/desktop/src/lib/i18n.ts`, `apps/desktop/src/main.tsx:1-27`: modify. Async init before render.
- `apps/desktop/src/components/workbench/table/tableModel.ts:39`, `lib/savedViews.ts:40`, `components/sidebar/sidebarSearch.ts:4-5`, `lib/selectSearch.ts:14-17`, `lib/kube/wizards/cron.ts:181-220`: modify (formatting helpers).
- `apps/desktop/src/components/LanguageMenu.tsx`, `components/settings/categories.tsx:60-82`, `components/palette/paletteItems.tsx:333-341`: modify (registry pickers).
- `apps/desktop/src/styles/base.css`: modify (CJK tracking rule).
- `scripts/check-i18n.mjs`: rewrite as the CLI entry. `scripts/i18n/{registry,scan,io,check,report}.mjs`: create. `scripts/i18n/check.test.mjs`: create.
- `scripts/i18n-drafts.mjs`, `scripts/i18n/drafts.mjs`, `scripts/i18n/drafts.test.mjs`, `scripts/i18n/glossary.json`: create.
- `package.json`: modify (`test`, `i18n:drafts` scripts).
- `apps/desktop/src/i18n/{de,es,fr,pt-BR,zh-CN,ja}/{shell,workbench,dock,drafts}.json`: create (Tasks 9–14).
- `apps/desktop/src/i18n/{en,tr}/shell.json`: modify (new UI strings).
- `docs/i18n/CONTRIBUTING.md`, `docs/i18n/GLOSSARY.md`: create. `AGENTS.md:19-31`, `docs/ARCHITECTURE.md`, `README.md:44`: modify.

---

### Task 1: Frontend unit-test harness (skip if present)

**Files:** `apps/desktop/package.json`, `package.json`, `apps/desktop/vite.config.ts`, `scripts/check-i18n.mjs` (walk), `apps/desktop/src/lib/format.test.ts`

**Interfaces:**
- Produces: `pnpm test` runs `vitest run` (environment `node`, include `src/**/*.test.ts`). The i18n checker skips `*.test.ts(x)`.

- [ ] **Step 1: Skip check**: run `grep -q '"test"' apps/desktop/package.json && echo present`. If it prints `present`, go to Step 5.
- [ ] **Step 2: Write `src/lib/format.test.ts`**, asserting `formatAge(now - 45_000, now) === '45s'`, `formatAge(now - 3 * 3600_000, now) === '3h'` and `formatAge(null, now) === '—'`.
- [ ] **Step 3: Add `vitest@^3.2.4`** as a devDependency. Scripts: `apps/desktop` `"test": "vitest run"`, root `"test": "pnpm --filter @kubepit/desktop test"`. In `vite.config.ts`, add `/// <reference types="vitest/config" />` and `test: { environment: 'node', include: ['src/**/*.test.ts'] }`. The checker's `walk` skips `/\.test\.tsx?$/`. Run `pnpm install`.
- [ ] **Step 4: Run `pnpm test`**. Expected: `1 passed`. Commit: `git commit -m "test(ui): add a Vitest harness for pure frontend helpers"`.
- [ ] **Step 5: Run `pnpm typecheck && pnpm i18n:check && pnpm test`**. Expected: all pass.

---

### Task 2: Locale registry, detection and fallback chain

**Files:**
- Create: `apps/desktop/src/i18n/locales.json` (entries `en` and `tr` only; draft locales are added in Tasks 9–14), `apps/desktop/src/i18n/locales.ts`, `apps/desktop/src/i18n/locales.test.ts`

**Interfaces:**
- Produces (`locales.ts`):
  - `export const LOCALE_CODES = ['en', 'tr'] as const`. Each draft task appends its code.
  - `export type Locale = (typeof LOCALE_CODES)[number]`
  - `export interface LocaleInfo { code: Locale; name: string; short: string; format: string; status: 'source' | 'reviewed' | 'draft'; required: boolean; lowercaseDateNames?: boolean }`
  - `export const LOCALE_REGISTRY: readonly LocaleInfo[]`, imported from `locales.json`
  - `export function localeInfo(code: Locale): LocaleInfo`
  - `export function isLocale(value: unknown): value is Locale`
  - `export function resolveLocale(tags: readonly string[]): Locale`, implementing the D5 rules. It walks the tags in order and returns the first match; for each tag:
    1. Normalize `_` → `-` and lowercase for comparison.
    2. An exact match on a registered code wins.
    3. Otherwise, a tag that is `zh-hant`, starts with `zh-hant-`, or is `zh-tw`, `zh-hk` or `zh-mo` is skipped.
    4. Otherwise, a tag that is `zh`, `zh-cn`, `zh-sg` or starts with `zh-hans` maps to `zh-CN` if registered.
    5. Otherwise, the base language maps to the first registered code with that base.

    If no tag matches, it returns `en`.
  - `export function fallbackChain(code: Locale): Locale[]` returns `[code, <registered base if different>, 'en']`, deduplicated.

- [ ] **Step 1: Write the failing tests**

```ts
// i18n/locales.test.ts
import { describe, expect, it } from 'vitest';
import registry from './locales.json';
import { LOCALE_CODES, fallbackChain, resolveLocale } from './locales';

describe('locale registry', () => {
  it('keeps LOCALE_CODES equal to locales.json', () => {
    expect([...LOCALE_CODES]).toEqual(registry.map((l) => l.code));
  });
  it('detects locales from navigator.languages', () => {
    expect(resolveLocale(['tr_TR', 'en'])).toBe('tr');
    expect(resolveLocale(['xx', 'TR'])).toBe('tr');
    expect(resolveLocale(['nl-NL'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });
  it('unknown_saved_locale_falls_back_to_detection', () => {
    // resolveLocale is also used for the saved value: garbage resolves like any unknown tag
    expect(resolveLocale(['xx', 'tr-TR'])).toBe('tr');
  });
  it('builds the fallback chain', () => {
    expect(fallbackChain('tr')).toEqual(['tr', 'en']);
    expect(fallbackChain('en')).toEqual(['en']);
  });
});
```

The Traditional Chinese and Portuguese cases are added in Tasks 12–13, when `zh-CN` and `pt-BR` are registered: `resolveLocale(['zh-TW', 'ja'])` is `'ja'` (once `ja` exists), `resolveLocale(['zh-Hans-CN'])` is `'zh-CN'`, `resolveLocale(['pt-PT'])` is `'pt-BR'`, and `fallbackChain('pt-BR')` is `['pt-BR', 'en']`.

- [ ] **Step 2: Run `pnpm --filter @kubepit/desktop exec vitest run src/i18n/locales`**. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement `locales.json` and `locales.ts`**.
- [ ] **Step 4: Run the same command**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(i18n): locale registry, detection and fallback chain"`.

---

### Task 3: Registry-driven runtime: lazy catalogs, fallback and plural categories

**Files:**
- Modify: `apps/desktop/src/i18n/core.ts:1-102`, `apps/desktop/src/i18n/index.tsx:1-36`, `apps/desktop/src/lib/i18n.ts:1-14`, `apps/desktop/src/main.tsx:19-27`, `apps/desktop/src/components/settings/categories.tsx:70` and `components/palette/paletteItems.tsx:340` (await-free call sites: `void i18n.setLocale(...)`)
- Create: `apps/desktop/src/i18n/core.test.ts`

**Interfaces:**
- Consumes: `locales.ts` (Task 2).
- Produces (`core.ts`, exported through `@/i18n` and `@/i18n/core`):
  - `export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'`
  - `export type PluralForms = Partial<Record<Exclude<PluralCategory, 'one' | 'other'>, string>> & { other: string }`
  - `export type Catalog = Partial<Record<MessageKey, string | PluralForms>>`
  - `export function registerCatalog(code: Locale, catalog: Catalog): void` merges into any existing catalog.
  - `export const catalogLoader: { load(code: Locale): Promise<Catalog> }` is the default loader: `import.meta.glob<{ default: Catalog }>('./*/*.json')`, skipping `en/`, `drafts.json` and `locales.json`, and merging `shell`, `workbench` and `dock` in that order. It is an object, so tests can replace `load` with `vi.spyOn`.
  - `export function loadLocale(code: Locale): Promise<void>` calls `catalogLoader.load` for every chain member not yet registered, then `registerCatalog`.
  - `export async function setLocale(next: Locale, persist = true): Promise<void>`: unregistered codes are ignored. It awaits `loadLocale(next)`. **If that fails, it logs `console.warn` and returns without switching.** Otherwise it sets `document.documentElement.lang = next`, persists `kp-locale`, assigns, and notifies the listeners once. When several calls overlap, the last one requested wins.
  - `export async function initializeLocale(): Promise<() => void>`: the saved value is used if `isLocale`, else `resolveLocale(navigator.languages ?? [navigator.language])`. It awaits `setLocale(…, false)` and installs the `storage` listener, which calls `void setLocale(preferred(), false)`.
  - `getFormatLocale()` returns `localeInfo(locale).format`.
  - `message(key, language = locale)` walks `fallbackChain(language)`. A string is returned as is, a `PluralForms` object returns `.other`, and when nothing is found the key itself is returned.
  - `plural(one, other, count, values)`: the category comes from a cached `Intl.PluralRules(getFormatLocale())`. `one` resolves the `one` key; any other category resolves the `other` key, taking the object's `[category] ?? .other` or the string. `{count}` is formatted with `number(count)`, as today.
  - `LOCALES` stays exported (as `LOCALE_CODES`) for existing imports.
- `lib/i18n.ts`: `initializeDesktopLocale(): Promise<void>` is idempotent.
- `main.tsx`: `void initializeDesktopLocale().finally(() => ReactDOM.createRoot(…).render(…))`, with no top-level await.

- [ ] **Step 1: Write the failing tests**

```ts
// i18n/core.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each test gets a fresh module so the catalog cache and current locale start clean.
const fresh = async () => { vi.resetModules(); return import('./core'); };

describe('runtime', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('missing_keys_fall_back_per_key', async () => {
    const i18n = await fresh();
    vi.spyOn(i18n.catalogLoader, 'load').mockResolvedValue({ Cancel: 'İptal' } as i18n.Catalog);
    await i18n.setLocale('tr', false);
    expect(i18n.t('Cancel')).toBe('İptal');
    expect(i18n.t('Display language')).toBe('Display language');
  });

  it('selects CLDR categories, including object forms', async () => {
    const i18n = await fresh();
    vi.spyOn(i18n.catalogLoader, 'load').mockResolvedValue({
      '{count} new alert': '{count} yeni uyarı',
      '{count} new alerts': { other: '{count} X', many: '{count} M' },
    } as i18n.Catalog);
    await i18n.setLocale('tr', false);
    expect(i18n.plural('{count} new alert', '{count} new alerts', 1)).toBe('1 yeni uyarı');
    expect(i18n.plural('{count} new alert', '{count} new alerts', 2)).toBe('2 X');
    vi.spyOn(Intl.PluralRules.prototype, 'select').mockReturnValue('many');
    expect(i18n.plural('{count} new alert', '{count} new alerts', 1_000_000)).toBe(`${i18n.number(1_000_000)} M`);
  });

  it('failed_load_keeps_the_current_locale', async () => {
    const i18n = await fresh();
    vi.spyOn(i18n.catalogLoader, 'load').mockRejectedValueOnce(new Error('chunk'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await i18n.setLocale('tr', false);
    expect(i18n.getLocale()).toBe('en');
    expect(warn).toHaveBeenCalled();
  });

  it('notifies listeners once per switch', async () => {
    const i18n = await fresh();
    vi.spyOn(i18n.catalogLoader, 'load').mockResolvedValue({} as i18n.Catalog);
    const seen: string[] = [];
    const off = i18n.subscribe(() => seen.push(i18n.getLocale()));
    await i18n.setLocale('tr', false);
    await i18n.setLocale('tr', false);
    off();
    expect(seen).toEqual(['tr']);
  });

  it('storage_event_switches_after_loading', async () => {
    const i18n = await fresh();
    vi.spyOn(i18n.catalogLoader, 'load').mockResolvedValue({} as i18n.Catalog);
    const store = new Map<string, string>();
    const listeners: Record<string, (e: { key: string | null }) => void> = {};
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    vi.stubGlobal('window', {
      navigator: { languages: ['en'], language: 'en' },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      addEventListener: (type: string, fn: (e: { key: string | null }) => void) => { listeners[type] = fn; },
      removeEventListener: () => {},
    });
    await i18n.initializeLocale();
    store.set('kp-locale', 'tr');
    listeners.storage!({ key: 'kp-locale' });
    await vi.waitFor(() => expect(i18n.getLocale()).toBe('tr'));
  });
});
```

- [ ] **Step 2: Run `pnpm --filter @kubepit/desktop exec vitest run src/i18n/core`**. Expected: FAIL.
- [ ] **Step 3: Implement the runtime and the boot change; update the two synchronous `setLocale` callers**.
- [ ] **Step 4: Run `pnpm test && pnpm typecheck && pnpm i18n:check`**. Expected: PASS. `pnpm dev:ui` boots, switching to Türkçe works, and the Network panel shows the `tr` catalog chunks loading on demand (no `tr` chunk when the app starts in English).
- [ ] **Step 5: Commit** `git commit -m "feat(i18n): lazy per-locale catalogs, fallback chain and CLDR plural forms"`.

---

### Task 4: Formatting, collation and search folding

**Files:**
- Modify: `apps/desktop/src/i18n/core.ts`, `apps/desktop/src/components/workbench/table/tableModel.ts:39`, `apps/desktop/src/lib/savedViews.ts:40`, `apps/desktop/src/components/sidebar/sidebarSearch.ts:4-5`, `apps/desktop/src/lib/selectSearch.ts:14-17`, `apps/desktop/src/lib/kube/wizards/cron.ts:181-220`
- Test: `apps/desktop/src/i18n/format.test.ts`

**Interfaces:**
- Produces (`core.ts`):
  - `number`, `date` and `relative` keep their signatures and use a formatter cache (`Map` keyed by `locale|JSON.stringify(options)`).
  - `export function currency(value: number, code: string, options?: Intl.NumberFormatOptions): string` uses `style: 'currency'`.
  - `export function list(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string` uses `Intl.ListFormat`, style `long`, falling back to `items.join(', ')`.
  - `export function compareText(a: string, b: string): number` uses the app-locale collator (`sensitivity: 'base'`, `numeric: true`).
  - `export function compareIds(a: string, b: string): number` uses `Intl.Collator('en', { numeric: true, sensitivity: 'base' })`.
  - `export function foldSearch(text: string): string` returns `text.toLocaleLowerCase(getFormatLocale()).normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i')`.
  - `export function lowercaseDateNames(): boolean` returns `localeInfo(locale).lowercaseDateNames === true`.
- Call sites:
  - `tableModel.ts:39` and `savedViews.ts:40` use `compareIds`.
  - `sidebarSearch.ts` and `selectSearch.ts` use `foldSearch` on both the query and the haystack.
  - `cron.ts`: `list()` uses `i18n.list`, and `inSentence()` uses `i18n.lowercaseDateNames()` instead of `getLocale() === 'tr'`.

- [ ] **Step 1: Write the failing tests**

```ts
// i18n/format.test.ts — uses the real catalogs
import { describe, expect, it, vi } from 'vitest';
import * as i18n from './core';

describe('formatting', () => {
  it('compare_ids_is_locale_independent', async () => {
    const ids = ['pod-10', 'Pod-2', 'ingress', 'İstanbul', 'istio'];
    await i18n.setLocale('en', false); const en = [...ids].sort(i18n.compareIds);
    await i18n.setLocale('tr', false); const tr = [...ids].sort(i18n.compareIds);
    expect(tr).toEqual(en);
  });
  it('folds Turkish letters for search', async () => {
    await i18n.setLocale('tr', false);
    expect(i18n.foldSearch('İSTANBUL')).toBe('istanbul');
    expect(i18n.foldSearch('ılık')).toBe('ilik');
    expect(i18n.foldSearch('Ünlü')).toBe('unlu');
  });
  it('formats currency and lists in the app locale', async () => {
    await i18n.setLocale('tr', false);
    expect(i18n.currency(1234.5, 'USD')).toContain('1.234,50');
    expect(i18n.list(['a', 'b', 'c'])).toBe('a, b ve c');
    await i18n.setLocale('en', false);
    expect(i18n.list(['a', 'b', 'c'])).toBe('a, b, and c');
  });
  it('caches formatters', () => {
    const spy = vi.spyOn(Intl, 'NumberFormat');
    i18n.number(1, { maximumFractionDigits: 7 }); i18n.number(2, { maximumFractionDigits: 7 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run `pnpm --filter @kubepit/desktop exec vitest run src/i18n/format`**. Expected: FAIL.
- [ ] **Step 3: Implement the helpers and update the call sites**. The cron description tests (manual) must render the same Turkish output as before.
- [ ] **Step 4: Run `pnpm test && pnpm typecheck && pnpm i18n:check`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(i18n): cached Intl formatters, currency, lists, stable id collation and search folding"`.

---

### Task 5: N-locale checker with coverage, drafts and plural validation

**Files:**
- Create: `scripts/i18n/registry.mjs`, `scripts/i18n/scan.mjs`, `scripts/i18n/io.mjs`, `scripts/i18n/check.mjs`, `scripts/i18n/report.mjs`, `scripts/i18n/check.test.mjs`
- Modify: `scripts/check-i18n.mjs` (becomes the CLI glue), `package.json` (`"test": "pnpm --filter @kubepit/desktop test && node --test scripts/i18n/"`)

**Interfaces:**
- Produces:
  - `registry.mjs`: `loadRegistry(srcRoot) -> LocaleInfo[]`, reading `i18n/locales.json`.
  - `scan.mjs`: `scanSources(srcRoot) -> { used: Record<Area, Map<key, file>>, pluralOne: Record<Area, Set<key>>, pluralOther: Record<Area, Set<key>> }`. It moves today's walk, regex and area rules (`check-i18n.mjs:23-63`) here, skips `*.test.ts(x)`, and records which keys are the first and second literals of `plural(`.
  - `io.mjs`:
    - `loadCatalogs(srcRoot, registry) -> Record<code, Record<Area, object>>` (a missing file is `{}`)
    - `loadDrafts(srcRoot, code) -> Record<Area, string[]>`
    - `saveCatalog(srcRoot, code, area, data)` and `saveDrafts(srcRoot, code, drafts)`: keys sorted with `a.localeCompare(b, 'en')`, 2-space indent, trailing newline
    - `listLocaleDirs(srcRoot) -> string[]`
  - `check.mjs`: `checkAll({ registry, scan, catalogs, drafts, dirs, fix, strictDrafts, areas }) -> { problems: Problem[], warnings: Problem[], coverage: Coverage[], catalogs, drafts }`. It is pure (it returns fixed copies when `fix`).
    - `Problem = { code, area, locale, key, detail }`.
    - Failure codes: `missing-en`, `unused`, `missing` (a required locale, or any locale with `strictDrafts`), `extra`, `placeholder-mismatch`, `invalid-plural-category`, `plural-object-on-non-plural`, `stale-draft`, `unknown-locale-dir`.
    - Warning code: `conflicting-duplicate`.
    - Plural rules: object keys ⊆ `new Intl.PluralRules(format).resolvedOptions().pluralCategories` minus `one`, and `other` is required. Each form's placeholder set must equal the English `other` form's, except that a form may drop `{count}` only when the English form lacks it.
    - `Coverage = { locale, status, total, translated, reviewed, drafts }`. `translated` counts keys present in the catalog. `reviewed` counts translated keys that are not listed in drafts.
  - `report.mjs`: `formatProblems(problems, warnings) -> string`, `formatCoverage(coverage) -> string` (aligned table), and JSON via `JSON.stringify(coverage)`.
  - The CLI flags are `--fix`, `--area=`, `--locale=`, `--coverage[=json]` and `--strict-drafts`. It exits 1 on any problem and prints `i18n OK` otherwise. Warnings are printed but never fail.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/i18n/check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAll } from './check.mjs';

const registry = [
  { code: 'en', format: 'en-US', status: 'source', required: true },
  { code: 'tr', format: 'tr-TR', status: 'reviewed', required: true },
  { code: 'fr', format: 'fr-FR', status: 'draft', required: false },
];
const scan = (keys, plural = []) => ({
  used: { shell: new Map(keys.map((k) => [k, 'x.tsx'])), workbench: new Map(), dock: new Map() },
  pluralOne: { shell: new Set(plural.map((p) => p[0])), workbench: new Set(), dock: new Set() },
  pluralOther: { shell: new Set(plural.map((p) => p[1])), workbench: new Set(), dock: new Set() },
});
const run = (over) => checkAll({ registry, dirs: ['en', 'tr', 'fr'], fix: false, strictDrafts: false, areas: ['shell', 'workbench', 'dock'], drafts: { tr: {}, fr: {} }, ...over });

test('required locales fail on missing keys, drafts only lose coverage', () => {
  const r = run({ scan: scan(['Save']), catalogs: { en: { shell: { Save: 'Save' } }, tr: { shell: {} }, fr: { shell: {} } } });
  assert.deepEqual(r.problems.map((p) => [p.code, p.locale]), [['missing', 'tr']]);
  assert.equal(r.coverage.find((c) => c.locale === 'fr').translated, 0);
});
test('plural objects are validated per locale', () => {
  const plural = [['{count} pod', '{count} pods']];
  const en = { shell: { '{count} pod': '{count} pod', '{count} pods': '{count} pods' } };
  const ok = run({ scan: scan(plural[0], plural), catalogs: { en, tr: en, fr: { shell: { '{count} pod': '{count} pod', '{count} pods': { many: '{count} de pods', other: '{count} pods' } } } } });
  assert.equal(ok.problems.length, 0);
  const bad = run({ scan: scan(plural[0], plural), catalogs: { en, tr: en, fr: { shell: { '{count} pod': '{count} pod', '{count} pods': { few: '{count} x' } } } } });
  assert.ok(bad.problems.some((p) => p.code === 'invalid-plural-category'));
});
test('placeholder mismatches, extra keys, stale drafts and unknown dirs fail', () => { /* one case each */ });
test('conflicting duplicates across areas only warn', () => { /* same key in shell and dock with different tr values */ });
test('--fix removes unused, extra and stale entries from every locale and adds English keys', () => { /* assert returned catalogs/drafts */ });
test('--strict-drafts fails on missing draft keys', () => { /* fr missing → problem 'missing' for fr */ });
```

- [ ] **Step 2: Run `node --test scripts/i18n/`**. Expected: FAIL (the modules are missing).
- [ ] **Step 3: Implement the modules and the CLI; update the root `test` script**.
- [ ] **Step 4: Verify**: run `node --test scripts/i18n/ && pnpm i18n:check && pnpm i18n:check -- --coverage`. Expected: the tests pass. The repo prints `i18n OK` with the conflicting-duplicate warnings (21 today, in `tr`), and coverage shows `en` and `tr` at 100% translated.
- [ ] **Step 5: Commit** `git commit -m "feat(i18n): checker for N locales with coverage, drafts and plural validation"`.

---

### Task 6: Draft tool and glossary

**Files:**
- Create: `scripts/i18n-drafts.mjs` (CLI), `scripts/i18n/drafts.mjs` (pure), `scripts/i18n/drafts.test.mjs`, `scripts/i18n/glossary.json`
- Modify: `package.json` (`"i18n:drafts": "node scripts/i18n-drafts.mjs"`)

**Interfaces:**
- Consumes: `registry.mjs`, `scan.mjs`, `io.mjs` and `check.mjs`'s placeholder and plural validators (Task 5; export them as `placeholderSet(text)` and `validPluralForms(locale, forms)`).
- Produces:
  - `glossary.json`: `{ "doNotTranslate": [ ...Kubernetes nouns from Global Constraints ], "terms": { "<English term>": { "de": "…", "es": "…", "fr": "…", "pt-BR": "…", "zh-CN": "…", "ja": "…", "tr": "<existing tr catalog value>" } } }`. It has about 40 recurring UI terms (Settings, Cancel, Save, Delete, Apply, Connect, Disconnect, Read-only, Production, Logs, Terminal, Events, Namespace filter, Saved views, Bookmarks, Health, Alerts, Notifications, Dry run, Rollback, Upgrade, Custom actions, Port forward, Search, Filter, Export, Import, Copy, Details, Overview, …), with the `tr` values copied from the Turkish catalog.
  - `drafts.mjs`:
    - `exportChunks({ locale, catalogs, scan, drafts, glossary, size = 150, areas }) -> Chunk[]`, where `Chunk = { locale, area, index, glossary, rules: string[], items: { key, plural: null | 'one' | 'other', categories?: string[], placeholders: string[], file }[] }`. It covers keys missing from `locale`.
    - `importTranslations({ locale, catalogs, drafts, registry, entries: { area, key, text?: string, forms?: object }[], force = false }) -> { catalogs, drafts, rejected: { key, reason }[] }`. Placeholder-mismatched entries and invalid plural forms are rejected. It never overwrites a key that is not in drafts unless `force`. Imported keys are added to drafts.
    - `markReviewed({ drafts, area?, keys? | all }) -> drafts`
  - CLI:
    - `pnpm i18n:drafts export --locale=de [--area=shell] [--size=150] --out=<dir>` writes `<dir>/<locale>-<area>-<nn>.json`.
    - `pnpm i18n:drafts import --locale=de <file.json>…` takes files holding arrays of `{ area, key, text }` or `{ area, key, forms }`, prints the rejected entries and exits 1 if any were rejected.
    - `pnpm i18n:drafts review --locale=de (--all | --area=shell --keys=<file>)`.
  - The fixed `rules` text in every chunk:
    1. Keep `{placeholders}` exactly.
    2. Keep every `doNotTranslate` term in English.
    3. Use the glossary term when one exists.
    4. Match the terse UI tone of the English and keep it at a similar length.
    5. For `other` plural keys, return `forms` only when the language needs more than one non-`one` form.
    6. For locales without a `one` category (ja, zh-CN), translate the `one` key like the `other` key.
    7. Never add HTML or Markdown.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/i18n/drafts.test.mjs
test('export chunks only missing keys, with plural metadata and glossary', () => { /* 3 missing keys, size 2 → 2 chunks;
  the plural other key has categories ['many','other'] for fr; chunk.glossary.doNotTranslate includes 'Pod' */ });
test('import validates placeholders and plural forms and marks drafts', () => { /* '{count} Pods' → accepted + in drafts;
  a text missing {name} → rejected 'placeholder-mismatch'; forms with 'few' for fr → rejected 'invalid-plural-category' */ });
test('import never overwrites reviewed keys without force', () => { /* key present and not in drafts → rejected 'reviewed' */ });
test('review removes keys from drafts', () => { /* markReviewed all → empty lists */ });
```

- [ ] **Step 2: Run `node --test scripts/i18n/`**. Expected: FAIL.
- [ ] **Step 3: Implement the tool and write the glossary**.
- [ ] **Step 4: Verify**: run `node --test scripts/i18n/ && pnpm i18n:drafts export --locale=tr --out=$(mktemp -d)`. Expected: the tests pass, and the export writes no files, because `tr` is complete.
- [ ] **Step 5: Commit** `git commit -m "feat(i18n): draft export/import/review tool and terminology glossary"`.

---

### Task 7: Registry-driven language pickers and casing rules

**Files:**
- Modify: `apps/desktop/src/components/LanguageMenu.tsx:11-87`, `apps/desktop/src/components/settings/categories.tsx:60-82`, `apps/desktop/src/components/palette/paletteItems.tsx:333-341`, `apps/desktop/src/styles/base.css`, `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `LOCALE_REGISTRY` and `localeInfo` (Task 2), and the async `setLocale` (Task 3).
- Produces:
  - `LanguageMenu`:
    - The options come from `LOCALE_REGISTRY` (`lang={code}`, the endonym, the `code` in a `w-9` mono column, `lang="en"`).
    - Draft locales show `<Badge>` with `i18n.t('Preview')` and the title `i18n.t('Machine-translated and not yet reviewed')`.
    - The menu width is `w-[220px]`.
    - The trigger shows `localeInfo(locale).short`, with `lang="en"` when it is ASCII.
  - Settings General: the `<select>` renders one `<option lang={code}>` per registry entry, with the endonym plus ` · ` + `i18n.t('Preview')` for drafts.
  - Palette: one action per registry locale other than the current one, with id `language:<code>`, label `i18n.t('Switch language to {language}', { language: name })`, keywords `language dil sprache idioma langue idioma 言語 语言 ${name} ${code}`, and `run: () => void i18n.setLocale(code)`. The hard-coded strings at `paletteItems.tsx:336` go away.
  - `base.css`: `html:lang(ja) [class*='tracking-']:not(:lang(en)), html:lang(zh) [class*='tracking-']:not(:lang(en)) { letter-spacing: normal; }`.

- [ ] **Step 1: Implement the pickers and the CSS rule**.
- [ ] **Step 2: Translate**: run `pnpm i18n:check -- --fix`, then add Turkish (`Önizleme`, `Makine çevirisi, henüz gözden geçirilmedi`, `Dili {language} olarak değiştir`) by hand. Expected: `i18n OK`.
- [ ] **Step 3: Verify**: run `pnpm typecheck && pnpm test && pnpm i18n:check`, expecting PASS. Manual (`pnpm dev:ui`), in Türkçe: the Explain view's API group headers read `APIEXTENSIONS.K8S.IO` (no İ), and the palette lists "Dili English olarak değiştir". Once Tasks 9–14 land, repeat for `de` (a tracked `ß` label shows `SS`) and `ja` (tracked section labels are not letter-spaced).
- [ ] **Step 4: Commit** `git commit -m "feat(i18n): registry-driven language pickers and CJK letter-spacing"`.

---

### Task 8: Contributor workflow, glossary doc and AGENTS rules

**Files:**
- Create: `docs/i18n/CONTRIBUTING.md`, `docs/i18n/GLOSSARY.md` (rendered from `scripts/i18n/glossary.json` by hand, with a note that the JSON is the source)
- Modify: `AGENTS.md:19-31`, `docs/ARCHITECTURE.md` (a new "Internationalization" section, and a fix to the stale line 12 catalog comment), `README.md:44`

**Interfaces:**
- Produces this contributor doc content:
  1. Everyday rule: EN + TR in the same change, `pnpm i18n:check -- --fix`, Turkish by hand.
  2. Draft locales: what `drafts.json` means, and why missing keys are allowed.
  3. Drafting new keys: the `export → translate → import` commands.
  4. Reviewing a locale: edit values, remove keys with `review`, graduate by switching `status` to `reviewed`.
  5. Adding a locale: a registry entry, `LOCALE_CODES`, the directory, drafting, checks.
  6. Plural forms, with an example object.
  7. Formatting helpers and when to use `compareIds`, `compareText` and `foldSearch`.
  8. Casing: the `lang="en"` identifier rule with examples from `KindList.tsx:73-77` and `AlertsPanel.tsx:183-187`; the CJK tracking rule; German length.
  9. The Rust strings policy (D12), with the follow-up list (`PodSecurityResult.notes`, `UpgradeSkipped.reason`).
  10. The release checklist line: `pnpm i18n:check -- --strict-drafts`.
- AGENTS.md i18n section: keep "Every user-visible string ships in English and Turkish in the same change". Add the registry, draft locales, the draft tool, `compareIds`/`foldSearch`, and the `lang="en"` identifier rule. The checks list is unchanged apart from `pnpm test`, if Task 1 added it.

- [ ] **Step 1: Write the docs and the AGENTS and ARCHITECTURE updates**.
- [ ] **Step 2: Verify**: run `pnpm i18n:check && pnpm test`. Expected: PASS. Every command in `CONTRIBUTING.md` runs as written on this branch (spot-check `export` and `review` against a temp copy).
- [ ] **Step 3: Commit** `git commit -m "docs(i18n): contributor workflow, glossary and AGENTS rules for N locales"`.

---

### Tasks 9–14: Draft catalogs, one locale per task

Each of these tasks has the same shape. Run them in this order, with these values:

| Task | code | Extra test added to `locales.test.ts` |
|---|---|---|
| 9 | `de` | `resolveLocale(['de-AT'])` → `'de'` |
| 10 | `es` | `resolveLocale(['es-MX'])` → `'es'` |
| 11 | `fr` | `resolveLocale(['fr-CA'])` → `'fr'`; `plural` for `0` picks the `one` form |
| 12 | `pt-BR` | `resolveLocale(['pt-PT'])` → `'pt-BR'`; `fallbackChain('pt-BR')` → `['pt-BR', 'en']` |
| 13 | `zh-CN` | `resolveLocale(['zh-Hans-CN'])` → `'zh-CN'`; `resolveLocale(['zh-TW', 'en'])` → `'en'` |
| 14 | `ja` | `resolveLocale(['zh-TW', 'ja'])` → `'ja'`; `plural` for `1` picks the `other` form |

**Files (per task):**
- Create: `apps/desktop/src/i18n/<code>/{shell,workbench,dock,drafts}.json`
- Modify: `apps/desktop/src/i18n/locales.json` (append the entry from Global Constraints), `apps/desktop/src/i18n/locales.ts` (append the code to `LOCALE_CODES`), `apps/desktop/src/i18n/locales.test.ts`

**Interfaces:**
- Consumes: the draft tool and glossary (Task 6), the checker (Task 5), the registry (Task 2).
- Produces: a complete, flagged draft. `pnpm i18n:check -- --coverage --locale=<code>` reports `translated == total` (3,897 entries today, or whatever `en` holds then), `reviewed == 0` and `drafts == total`.

- [ ] **Step 1: Add the registry entry and the locale test (the row above); run it to see the new expectations fail**

Run: `pnpm --filter @kubepit/desktop exec vitest run src/i18n/locales`
Expected: FAIL (the code is not registered yet in `LOCALE_CODES`, or the resolution test fails).

- [ ] **Step 2: Register the code and create empty catalogs**

Append the code to `LOCALE_CODES`. Create `{shell,workbench,dock}.json` as `{}` and `drafts.json` as `{"shell":[],"workbench":[],"dock":[]}`. Run the locale tests again and expect PASS.

- [ ] **Step 3: Export the work chunks**

Run: `pnpm i18n:drafts export --locale=<code> --size=150 --out=/tmp/kp-drafts-<code>` (use the session scratchpad instead of `/tmp` when available).
Expected: about 26 chunk files covering every key.

- [ ] **Step 4: Translate every chunk**

Follow each chunk's `rules` and `glossary`. Write `<chunk>.out.json` as an array of `{ area, key, text }` or `{ area, key, forms }`. Dispatch chunks to parallel subagents if useful, each receiving one chunk file and the rules verbatim.

- [ ] **Step 5: Import and check**

Run: `pnpm i18n:drafts import --locale=<code> /tmp/kp-drafts-<code>/*.out.json && pnpm i18n:check && pnpm i18n:check -- --coverage --locale=<code>`
Expected: zero rejected entries (fix and re-import any rejected ones), `i18n OK`, and coverage at 100% translated / 0% reviewed.

- [ ] **Step 6: Smoke test**

Run: `pnpm test && pnpm typecheck`. Expected: PASS.
Manual (`pnpm dev:ui`, switch to `<code>`): the status bar, the Settings categories, the Add cluster dialog, a cluster's Pods table with details, the Health view, the Helm deploy dialog, the command palette, and a narrow window (dock plus details panel). Look for overflow, and for Kubernetes nouns that stayed English as the glossary requires. Fix layout overflow with `truncate` plus `title`, or with container-query stacking, in the component. Never shorten the English source.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/i18n
git commit -m "feat(i18n): <endonym> (<code>) machine-drafted catalogs, flagged for review"
```

---

### Task 15: Final verification

**Files:** none new. This task confirms the whole branch.

- [ ] **Step 1: Run the six checks**: `pnpm typecheck && pnpm i18n:check && pnpm test && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`. Expected: all pass.
- [ ] **Step 2: Check coverage**: run `pnpm i18n:check -- --coverage && pnpm i18n:check -- --strict-drafts`. Expected: all eight locales at 100% translated; `en`/`tr` reviewed, the six others at 0% reviewed; strict mode passes.
- [ ] **Step 3: Check the bundle**: run `pnpm build`. Expected: the build succeeds, and `dist/assets` holds one chunk per non-English catalog file (for example `workbench-*.js` per locale). The entry chunk no longer contains Turkish strings (`grep -L "Yeniden denetle" dist/assets/index-*.js` lists the entry).
- [ ] **Step 4: Commit** any smoke-test fixes: `git commit -m "fix(i18n): layout fixes from the locale smoke pass"` (skip if there are none).
