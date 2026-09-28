# More languages: design

Status: draft for review · Date: 2026-09-28 · Plan: `docs/superpowers/plans/2026-09-28-more-languages.md`

## Problem

Kubepit ships English and Turkish, and the two are hard-coded throughout:

- `src/i18n/core.ts` has `Locale = 'en' | 'tr'`. `message()` only looks at `tr`,
  `getFormatLocale()` returns `tr-TR` or `en-US`, and both catalogs are imported eagerly.
- `scripts/check-i18n.mjs` loads exactly `en` and `tr`.
- Three language pickers are two-way:
  - `LanguageMenu.tsx` has a `LABELS` record.
  - The General settings `<select>` has literal options (`categories.tsx:66-79`).
  - The palette toggle has hard-coded, untranslated labels (`paletteItems.tsx:333-341`).
- Plurals only support the `one` and `other` categories.
- Some locale-sensitive code uses the *OS* locale instead of the app locale:
  - `toLocaleLowerCase()` with no argument in search (`sidebarSearch.ts:4-5`,
    `selectSearch.ts:14,17`)
  - `Intl.Collator(undefined)` (`tableModel.ts:39`, `savedViews.ts:40`)
- One grammar rule is Turkish-specific (`cron.ts:201-204`).

Size of the job: 3,897 catalog entries (3,658 unique keys), about 17,000 English words,
197 `plural()` call sites and 53 `lang="en"` identifier sites.

## Goals

1. Generalise i18n from two to N locales across the runtime, checker, pickers and docs.
2. Per-locale plural rules through `Intl.PluralRules`, keeping `i18n.plural(one, other,
   count)` at every call site.
3. Locale-aware date, number, currency and list formatting, with an identifier-stable
   collation and search folding.
4. Load catalogs lazily, one chunk per locale. Only English is bundled in the entry.
5. Locale fallback (`pt-BR` → `pt` → `en`), system-language detection over
   `navigator.languages`, and correct handling of script subtags (`zh-Hant` is **not**
   `zh-CN`).
6. Handle locale-sensitive casing: `lang` on `<html>`, the `lang="en"` identifier rule,
   German `ß`/`SS` and long words, the Turkish dotted and dotless i, and CJK letter-spacing.
7. A checker for N locales with a coverage report and a draft marker for machine-drafted
   strings.
8. A contributor workflow doc and a glossary.
9. Ship `de`, `es`, `fr`, `pt-BR`, `zh-CN` and `ja`.
10. A written policy for Rust-side user-visible strings.

## Non-goals

- Right-to-left layouts (no RTL locale is planned; noted for later).
- Translating Kubernetes data, kinds, API groups, YAML, logs, commands, CLI output or user
  content (unchanged rule).
- Translating backend error messages (see D11).
- A translation-management service integration (Weblate, Crowdin). The file formats stay
  compatible with one (flat JSON).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **One locale registry**, `src/i18n/locales.json`, read by both the runtime and the checker. Each entry has `code`, `name` (endonym), `short` (status-bar code), `format` (BCP 47 tag for Intl), `status` (`source`, `reviewed` or `draft`), `required`, and an optional `lowercaseDateNames`. `locales.ts` holds the `LOCALE_CODES` tuple for the `Locale` type, and a test keeps it equal to the JSON. | Adding a locale is one entry plus a catalog directory. No code change, and nothing can drift. |
