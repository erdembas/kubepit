# Working on Kubepit

Kubepit is a local-first Kubernetes IDE (Freelens-class) built on the RunHQ stack and
design system: Tauri 2 + Rust (`crates/kubepit-core`, `apps/desktop/src-tauri`) and
React 18 + Tailwind v4 + Zustand (`apps/desktop/src`). Read `docs/ARCHITECTURE.md` first.

## Contract

`apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` define every
frontend ⇄ backend command and shape. Change both sides in the same change.

## Design

The UI must stay visually identical to RunHQ: use the tokens in `src/styles/theme.css`,
the primitives in `src/components/ui/`, 11–13px UI text, uppercase tracked labels,
`bg-fg/N` hover pads and the accent strip for active rows. Do not add chart or UI
libraries; draw charts with SVG and tokens.

## Internationalization is mandatory

Every user-visible string ships in English and Turkish in the same change.

- `import * as i18n from '@/i18n'` in components (call `i18n.useLocale()`),
  `@/i18n/core` in pure helpers. English source strings are the keys.
- Use `i18n.t('Sentence with {name}', { name })`, `i18n.rich` for JSX placeholders and
  `i18n.plural(one, other, count)` for counts. Never concatenate translated fragments.
- Catalogs live in `src/i18n/{en,tr}/{shell,workbench,dock}.json`, owned by path (see
  `scripts/check-i18n.mjs`). Run `pnpm i18n:check -- --fix` to add English keys, then
  add the Turkish translations by hand. `pnpm i18n:check` must pass.
- Never translate Kubernetes data, kinds used as identifiers, YAML, logs, commands or
  user content.

## Safety

Never connect to real clusters from tests or scripts. `~/.kube` may hold production
credentials; tests use fixtures and `KUBEPIT_HOME` pointed at a temp dir.
Mutating backend commands must honour `ClusterDef.read_only`.

## Checks

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:ui        # Vitest: pure TS modules and stores (`*.test.ts` next to the code)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm dev:ui` runs the whole UI in a browser against the in-memory demo backend in
`src/lib/ipc/mock/`; keep it working when you add commands.
