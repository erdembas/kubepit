# Releasing Kubepit / Kubepit'i yayımlama

[English](#english) · [Türkçe](#türkçe)

## English

Version **0.0.2** is experimental. GitHub Actions builds desktop packages from an
immutable version tag, publishes their checksums and manifest, and refreshes the
static GitHub Pages website. The Homebrew tap tracks verified releases every six
hours. New releases require signed updater artifacts and notarized macOS packages.

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
pnpm test:release
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

### 3. Build and publish desktop packages

For a **new** version, update the eight package/version entries, verify CI, and push
an annotated `vX.Y.Z` tag. [`release.yml`](../.github/workflows/release.yml) runs on
`v*` pushes. Never move or recreate an existing release tag.

The existing **v0.0.1** tag points to `10b88447a380279844373eb04a04faf689088246`.
Packaging was added afterward. To package this exact source with the current
reviewed workflow, use the manual dispatch:

```bash
gh workflow run release.yml --ref main -f ref=v0.0.1 -F publish=true -F prerelease=true
```

Use `publish=false` for build-only verification. For an existing release its
pre-release flag is preserved. For a new release, choose the flag deliberately;
0.0.1 is experimental. The workflow checks out automation and tagged application
source separately, verifies all version entries, and records both commits.

| Build target  | Runner                        | Packages           |
| ------------- | ----------------------------- | ------------------ |
| macOS ARM64   | macos-14                      | DMG                |
| macOS x64     | macos-14, Rust cross-target   | DMG                |
| Linux x64     | ubuntu-22.04                  | AppImage, DEB, RPM |
| Linux ARM64   | ubuntu-22.04-arm              | AppImage, DEB, RPM |
| Windows x64   | windows-2022                  | NSIS EXE, MSI      |
| Windows ARM64 | windows-2022, ARM64 C++ tools | NSIS EXE           |

The frozen pnpm/Cargo lockfiles are used. Builds isolate application state and
kubeconfig in runner temp storage; they do not connect to clusters. The release
config enables signed updater artifacts, sets macOS 11 minimum and offers English and
Turkish NSIS installer languages. Packages keep architecture-specific names,
such as `Kubepit_0.0.1_linux_arm64.AppImage`.

Every target must succeed before publication. Checks cover package magic,
architecture where inspectable, native package metadata, macOS bundle version and
signature, configured Windows signatures, and SHA-256 hashes. These are packaging
checks, **not interactive smoke tests on all target machines**. Test installed app
startup, kubeconfig import with fixtures and core workflows on target hardware
before treating a platform as runtime-certified.

The publisher assembles **11 installers**, two macOS update archives, eleven
signature sidecars, `latest.json`, `SHA256SUMS`, `kubepit.rb`, and
`release-manifest.json` (28 assets). It rechecks the source tag, verifies uploaded bytes and
uploads the manifest last as the completeness marker. Already published bytes
are never replaced. If publication is interrupted, rerun the failed publish job
using the same build artifacts; a complete rebuild may produce different bytes
and will correctly fail collision checks. Changed distributed binaries need a
new version. Keep the complete release artifact while investigating failures.

### 4. Signing, Homebrew and automatic website links

The historical v0.0.1 macOS packages use ad-hoc signatures. From v0.0.2, missing
Apple or updater credentials stop the release: macOS must be Developer ID signed
and notarized, and every update artifact must have a valid updater signature.
Windows Authenticode remains optional; an updater signature does not provide
Windows publisher trust. The cask never removes quarantine or bypasses OS checks.

For protected production releases, configure repository Actions secrets:

| Platform             | Required secrets                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------- |
| macOS Developer ID   | `APPLE_CERTIFICATE` (base64 P12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` |
| macOS notarization   | Above plus `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`                  |
| Windows Authenticode | `WINDOWS_CERTIFICATE` (base64 PFX), `WINDOWS_CERTIFICATE_PASSWORD`                       |
| Signed app updates   | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                        |

Incomplete signing configuration fails the build. Temporary signing material is
removed after use. No private signing key belongs in Git or logs. Platform
signing and updater signing are separate systems.

The public [Homebrew tap](https://github.com/erdembas/homebrew-tap) owns its
verification workflow and updater helper. Every six hours, or on manual dispatch,
it validates public release metadata, checksums and the exact generated cask.
Only a verified change to `Casks/kubepit.rb` can be committed by the bot. It supports
Apple Silicon and Intel. The tap uses its own `GITHUB_TOKEN`; only its update job
has write permission. Kubepit needs no cross-repository PAT. Unchanged releases
produce no commit, and the workflow cannot stage other paths.

The initial pre-release is eligible while no complete stable release exists.
Once stable releases exist, the helper selects the newest complete stable release.
Existing RunHQ cask maintenance is independent.

```bash
brew install --cask erdembas/tap/kubepit
brew update
brew upgrade --cask kubepit
```

Pages runs `pnpm sync:releases` before exporting. It fetches public release assets
through GitHub's API, checks the manifest against actual uploaded assets and
`SHA256SUMS`, and embeds a validated snapshot. Use
`pnpm sync:releases -- --required` for a check that must find packages. The release
workflow explicitly dispatches Pages after publication; scheduled Pages builds
also pick up tap updates. GitHub's default token does not trigger other workflows
through a release event alone.

The browser can refresh from the public API, but CORS/rate limits are not required
for installation links: validated bundled data is the fallback. Drafts, missing
assets, mismatched hashes and source-only releases do not generate download
buttons. Stable and pre-release channels stay distinct. Homebrew appears only
when the actual tap file matches the generated cask hash. Links use versioned
release URLs, never guessed `/latest` installer names.

### 5. Signed automatic updates

The bundled public key enables the Tauri updater. The main window checks after
startup and every five minutes when `auto_check_updates` is enabled. Checks never
overlap installation. A dismissible announcement shows the new version and release
notes without repeating the same announcement; download/install and restart remain
explicit user actions. Settings → About & Updates also offers manual checks.

The feed is `https://erdembas.github.io/kubepit/updates/latest.json`. Pages copies
it only after verifying its hash, exact artifact URLs, complete platform set,
signature sidecars and the trusted public key. A complete stable signed release
wins; until one exists, a complete signed prerelease is eligible. A failed feed
refresh fails deployment, preserving the previously deployed site and feed.

Keep the existing private key and password outside Git with owner-only access and
recoverable backups. CI consumes `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; only the public key is committed. Losing or
replacing the private key breaks installed clients' update continuity. Local
signed builds also require these environment variables. For an unsigned local
development bundle use a Tauri config override with `createUpdaterArtifacts:false`.

v0.0.1 contains no updater public key. Users must install v0.0.2 manually once;
later signed releases can update in-app. Linux updates preserve AppImage, DEB or
RPM format; DEB/RPM installation invokes the native package manager and may request
administrator permission. The first enabled release establishes update
trust; test an installed-to-new-version update on each target before claiming
end-to-end update certification.

## Türkçe

**0.0.2** deneyseldir. GitHub Actions, sabit sürüm etiketinden masaüstü paketlerini
derler; sağlama toplamları ve bildirimini yayımlar, statik GitHub Pages sitesini
yeniler. Homebrew tap doğrulanan sürümleri altı saatte bir izler. Yeni yayınlarda
imzalı güncelleme paketleri ve macOS için Apple noter onayı zorunludur.

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
pnpm test:release
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

### 3. Masaüstü paketlerini derleyip yayımlayın

**Yeni** sürüm için sekiz paket/sürüm kaydını güncelleyin, CI sonucunu doğrulayın
ve açıklamalı `vX.Y.Z` etiketi gönderin.
[`release.yml`](../.github/workflows/release.yml), `v*` etiketlerinde çalışır.
Mevcut sürüm etiketini taşımayın veya yeniden oluşturmayın.

Mevcut **v0.0.1** etiketi `10b88447a380279844373eb04a04faf689088246` commit'ini
gösterir. Paketleme sonradan eklendi. Tam olarak bu kaynağı güncel ve incelenmiş
iş akışıyla derlemek için elle başlatın:

```bash
gh workflow run release.yml --ref main -f ref=v0.0.1 -F publish=true -F prerelease=true
```

Yalnızca derleme doğrulaması için `publish=false` verin. Mevcut sürümün ön sürüm
bayrağı korunur. Yeni sürümde bayrağı bilinçli seçin; 0.0.1 deneyseldir. İş akışı,
otomasyonu ve etiketlenmiş uygulama kaynağını ayrı checkout eder; tüm sürüm
kayıtlarını denetler ve her iki commit'i kaydeder.

| Derleme hedefi | Runner                           | Paketler           |
| -------------- | -------------------------------- | ------------------ |
| macOS ARM64    | macos-14                         | DMG                |
| macOS x64      | macos-14, Rust çapraz hedefi     | DMG                |
| Linux x64      | ubuntu-22.04                     | AppImage, DEB, RPM |
| Linux ARM64    | ubuntu-22.04-arm                 | AppImage, DEB, RPM |
| Windows x64    | windows-2022                     | NSIS EXE, MSI      |
| Windows ARM64  | windows-2022, ARM64 C++ araçları | NSIS EXE           |

Sabit pnpm/Cargo kilit dosyaları kullanılır. Derlemeler uygulama durumunu ve
kubeconfig'i runner'ın geçici dizininde yalıtır; kümelere bağlanmaz. Yayın ayarı
imzalı güncelleyici çıktılarını açar, macOS alt sınırını 11 yapar ve NSIS kurulumunda
İngilizce/Türkçe sunar. Dosya adları mimariyi belirtir; örneğin
`Kubepit_0.0.1_linux_arm64.AppImage`.

Yayımdan önce tüm hedefler başarılı olmalıdır. Denetimler; paket yapısını,
incelenebilen mimariyi, yerel paket üst verisini, macOS uygulama sürümü ve imzasını,
yapılandırılmış Windows imzasını ve SHA-256 sağlama toplamlarını kapsar. Bunlar
paketleme kontrolleridir; **tüm hedef makinelerde etkileşimli çalışma testi
değildir**. Bir platformun çalışma davranışını doğrulanmış saymadan önce hedef
donanımda uygulama açılışını, örnek kubeconfig içe aktarımını ve temel iş akışlarını
test edin.

Yayıncı **11 kurulum paketini**, iki macOS güncelleme arşivini, on bir imza dosyasını,
`latest.json`, `SHA256SUMS`, `kubepit.rb` ve `release-manifest.json` dosyalarını
birleştirir (28 dosya). Kaynak etiketini tekrar kontrol
eder, yüklenen baytları doğrular ve eksiksizlik işareti olarak bildirimi en son
yükler. Yayımlanmış baytlar değiştirilmez. Yayın kesilirse aynı derleme çıktılarıyla
başarısız publish işini yeniden çalıştırın; tüm paketleri yeniden derlemek farklı
baytlar üretebilir ve çakışma denetimi haklı olarak reddeder. Dağıtılmış ikili
dosyaların değişmesi yeni sürüm gerektirir. Sorunu araştırırken birleşik yayın
çıktısını saklayın.

### 4. İmzalama, Homebrew ve otomatik site bağlantıları

Eski v0.0.1 macOS paketleri ad-hoc imzalıdır. v0.0.2’den itibaren eksik Apple veya
güncelleyici sırları yayını durdurur: macOS Developer ID imzalı ve noter onaylı,
tüm güncelleme dosyaları geçerli güncelleyici imzalı olmalıdır. Windows Authenticode
isteğe bağlıdır; güncelleyici imzası Windows yayıncı güveni sağlamaz. Cask,
karantinayı kaldırmaz ve işletim sistemi kontrollerini atlatmaz.

Korumalı üretim yayınları için depo Actions sırlarını yapılandırın:

| Platform                     | Gereken sırlar                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| macOS Developer ID           | `APPLE_CERTIFICATE` (base64 P12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` |
| macOS noter onayı            | Yukarıdakilere ek olarak `APPLE_ID`, `APPLE_PASSWORD` (uygulamaya özel), `APPLE_TEAM_ID` |
| Windows Authenticode         | `WINDOWS_CERTIFICATE` (base64 PFX), `WINDOWS_CERTIFICATE_PASSWORD`                       |
| İmzalı uygulama güncellemesi | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                        |

Eksik imzalama ayarı derlemeyi durdurur. Geçici imzalama malzemesi iş bitince
kaldırılır. Özel anahtarlar Git'e veya loglara konmaz. Platform ve güncelleyici
imzalama birbirinden ayrıdır.

Herkese açık [Homebrew tap](https://github.com/erdembas/homebrew-tap), kendi
doğrulama iş akışını ve güncelleme yardımcısını barındırır. Altı saatte bir veya elle
tetiklendiğinde sürüm bilgilerini, sağlama toplamlarını ve üretilmiş cask’ı doğrular.
Bot yalnızca doğrulanmış `Casks/kubepit.rb` değişikliğini commit edebilir. Apple
Silicon ve Intel desteklenir. Tap kendi `GITHUB_TOKEN` değerini kullanır; yalnızca
güncelleme işi yazma yetkilidir. Kubepit deposunda başka depoya erişen PAT gerekmez.
Değişiklik yoksa commit üretilmez; iş akışı başka dosyaları hazırlama alanına alamaz.

Eksiksiz kararlı sürüm yoksa ilk ön sürüm kapsama dâhildir. Kararlı sürümler
bulunduğunda yardımcı en yeni eksiksiz kararlı sürümü seçer. RunHQ cask bakımı
bağımsızdır.

```bash
brew install --cask erdembas/tap/kubepit
brew update
brew upgrade --cask kubepit
```

Pages, dışa aktarımdan önce `pnpm sync:releases` çalıştırır. Herkese açık sürüm
dosyalarını GitHub API üzerinden alır, bildirimi gerçek yüklenen dosyalar ve
`SHA256SUMS` ile eşler, doğrulanmış kayıtlı veriyi siteye ekler. Paket bulunmasını
zorunlu kılan kontrol için `pnpm sync:releases -- --required` kullanın. Yayın iş
akışı yayın tamamlanınca Pages'i açıkça tetikler; zamanlanmış Pages derlemeleri tap
güncellemelerini de alır. GitHub'ın varsayılan token'ıyla oluşturulan release olayı
tek başına diğer iş akışlarını tetiklemez.

Tarayıcı herkese açık API'den yenileyebilir; CORS/hız sınırları indirme bağlantıları
için zorunlu değildir: siteye gömülü doğrulanmış veri yedek kaynaktır. Taslaklar,
eksik dosyalar, uyuşmayan sağlama toplamları ve yalnızca kaynak içeren sürümler
indirme düğmesi üretmez. Kararlı/ön sürüm kanalları ayrıdır. Homebrew yalnızca gerçek
tap dosyası, üretilen cask'ın sağlama toplamıyla eşleşirse gösterilir. Bağlantılar
sürümlü adresleri kullanır; `/latest` için dosya adı tahmin edilmez.

### 5. İmzalı otomatik güncelleme

Pakete eklenen açık anahtar Tauri güncelleyicisini etkinleştirir. `auto_check_updates`
açıksa ana pencere açılıştan sonra ve her beş dakikada kontrol yapar. Kontroller
kurulumla çakışmaz. Kapatılabilir duyuru yeni sürümü ve sürüm notlarını aynı duyuruyu
tekrarlamadan gösterir; indirme/kurulum ve yeniden başlatma kullanıcı tarafından
başlatılır. Ayarlar → Hakkında ve Güncellemeler bölümünde elle kontrol de bulunur.

Akış `https://erdembas.github.io/kubepit/updates/latest.json` adresindedir. Pages;
sağlama toplamı, dosya adresleri, tüm platformlar, imza dosyaları ve güvenilen açık
anahtar doğrulandıktan sonra akışı kopyalar. Eksiksiz imzalı kararlı sürüm önceliklidir;
henüz yoksa eksiksiz imzalı ön sürüm seçilir. Akış yenilemesi başarısızsa dağıtım
durur; yayındaki site ve akış korunur.

Mevcut özel anahtarı ve parolayı Git dışında, yalnızca sahibinin erişebildiği
dosyalarda tutun ve kurtarılabilir yedek alın. CI, `TAURI_SIGNING_PRIVATE_KEY` ve
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` sırlarını kullanır; yalnızca açık anahtar
commit edilir. Özel anahtarın kaybı veya değişmesi kurulu uygulamaların güncelleme
devamlılığını bozar. Yerel imzalı derlemeler de bu ortam değişkenlerini gerektirir.
İmzasız yerel geliştirme paketi için Tauri ayarını `createUpdaterArtifacts:false`
ile geçersiz kılın.

v0.0.1 güncelleyici açık anahtarı içermez. v0.0.2 bir kez elle kurulmalıdır; sonraki
imzalı sürümler uygulama içinden güncellenebilir. Linux’ta AppImage, DEB veya RPM
biçimi korunur; DEB/RPM kurulumu sistemin paket yöneticisini kullanır ve yönetici
izni isteyebilir. İlk etkin sürüm güncelleme güvenini başlatır;
uçtan uca doğrulama iddiasından önce her hedefte kurulu sürümden yeni sürüme geçişi
test edin.