| D2 | Catalogs stay **flat JSON per area**: `src/i18n/<code>/{shell,workbench,dock}.json`, English source strings as keys, ownership by path unchanged. | This is the existing model. Parallel work never conflicts, and TMS tools read it. |
| D3 | **Plural forms.** The value of the `one` key is a string. The value of the `other` key is either a string, used for every non-`one` category, or an object keyed by CLDR category (`zero`, `two`, `few`, `many`, `other`; `other` required). `plural()` picks the category with a cached `Intl.PluralRules(formatTag)`. For `one` it uses the `one` key; otherwise it uses the object's category, falling back to `other`. | No call site changes (197 sites). French and Portuguese `0` correctly select `one`, and Japanese and Chinese always select `other`. The format also covers future `few`/`many` languages such as Polish, Russian and Arabic. English and Turkish stay plain strings. |
| D4 | **Lazy catalogs.** English is imported statically: it is the fallback and the source of `MessageKey`. Other locales load through `import.meta.glob('./*/*.json')`, which gives one Vite chunk per file, merged per locale and cached. `setLocale(code)` becomes async: it loads the fallback chain first, then switches and notifies once. At boot, `main.tsx` awaits `initializeDesktopLocale()` before rendering, through a promise chain rather than top-level await (Vite's default build target lacks TLA). A failed load keeps the current locale and logs a warning. | The entry bundle carries one locale instead of N (about 275 KB per extra locale). Tauri loads chunks from local assets, so the delay is negligible, and no English flash appears at boot. |
| D5 | **Fallback and detection.** `fallbackChain(code)` returns `[code, base(code) if registered, 'en']`, and a missing key walks the chain per key. `resolveLocale(tags)` walks `navigator.languages` in order: exact match (case-insensitive, `_` becomes `-`), then the language maps `pt-*` → `pt-BR` and `de|es|fr|ja|tr-*` → base, then `zh-Hans*`, `zh-CN`, `zh-SG` or bare `zh` → `zh-CN`. `zh-Hant*`, `zh-TW`, `zh-HK` and `zh-MO` resolve to nothing, and the walk moves to the next tag. The final fallback is `en`. A saved `kp-locale` wins when it is registered, so legacy `en`/`tr` values keep working. | Simplified Chinese must not be forced on Traditional Chinese readers. English is the more neutral fallback. |
| D6 | **Formatting helpers** in `core.ts` use the registry's `format` tag and **cached** Intl objects (keyed by locale and options): `number`, `date`, `relative`, and the new `currency(value, code, opts?)`, `list(items, type?)`, `compareText(a, b)` (app-locale collator for translated labels), `compareIds(a, b)` (`Intl.Collator('en', { numeric: true, sensitivity: 'base' })` for Kubernetes names, so sort order is the same in every language) and `foldSearch(s)` (lowercase in the app locale, NFKD without combining marks, `ı`/`İ`/`I` all fold to `i`). `formatAge` stays kubectl-style (`45s`, `3h`) and untranslated on purpose. | Formatting follows the app language instead of the OS. Identifier order stays stable. A Turkish user typing `i` or `ı` finds both, and so does a German user. |
| D7 | **Casing.** `document.documentElement.lang` is the locale code, so CSS `uppercase` applies German `ß`→`SS` and Turkish `i`→`İ` in translated labels. The **identifier rule** is written down and unchanged: uppercase-styled identifiers (API groups, kinds, cluster and context names, level names, codes) carry `lang="en"`. A global rule removes letter-spacing from tracked labels in CJK (`html:lang(ja) [class*='tracking-']:not(:lang(en))`, the same for `zh`), so CJK labels are not spaced out while English identifiers inside keep their tracking. The Turkish-only sentence lowercasing in `cron.ts` becomes the registry flag `lowercaseDateNames`. | CJK has no case. Letter-spacing hurts CJK readability. Setting `lang` also makes the browser pick Japanese or Chinese Han glyphs correctly from `system-ui`. |
| D8 | **Checker for N locales** (`scripts/i18n/*.mjs` plus the `scripts/check-i18n.mjs` entry, no dependencies). **Failures:** missing or unused English keys; missing keys in `required` locales (`en`, `tr`); extra keys; placeholder mismatches in any locale or plural form; invalid plural categories; plural objects on non-plural keys; stale draft entries; catalog directories not in the registry. **Warnings:** the same key translated differently across areas in one locale (21 such keys exist in `tr` today, where the later area silently wins). **Report:** `--coverage` prints translated and reviewed percentages per locale, and `--coverage=json` does the same for CI. `--fix` adds English keys and removes unused, extra and stale entries from every locale. `--strict-drafts` also fails on missing keys in draft locales (used by the release checklist). Keys are sorted with `localeCompare(b, 'en')`, so sorting is the same on every machine. | Contributors keep the current workflow (EN + TR). Draft locales never block a change but stay visible. |
| D9 | **Draft marker**: a sidecar `src/i18n/<code>/drafts.json` (`{ "shell": [keys…], "workbench": […], "dock": […] }`) lists machine-drafted, unreviewed keys. A reviewer removes keys from the list, directly or with `pnpm i18n:drafts review`. Catalog values stay plain strings. | There is no runtime cost and no change to catalog shape. Reviews are easy to audit in diffs. An edited English source changes the key, so stale drafts disappear by themselves. |
| D10 | **Ship the six locales as complete, flagged drafts.** They are machine-drafted to 100% coverage, every key is listed in `drafts.json`, the registry status is `draft`, and the language menu shows a **Preview** badge. A locale graduates to `reviewed` once a native speaker empties its drafts list. | About 100,000 words across six locales, and the project has no native reviewers for them. Calling them "reviewed" would misrepresent their quality. A partial catalog would produce a mixed-language UI, which is worse than a consistent draft. Drafts give users value now and give reviewers a precise worklist. The badge sets expectations. |
| D11 | **Required locales stay English and Turkish.** AGENTS.md's "EN + TR in the same change" rule is unchanged. New keys in draft locales fall back to English until they are drafted (`pnpm i18n:drafts export/import`). The release checklist runs `pnpm i18n:check -- --strict-drafts`, so every release ships at 100% coverage. | Contributors are not asked to machine-translate six languages for every change. |
| D12 | **Rust-side strings.** Backend errors (about 450 `bail!`/`anyhow!`/`context` sites) stay **English and verbatim**, like Kubernetes, CLI and OS errors. They are diagnostic data that people search for. The backend never learns the UI language, and native shell text is just the brand name. New Kubepit-generated *explanations* (notes, warnings, validation findings) use **stable codes plus params** that the UI translates, following the existing pattern (custom-action import notes, deprecation note codes). Known exceptions, `PodSecurityResult.notes` and `UpgradeSkipped.reason`, are listed in the contributor doc as follow-ups. | This keeps one error vocabulary for support, avoids 450 translation sites, and matches what the UI already does. |
| D13 | **Glossary and do-not-translate list** (`scripts/i18n/glossary.json`, rendered in `docs/i18n/GLOSSARY.md`). Kubernetes nouns stay English in every locale, following the Turkish catalog's precedent (Cluster, Namespace, Pod, Node, Deployment, Service, Ingress, Secret, ConfigMap, Helm, kubeconfig, context, …). Preferred translations for about 40 recurring UI terms are listed per locale. The draft tool puts the glossary into every export chunk. | Terminology stays consistent across about 100 translation chunks and future reviewers. |

## Architecture

```
src/i18n/locales.json ──┬──▶ src/i18n/locales.ts (LOCALE_CODES, registry helpers)
                        └──▶ scripts/i18n/registry.mjs (checker, draft tool)

src/i18n/core.ts
  ├─ en catalogs (static)                 ├─ loadLocale(code) ← import.meta.glob('./*/*.json')
  ├─ registerCatalog(code, catalog)       ├─ fallbackChain(code), resolveLocale(tags)
  ├─ message/t/plural (chain + CLDR)      └─ number/date/relative/currency/list/compareText/compareIds/foldSearch (cached Intl)
src/i18n/index.tsx  (useLocale, rich, useLocaleMemo — unchanged API)
scripts/check-i18n.mjs → scripts/i18n/{registry,scan,io,check,report}.mjs
scripts/i18n-drafts.mjs  (export → translate → import, review)
```

## UX

- **Language menu** (status bar): the registry's endonyms, a wider code column (`pt-BR`,
  `zh-CN`), a translated **Preview** badge on draft locales, and the short code in the
  trigger. The General settings select and the palette ("Switch language to {language}",
  one item per locale, with endonyms as keywords) read the same registry.
