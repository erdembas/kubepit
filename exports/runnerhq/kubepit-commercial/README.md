# Kubepit Commercial — RunHQ import paketi

> **Arşivlendi — 2026-09-30.** Ticari ürün planından vazgeçildi. Kubepit v0.0.1,
> [MIT lisanslı](../../../LICENSE), ücretsiz ve açık kaynaklı bir topluluk
> sürümüdür. Bu paket yalnızca tarihsel kayıt olarak korunuyor; içindeki ticari
> ürün, abonelik, özel depo ve lisans geçişi iş akışını güncel çalışma olarak
> başlatmayın. Güncel yön: [proje README'si](../../../README.md).
>
> **Archived — 2026-09-30.** The commercial product plan was abandoned. Kubepit
> v0.0.1 is a free, open-source community release under the
> [MIT license](../../../LICENSE). This package is retained only as a historical
> record; its commercial, subscription, private-repository and license-transition
> workflow is not current work and should not be started. See the
> [project README](../../../README.md) for the current direction.

**İçe aktarılacak dosya: `kubepit-commercial.zip`.** ZIP; manifest, 62 ajan promptu, 20 bölüm brief'i, gerçek komutları çalıştıran doğrulama gate'i ve yedi planın sabit kopyasını içerir. İçe aktarma kod çalıştırmaz; Workflows editöründe taslak açar.

54 uygulama görevi (26 cloud + 28 desktop) ve L1–L7 lisans/depo işleri mantıklı sırada 20 bölüme ayrılmıştır. Bölüm tablosu [PHASES.md](PHASES.md), tam görev/komut eşlemesi [phase-map.json](phase-map.json), uygulayıcı sözleşmesi [EXECUTION.md](EXECUTION.md) içindedir.

## İçe aktarma

1. RunHQ → **Agents → Workflows → Import workflow / İş akışı içe aktar**.
2. ZIP'i seç. Açılmış klasördeki `pipeline.json` da aynı klasör yapısı korunursa kullanılabilir; tek JSON'u başka yere kopyalama.
3. Depo yollarını, dalları, Codex bağlantısını/modelini ve yürütme ayarlarını incele. Model/effort boş bırakılmıştır; editörde kendi seçimini yap. Review adımları Codex read-only `plan` modundadır. Farklı backend seçersen onun RunHQ read-only review desteğini doğrula.
4. **Create workflow / İş akışı oluştur** ile kaydet. Başlatma ayrı işlemdir. **Run next steps automatically / Sonraki adımları otomatik çalıştır** ayarını açık tut. Grafikte insan onayı adımı yoktur; test ve bağımsız review başarılı oldukça sıradaki iş otomatik başlar.

Başka bilgisayara taşırken kaynak ZIP'i yeniden içe aktar. RunHQ recipe JSON export'u shell dosyalarını gömmez. İçe alınmış paketi sonradan bu klasörde düzenlemek kayıtlı taslağı değiştirmez; güncel ZIP/JSON'u yeniden import etmek gerekir.

## Başlatmadan önce gereken yerel hazırlık

Bu export **hiçbir uygulama kodunu çalıştırmadı**, özel depo yaratmadı, mevcut değişiklikleri commit etmedi ve Git geçmişini sıfırlamadı.

Manifestin varsayılanları:

| Alan | Değer |
| --- | --- |
| Ortak çalışma kökü | `/Users/erdembas/Projects/github.com/erdembas` |
| Public repo | `kubepit`, dal `main` |
| Private repo | `kubepit-commercial`, dal `main` |
| Bağlantı | Codex; model ve effort editörde seçilir |
| Eşzamanlılık | 1; tüm write adımlarında aynı lock |

Export hazırlanırken public repo `main` üzerinde **çok sayıda mevcut değişiklik** içeriyordu; private sibling depo henüz yoktu. **Dosya şimdi import edilebilir, fakat bu haliyle doğrudan başlatmaya hazır değildir.** RunHQ iki repository'nin de mevcut, seçili dalda ve temiz olmasını başlangıçta denetler. Bu başlangıç önkoşulları, workflow içi onay değildir; eksik checkout otomatik importer tarafından oluşturulmaz.

- Mevcut public çalışmayı inceleyerek koru; yalnız karar verdiğin dosyaları ayrı yerel checkpoint'e al veya uygun temiz uygulama checkout'ı seç. Otomatik toplu stage/stash/clean/reset yoktur. Bu paketteki ticari planların public yayına girip girmeyeceğini ayrıca değerlendir.
- Ayrı **yerel private hedef** `kubepit-commercial` hazırlanmış, en az bir başlangıç commit'i ve seçili dalı mevcut olmalı. Remote/GitHub repo oluşturmak bu export için gerekli değildir. `vendor/kubepit` henüz gerekli değil; P04 oluşturur.
- İki checkout aynı ortak ebeveyn altında `kubepit` ve `kubepit-commercial` adlarıyla durmalı. Başka konum/dal kullanıyorsan üç yol/branch alanını import editöründe birlikte düzelt. Bütün parent dizini target olarak otomatik keşfetme; yalnız iki açık repository listesi kullanılmalı.
- Node.js 24+, projenin pnpm sürümü, Rust toolchain, Git, yerel Docker Engine/Compose ve Tauri build araçları hazır olmalı. Bu paket shell gate'i mevcut macOS host ve macOS app bundle komutları için hazırlanmıştır; Linux/Windows ürün doğrulaması fixture/CI matrisinin parçasıdır. `package.install` boş; import dependency kurmaz.
- Şirket/merchant/region ve lisans hakları henüz doğrulanmış sayılmaz; Paddle seçimi korunur. Eksik bilgiler `EXTERNAL_GATES.md` içinde kaydedilir, teknik uygulama devam eder. Lisans geçişi uygulanabilir taslak patch olarak hazırlanır; hukuki/hizmet etkinleştirme işleri bu otomatik yerel akışın dışında bekler.

## Otomatik akış

Her bölüm uygulama → shell test/build → bağımsız snapshot incelemesi içerir. Yalnız **PASS** sonraki bölümü açar. FAIL veya CONDITIONAL için en çok **3 düzeltme**, toplam **4 inceleme** vardır; sınır dolunca kullanıcı müdahalesi gerekir. Test/agent teknik hatası da akışı durdurur; düzeltildikten sonra ilgili adım Retry edilir.

**0 insan onayı, 122 adım.** Başlangıç, mimari, ödeme ve takım profili için manuel bekleme yoktur. P03/P05 sonunda kabul edilen public değişiklikleri checkpoint ajanı otomatik yerel commit yapar; gerekli vendor pinleri ajanlarca güncellenir. Sonraki zorunlu public değişiklikler de görev dosyalarıyla sınırlı yerel checkpoint + test + bağımsız review sürecinden geçer. Push yapılmaz. Workflow içinde rutin “devam edeyim mi?” sorusu yoktur.

İnceleyiciler canlı depoya yazmaz; gate'in yakaladığı kod sürümünü ve test çıktısını değerlendirir. `phase-map.json` her cloud/desktop görevinin tek bölümde sahiplenildiğini gösterir. D5 composition denemesi D6'dan önce yapılır; D6 sonrası ikinci otomatik public pin checkpoint'i özel build'in eski/uncommitted API'ye bağlı kalmasını önler.

## Teslimin anlamı

Workflow'un sonu **incelenmiş yerel release candidate + kanıt/eksik dış karar listesi** üretir. Production deploy, public push, commit history reset, mağaza yayını, gerçek ödeme ve gerçek mesaj gönderimi içermez. Paddle merchant/düşük tutar onayı, yetkilendirilmiş gerçek sandbox provası, hukuk/region, imzalama ve platform kontrolleri yapılmadıysa pending kalır. Son teknik PASS bunların yapılmış olduğunu varsaymaz ve bu eksikler için grafikte manuel bekleme eklenmez.

**Önceki 130 adımlı sürümü import ettiysen yeni ZIP'i yeniden import et; mevcut kayıtlı workflow kaynak dosya değişince otomatik güncellenmez.** Eski onaylı sürümü aynı checkout'larda paralel başlatma.

Bu paket iç iş planlarını içerir. Public kaynak yayınından önce dosyaların public/private yerleşimini L7 kapsamında incele.

## Paket doğrulaması

Export; gerçek RunnerHQ `AgentManager::import_workflow_file` importer'ı ile geçici RunHQ veri dizininde JSON ve ZIP olarak kontrol edilir. Bu kontrol adım/koşul/prompt dönüşümünü doğrular; planlanan ürün testlerini çalıştırmaz ve eksik private checkout'ı hazır hâle getirmez. Komutlar ancak workflow daha sonra başlatılırsa çalışacaktır. Son doğrulama raporu ZIP'in yanında `validation-report.json` olarak tutulur.

Kaynak dayanaklar: RunnerHQ `docs/PIPELINE_PACKAGES.md`, `crates/runhq-core/src/agents/pipeline/types.rs`, `pipeline/import.rs`, `workflow_package_import.rs`, `workflow_native.rs`. Üretim script'i ZIP'in yanındaki `build-commercial-workflow.py` dosyasıdır; yeniden üretimden sonra tekrar importer doğrulaması yap.
