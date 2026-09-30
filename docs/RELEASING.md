# Releasing Kubepit / Kubepit'i yayımlama

[English](#english) · [Türkçe](#türkçe)

## English

Version **0.0.1** is a source-first, experimental release. The website and browser
demo are a static GitHub Pages deployment; the desktop app is built locally from
source. Publishing the website or a Git tag does not produce signed desktop
installers. This document describes the actual workflows in the repository and
the separate work required for signed updates.

### 1. Verify the release candidate

Keep these versions aligned: root `package.json`, desktop and website
`package.json`, Tauri `tauri.conf.json`, both Rust packages' `Cargo.toml`, and the
two local package entries in `Cargo.lock`. The website consumes package metadata.
Update [CHANGELOG.md](../CHANGELOG.md) and both READMEs when the scope changes.

```bash
pnpm install --frozen-lockfile
pnpm check:version
pnpm typecheck
pnpm i18n:check
pnpm test:ui
pnpm test:site
pnpm perf:test
pnpm build:pages
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Tests use fixtures and temporary state, never real clusters or credentials.
`ci.yml` runs frontend/Pages checks and Rust checks for pull requests, `main`
pushes and `v*` tags. Tag builds also check that `vX.Y.Z` matches package metadata.
The existing performance workflows remain separate; timing budgets need runner
calibration and are not a published product benchmark.

Run `pnpm preview:pages` and inspect `http://127.0.0.1:4173/kubepit/`, both
languages, mobile layout, keyboard navigation and `/kubepit/demo/`. Verify demo
reload behavior and that no real credentials are requested. The combined export
is `apps/website/out/`, including the actual Vite mock frontend under `demo/` and
`.nojekyll`. `pnpm build:site` exports the website alone; use `build:pages` for the
complete public artifact.

### 2. Publish the site on GitHub Pages

The default URL is <https://erdembas.github.io/kubepit/>; no domain purchase or
application server is needed. Before the first deployment:

1. Ensure the intended `erdembas/kubepit` repository exists, verify the Git remote and GitHub authentication, and push the reviewed source to `main`.
2. In the repository, select **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Run the **GitHub Pages** workflow manually, or let a subsequent push to `main` trigger it.
4. Wait for both build and deployment jobs to succeed. Use the deployment job's environment URL to verify the live site and demo. A local successful build alone does not confirm publication.

[`pages.yml`](../.github/workflows/pages.yml) reads the Pages origin and base path,
checks versions, types, translations and site tests, exports Next.js and the fixture demo, and uploads
one Pages artifact. Deployment uses `pages: write` and `id-token: write`; no
personal token, cloud account or custom-domain secret is required. This is the
[GitHub Pages custom-workflow model](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

`NEXT_PUBLIC_BASE_PATH` defaults to `/kubepit`; set it to an empty string for a
root-hosted site or to a different project prefix. `NEXT_PUBLIC_SITE_ORIGIN` is the
origin used for site metadata. Pages supplies both during deployment. For a fork,
set matching values for local builds and review any hard-coded project/repository
links. The preview command should use the same base-path setting as the build.

```bash
NEXT_PUBLIC_BASE_PATH=/kubepit NEXT_PUBLIC_SITE_ORIGIN=https://erdembas.github.io pnpm build:pages
pnpm preview:pages
```

### 3. Tag the source release

After the reviewed release commit is on `main` and CI is green, verify that the
local checkout is that exact commit and `v0.0.1` does not already exist. Then:

```bash
git tag -a v0.0.1 -m "Kubepit v0.0.1"
git push origin v0.0.1
```

Create a GitHub release from the tag, use the English/Turkish 0.0.1 changelog as
notes, and clearly label it experimental and source-first. Choose GitHub's
pre-release flag for this initial experimental release. GitHub supplies source
archives; no installer-building release workflow is included. Attach binaries
only after platform builds and smoke tests have actually completed, with their
signing status stated explicitly. Never invent download links for future assets.

### 4. Build and verify desktop packages separately

`pnpm tauri:build` builds the native target on a machine with its Tauri platform
prerequisites. `pnpm tauri:build:local` is the local app-bundle command. Record the
OS/architecture, commit, build command and smoke-test outcome for each distributed
artifact. Do not infer cross-platform validation from browser CI or one host build.

The committed macOS configuration uses ad-hoc signing (`signingIdentity: "-"`).
That is not Developer ID signing or notarization. Windows code signing and macOS
notarization require their own release setup. Updater signing does not replace
either of them. Do not ask users to disable platform security as an installation
strategy.

### 5. Signed automatic updates: separate, not enabled in 0.0.1

The Tauri updater registers only if the bundled `plugins.updater.pubkey` is
non-empty and all endpoints use HTTPS. The committed public key is empty, so
update checks/install commands refuse and the UI reports that updates are not
configured. With a valid configuration, the main window can check once after
startup when `auto_check_updates` is enabled; download/install requires user action.

To introduce signed releases later:

1. Generate a signing pair on a trusted machine with `pnpm --filter @kubepit/desktop tauri signer generate -w ~/.tauri/kubepit.key`. Keep the private key/password outside the repository and store recoverable backups.
2. Put the **public key content**, not its path, in the bundled `plugins.updater.pubkey` (or a release-only Tauri config override).
3. Configure protected build secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Enable `bundle.createUpdaterArtifacts` only where those secrets are available.
4. Build and test each actual platform artifact, publish its signature, and generate `latest.json` with the exact version and platform-specific URLs/signature contents.
5. Publish only after testing an update from a previously installed build. Keep release notes and feed notes aligned. Never print signing secrets in logs.

The configured future feed is
`https://github.com/erdembas/kubepit/releases/latest/download/latest.json`.
GitHub's `latest` route excludes drafts and prereleases. Do not expect the initial
source prerelease to activate it. Losing the signing private key breaks continuity
for installed clients; changing the key requires a deliberate migration/manual
installation plan. Linux self-updating is an AppImage path; package-manager formats
need their own upgrade path.

## Türkçe

**0.0.1**, kaynak koddan kullanıma odaklanan deneysel bir sürümdür. Web sitesi ve
tarayıcı demosu GitHub Pages'e statik olarak yayımlanır; masaüstü uygulaması kaynak
koddan yerelde derlenir. Siteyi veya Git etiketini yayımlamak imzalı masaüstü
kurulum paketi üretmez. Bu belge depodaki gerçek iş akışlarını ve imzalı
güncellemeler için ayrıca yapılması gerekenleri anlatır.

### 1. Sürüm adayını doğrulayın

Kök `package.json`, masaüstü ve site `package.json` dosyaları, Tauri
`tauri.conf.json`, iki Rust paketinin `Cargo.toml` dosyaları ve `Cargo.lock`
içindeki iki yerel paket sürümü aynı olmalıdır. Site sürümü paket bilgisinden
alır. Kapsam değiştiğinde [CHANGELOG.md](../CHANGELOG.md) ve iki README'yi güncelleyin.

```bash
pnpm install --frozen-lockfile
pnpm check:version
pnpm typecheck
pnpm i18n:check
pnpm test:ui
pnpm test:site
pnpm perf:test
pnpm build:pages
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Testler gerçek küme ve kimlik bilgisi yerine örnek veri ve geçici durum kullanır.
`ci.yml`; pull request, `main` push ve `v*` etiketlerinde arayüz/Pages ve Rust
kontrollerini çalıştırır. Etiket kontrolü `vX.Y.Z` ile paket sürümlerini de eşler.
Mevcut performans iş akışları ayrıdır; süre bütçelerinin runner üzerinde kalibre
edilmesi gerekir ve bunlar yayımlanmış ürün benchmark'ı değildir.

`pnpm preview:pages` çalıştırıp `http://127.0.0.1:4173/kubepit/` adresini, iki dili,
mobil düzeni, klavye kullanımını ve `/kubepit/demo/` yolunu inceleyin. Demo yenileme
davranışını ve gerçek kimlik bilgisi istenmediğini doğrulayın. Birleşik çıktı
`apps/website/out/` dizinidir; gerçek Vite demo arayüzünü `demo/` altında ve
`.nojekyll` dosyasını içerir. `pnpm build:site` yalnızca siteyi üretir; eksiksiz
herkese açık çıktı için `build:pages` kullanın.

### 2. Siteyi GitHub Pages'e yayımlayın

Varsayılan adres <https://erdembas.github.io/kubepit/>; alan adı satın almak veya
uygulama sunucusu kurmak gerekmez. İlk dağıtımdan önce:

1. Hedef `erdembas/kubepit` deposunun varlığını, Git remote'unu ve GitHub oturumunu doğrulayın; incelenmiş kaynağı `main` dalına gönderin.
2. Depoda **Settings → Pages → Build and deployment → Source → GitHub Actions** seçin.
3. **GitHub Pages** iş akışını elle çalıştırın veya sonraki `main` push işleminin tetiklemesini bekleyin.
4. Derleme ve dağıtım işlerinin ikisinin de başarılı olmasını bekleyin. Dağıtım işinin ortam adresinden canlı siteyi ve demoyu kontrol edin. Yerelde başarılı derleme, yayının tamamlandığını doğrulamaz.

[`pages.yml`](../.github/workflows/pages.yml), Pages adresini ve temel yolunu okur;
sürümü, tipleri, çevirileri ve site testlerini denetler, Next.js ile örnek veri demosunu üretir ve tek
Pages çıktısı yükler. Dağıtımda `pages: write` ve `id-token: write` izinleri
kullanılır; kişisel token, bulut hesabı veya özel alan adı sırrı gerekmez. Ayrıntılar
[GitHub Pages özel iş akışı belgesindedir](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

`NEXT_PUBLIC_BASE_PATH` varsayılan olarak `/kubepit` olur; kök adres için boş,
başka proje için ilgili ön eki verin. `NEXT_PUBLIC_SITE_ORIGIN`, site üst verisinde
kullanılan origin adresidir. Dağıtımda ikisini de Pages sağlar. Fork için yerel
derleme değerlerini ayarlayın ve sabit proje/depo bağlantılarını inceleyin.
Önizleme komutu derlemeyle aynı temel yol ayarını kullanmalıdır.

```bash
NEXT_PUBLIC_BASE_PATH=/kubepit NEXT_PUBLIC_SITE_ORIGIN=https://erdembas.github.io pnpm build:pages
pnpm preview:pages
```

### 3. Kaynak sürümünü etiketleyin

İncelenen sürüm commit'i `main` dalına geldikten ve CI başarılı olduktan sonra
yerel checkout'un tam olarak o commit olduğunu ve `v0.0.1` etiketinin henüz
bulunmadığını doğrulayın. Ardından:

```bash
git tag -a v0.0.1 -m "Kubepit v0.0.1"
git push origin v0.0.1
```

Etiketten GitHub release oluşturun; İngilizce/Türkçe 0.0.1 değişiklik günlüğünü not
olarak kullanın, deneysel olduğunu ve başlangıcın kaynak koddan olduğunu belirtin.
İlk deneysel sürümde GitHub'ın pre-release seçeneğini işaretleyin. GitHub kaynak
arşivlerini sağlar; kurulum paketi üreten release iş akışı eklenmemiştir. İkili
paketleri ancak ilgili platformda derleme ve temel çalışma testleri tamamlandıktan
sonra, imza durumunu açıkça belirterek ekleyin. Gelecekteki dosyalar için indirme
bağlantısı uydurmayın.

### 4. Masaüstü paketlerini ayrıca derleyip doğrulayın

`pnpm tauri:build`, Tauri ön koşulları kurulu makinede yerel hedefi derler.
`pnpm tauri:build:local` yerel app-bundle komutudur. Dağıtılan her paket için işletim
sistemi/mimari, commit, derleme komutu ve temel çalışma testi sonucunu kaydedin.
Tarayıcı CI sonucundan veya tek makine derlemesinden tüm platformların doğrulandığı
sonucunu çıkarmayın.

Depodaki macOS ayarı ad-hoc imzalama kullanır (`signingIdentity: "-"`); bu Developer
ID imzası veya noter onayı değildir. Windows kod imzası ve macOS noter onayı kendi
yayın kurulumlarını gerektirir. Güncelleme imzası bunların yerine geçmez. Kurulum
yöntemi olarak kullanıcılardan platform güvenliğini kapatmalarını istemeyin.

### 5. İmzalı otomatik güncelleme: ayrı bir iş, 0.0.1'de açık değil

Tauri güncelleyicisi yalnızca paketlenmiş `plugins.updater.pubkey` doluysa ve tüm
uç noktalar HTTPS kullanıyorsa kaydedilir. Depodaki açık anahtar boştur; kontrol ve
kurulum komutları reddedilir, arayüz güncellemenin yapılandırılmadığını gösterir.
Geçerli ayarda, `auto_check_updates` açıksa ana pencere başlangıçtan sonra bir kez
kontrol edebilir; indirme/kurulum kullanıcı eylemi gerektirir.

İleride imzalı sürümler eklemek için:

1. Güvenilir bir makinede `pnpm --filter @kubepit/desktop tauri signer generate -w ~/.tauri/kubepit.key` ile anahtar çifti üretin. Özel anahtar ve parolayı depo dışında tutup kurtarılabilir yedek alın.
2. Anahtarın yolunu değil **açık anahtar içeriğini**, paketlenen `plugins.updater.pubkey` alanına veya release'e özel Tauri ayarına koyun.
3. Korumalı derleme sırları `TAURI_SIGNING_PRIVATE_KEY` ve `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` değerlerini ayarlayın. `bundle.createUpdaterArtifacts` seçeneğini yalnızca bu sırların bulunduğu ortamlarda açın.
4. Gerçek platform çıktılarını derleyip test edin, imzalarını yayımlayın; doğru sürüm, platform URL'leri ve imza içerikleriyle `latest.json` üretin.
5. Önceden kurulu bir sürümden güncelleme testini yaptıktan sonra yayımlayın. Release notları ile akış notlarını eş tutun. İmzalama sırlarını loglara yazdırmayın.

Gelecek güncelleme akışı
`https://github.com/erdembas/kubepit/releases/latest/download/latest.json` olarak
ayarlıdır. GitHub `latest` yolu taslakları ve ön sürümleri dışarıda bırakır. İlk
kaynak ön sürümünün bunu etkinleştirmesini beklemeyin. Özel anahtarın kaybı kurulu
istemcilerin güncelleme devamlılığını bozar; anahtar değişikliği bilinçli bir geçiş
veya elle kurulum planı gerektirir. Linux'ta kendini güncelleme AppImage yoludur;
paket yöneticisi biçimleri kendi yükseltme yolunu gerektirir.