- Switching language keeps drafts, terminals and streams, as today. There is a short
  load while the catalog chunk arrives, with no flash of English.
- Layout: German and French text is 20–35% longer. Components already use container
  queries and `truncate` with `title`. The plan's visual smoke pass covers the status bar,
  Settings, dialogs, the Health view and the tables at narrow widths in `de`, `fr` and
  `ja`, and fixes overflow where it shows up.

## Contract changes

None on the IPC boundary: the locale stays frontend-only in localStorage `kp-locale`.
`i18n` module API changes:

- `Locale` widens to the registry codes.
- `setLocale` returns `Promise<void>`.
- `initializeLocale` returns `Promise<() => void>`.
- New exports: `LOCALE_REGISTRY`, `fallbackChain`, `registerCatalog`, `loadLocale`,
  `currency`, `list`, `compareText`, `compareIds`, `foldSearch`.

## Security and safety

- Catalog values are never HTML. `t` stays non-recursive, and `rich` inserts React nodes.
  The draft importer rejects values with placeholders that do not exist in English.
- Tests never touch real clusters or user files. The i18n tests are pure: Vitest for
  `core.ts`, and `node:test` for the scripts over in-memory fixtures and temp dirs.
- No background work is involved.

## Testing strategy

- **Vitest:**
  - `resolveLocale` (including `zh-TW` → next tag, and `pt-PT` → `pt-BR`), `fallbackChain`
  - plural selection for en, tr, fr (0 is `one`), ja (always `other`) and a `many`
    object form
  - lazy load and switch notifying once
  - the formatter cache, `currency`, `list`, `compareIds` being stable across locales
  - `foldSearch` over Turkish letters
  - registry and `LOCALE_CODES` staying in sync
- **node:test** (`scripts/i18n/*.test.mjs`): every checker failure and warning code, the
  coverage numbers, `--fix` results, and the draft export/import round-trip including
  placeholder rejection.
- **Checker on the real repo:** `pnpm i18n:check` passes, and `--coverage` shows 100%
  translated for all eight locales and 0% reviewed for the six drafts.
- **Manual:** a `pnpm dev:ui` pass per locale over the listed screens, plus the Turkish
  casing check (`apiextensions.k8s.io` stays `APIEXTENSIONS.K8S.IO`) and a German `ß`
  label.

## Rollout

- The runtime generalisation, checker and draft tool land first, with no visible change.
- Each locale lands as its own commit with a registry entry marked `draft`.
- Docs: `docs/i18n/CONTRIBUTING.md` (adding a locale, drafting, reviewing, plurals,
  casing, Rust policy), `docs/i18n/GLOSSARY.md`, the AGENTS.md i18n section (N locales,
  EN+TR still mandatory, drafts), ARCHITECTURE, and the README ("English and Turkish,
  plus previews in six languages").

## Open questions

1. Should Preview locales be listed by default, or hidden behind "Show preview languages"
   in Settings?
2. Should the 21 conflicting Turkish duplicates become one translation per key (a checker
   failure), or stay warnings? The plan keeps them as warnings.
3. Should we add a pseudo-locale (`en-XA`, dev only) to catch truncation and hard-coded
   strings in CI screenshots?
4. Who are the first native reviewers, and should graduation need one reviewer or two?
