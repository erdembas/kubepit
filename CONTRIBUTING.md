# Contributing to Kubepit / Kubepit'e katkı

[English](#english) · [Türkçe](#türkçe)

## English

Kubepit is an MIT-licensed community project. Contributions to the desktop app,
website, accessibility, translations, documentation and platform testing are
welcome. Read [Architecture](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) before
changing code.

### Start locally

Use Node.js 22+, pnpm 9.14.4 and, for Rust/desktop work, Rust stable (1.89+) plus
[Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install --frozen-lockfile
pnpm dev:ui
```

`dev:ui` uses synthetic data and the in-memory backend. It is the easiest way to
work on the interface. Use `pnpm dev` for the native app, `pnpm dev:site` for the
website and `pnpm build:pages` followed by `pnpm preview:pages` for the combined
static website and demo at `http://127.0.0.1:4173/kubepit/`.

### Keep the product coherent

- Change the TypeScript contract (`apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts`), Rust implementation and mock backend together when adding or changing IPC.
- Reuse the theme tokens and UI primitives. Keep the RunHQ visual language, compact typography, keyboard access and responsive layouts. Do not add a chart or UI library.
- Ship every app-owned string in English and Turkish. Components use `@/i18n` and `i18n.useLocale()`; pure helpers use `@/i18n/core`. Use placeholders and plural helpers, never translated fragments. Run `pnpm i18n:check -- --fix`, then write the Turkish translations. Website copy also needs both languages and its own `pnpm test:site` checks.
- Never translate Kubernetes identifiers, kinds, YAML, logs, commands or user content.
- Enforce `ClusterDef.read_only` in mutating backend commands. Keep RBAC, review and confirmation behavior intact.
- Document dependencies and limitations alongside new integrations. Do not advertise planned features as shipped, or estimates as measurements.

### Use fixtures, never real clusters

Tests and scripts must not connect to real Kubernetes clusters or read production
credentials. Do not use your normal `~/.kube` or `~/.kubepit` for test setup. Set
`KUBEPIT_HOME` to a temporary directory and use the injected fixture roots, fake API
server and in-memory credential store. Setting `KUBEPIT_HOME` alone does not isolate
kubeconfig discovery; tests must also control their discovery roots.

The AI live evaluation is excluded from normal checks. It requires a deliberate
opt-in, uses synthetic fixtures and can incur provider charges; see Architecture.
Never enable remote AI or live cluster access to make an automated test pass.

### Validate and open a pull request

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:ui
pnpm test:site
pnpm check:version
pnpm build:pages
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Keep changes focused. Explain the user-visible problem and resulting behavior,
record relevant checks and include screenshots for visual changes. Add meaningful
regression coverage for behavioral fixes; avoid tests that only repeat the
implementation. Do not commit secrets, local kubeconfigs, build artifacts or logs
from a real cluster.

For bugs, include the version/commit, OS, reproduction steps, expected and actual
behavior, and a sanitized fixture when possible. State whether the browser demo
reproduces the issue. Report vulnerabilities using [SECURITY.md](SECURITY.md), not
a public issue with sensitive details. Contributions are distributed under the
repository's [MIT license](LICENSE).

## Türkçe

Kubepit, MIT lisanslı bir topluluk projesidir. Masaüstü uygulaması, web sitesi,
erişilebilirlik, çeviri, belge ve platform testlerine katkılarınızı bekliyoruz.
Kod değiştirmeden önce [Mimari](docs/ARCHITECTURE.md) ve [AGENTS.md](AGENTS.md)
belgelerini okuyun.

### Yerelde başlayın

Node.js 22+, pnpm 9.14.4; Rust/masaüstü çalışmaları için Rust stable (1.89+) ve
[Tauri platform ön koşulları](https://v2.tauri.app/start/prerequisites/) gerekir.

```bash
pnpm install --frozen-lockfile
pnpm dev:ui
```

`dev:ui`, örnek veri ve bellekte çalışan arka uç kullanır; arayüz geliştirmek için
en kolay başlangıçtır. Yerel uygulama için `pnpm dev`, site için `pnpm dev:site`,
birleşik statik site ve demo için önce `pnpm build:pages`, sonra
`pnpm preview:pages` kullanın. Önizleme adresi `http://127.0.0.1:4173/kubepit/` olur.

### Ürünün tutarlılığını koruyun

- IPC eklerken veya değiştirirken TypeScript sözleşmesini (`apps/desktop/src/types/index.ts` ve `apps/desktop/src/lib/ipc.ts`), Rust uygulamasını ve demo arka ucunu birlikte güncelleyin.
- Tema token'larını ve mevcut arayüz bileşenlerini kullanın. RunHQ görsel dilini, kompakt tipografiyi, klavye erişimini ve uyarlanabilir düzeni koruyun. Grafik veya arayüz kütüphanesi eklemeyin.
- Uygulamanın kendi metinlerini İngilizce ve Türkçe birlikte sunun. Bileşenlerde `@/i18n` ve `i18n.useLocale()`, saf yardımcı işlevlerde `@/i18n/core` kullanın. Çevrilmiş parçaları birleştirmek yerine yer tutucuları ve çoğul yardımcılarını kullanın. `pnpm i18n:check -- --fix` çalıştırıp Türkçe çevirileri yazın. Site metinleri de iki dilde olmalı ve `pnpm test:site` kontrollerini geçmelidir.
- Kubernetes tanımlayıcılarını, kind adlarını, YAML'ı, logları, komutları ve kullanıcı içeriğini çevirmeyin.
- Değişiklik yapan arka uç komutlarında `ClusterDef.read_only` denetimini uygulayın. RBAC, inceleme ve onay davranışını koruyun.
- Yeni entegrasyonların gereksinimlerini ve sınırlarını belgeleyin. Planlanan özellikleri bitmiş, tahminleri ölçüm gibi sunmayın.

### Gerçek küme yerine örnek veri kullanın

Testler ve betikler gerçek Kubernetes kümelerine bağlanmamalı, üretim kimlik
bilgilerini okumamalıdır. Test kurulumu için normal `~/.kube` veya `~/.kubepit`
dizinlerinizi kullanmayın. `KUBEPIT_HOME` değerini geçici dizine ayarlayın; test
keşif köklerini, sahte API sunucusunu ve bellek içi kimlik deposunu kullanın.
`KUBEPIT_HOME` tek başına kubeconfig keşfini yalıtmaz; keşif kökleri de test
kontrolünde olmalıdır.

Canlı yapay zekâ değerlendirmesi normal kontrollerin dışındadır. Bilinçli onay
ister, örnek veri kullanır ve sağlayıcı ücreti doğurabilir; ayrıntılar Mimari
belgesindedir. Otomatik testi geçirmek için uzak yapay zekâ veya gerçek küme
erişimini açmayın.

### Doğrulayın ve pull request açın

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:ui
pnpm test:site
pnpm check:version
pnpm build:pages
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Değişiklikleri odaklı tutun. Kullanıcının yaşadığı sorunu ve yeni davranışı
anlatın; ilgili kontrolleri belirtin, görsel değişikliklere ekran görüntüsü ekleyin.
Davranış düzeltmelerine anlamlı regresyon testleri ekleyin; yalnızca uygulamayı
tekrarlayan testlerden kaçının. Gizli bilgileri, yerel kubeconfig'leri, derleme
çıktılarını veya gerçek küme loglarını commit etmeyin.

Hata bildiriminde sürüm/commit, işletim sistemi, tekrar adımları, beklenen ve
mevcut davranış ile mümkünse hassas verilerden arındırılmış bir örnek paylaşın.
Sorunun tarayıcı demosunda tekrarlanıp tekrarlanmadığını belirtin. Güvenlik açığını
hassas ayrıntılarla herkese açık issue'ya yazmak yerine [SECURITY.md](SECURITY.md)
yolunu izleyin. Katkılar deponun [MIT lisansı](LICENSE) altında dağıtılır.
