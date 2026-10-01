# Changelog / Değişiklik günlüğü

## 0.0.2 — Signed updates / İmzalı güncellemeler

### English

- Check for updates after startup and every five minutes when automatic checks are enabled. A dismissible announcement presents the new version, release notes and explicit download/install controls without repeatedly announcing the same version.
- Show download progress and a restart action after installation; protect checks and installation from overlapping across application windows.
- Require Developer ID signing and Apple notarization for new macOS release packages. Verify signed update artifacts for all six desktop targets and publish the update feed through GitHub Pages.
- Refresh the Homebrew cask every six hours after verifying release metadata and checksums. Website version labels follow verified published releases; unchanged metadata no longer triggers redundant browser asset requests.
- Migration: v0.0.1 has no updater public key. Install v0.0.2 manually once to receive later signed updates. Linux updates preserve AppImage, DEB or RPM format; package-manager installation may request administrator permission.

### Türkçe

- Otomatik denetim açıksa açılıştan sonra ve her beş dakikada bir güncelleme kontrol edilir. Kapatılabilir duyuru yeni sürümü, sürüm notlarını ve kullanıcının başlattığı indirme/kurulum seçeneklerini sunar; aynı sürümü tekrar tekrar duyurmaz.
- İndirme ilerlemesi ve kurulumdan sonra yeniden başlatma seçeneği gösterilir; farklı uygulama pencerelerindeki kontrollerin ve kurulumların çakışması önlenir.
- Yeni macOS sürüm paketlerinde Developer ID imzası ve Apple noter onayı zorunludur. Altı masaüstü hedefinin imzalı güncelleme paketleri doğrulanır ve güncelleme akışı GitHub Pages üzerinden yayımlanır.
- Homebrew cask dosyası, sürüm bilgileri ve sağlama toplamları doğrulandıktan sonra altı saatte bir güncellenir. Sitedeki sürüm etiketleri doğrulanmış yayınları izler; değişmemiş bilgiler için gereksiz tarayıcı indirme istekleri yapılmaz.
- Geçiş: v0.0.1 güncelleyici açık anahtarı içermez. Sonraki imzalı güncellemeleri almak için v0.0.2’yi bir kez elle kurun. Linux güncellemeleri AppImage, DEB veya RPM biçimini korur; paket yöneticisiyle kurulum yönetici izni isteyebilir.

## 0.0.1 — Initial public release / İlk herkese açık sürüm

### English

Kubepit's first public version establishes the complete MIT-licensed community
edition, source builds and desktop packages. This version is experimental; a
successful package build does not certify production readiness or platform signing.

Included in the initial codebase:

- Local-first multi-cluster desktop workspace: kubeconfig import, sections, tags, environments, live resources and CRDs, split panes, pinned tabs and multiple windows.
- Logs and debugging: merged workload streams, structured filters, terminals, exec/attach, debug containers, container files and saved port forwards.
- Reviewed operations: cluster-schema YAML editing, dry-run diffs, resource wizards, workload rollouts, Helm charts/values schemas/upgrade review, GitOps views and multi-cluster manifest review.
- Fleet insight: cross-cluster search/compare/drift, resource topology, NetworkPolicy simulation, health and certificate checks, Trivy report views, RBAC inspection and upgrade readiness.
- Observability and capacity: metrics-server history, optional Prometheus and Loki, OpenCost/Kubecost or labeled cost estimates, right-sizing recommendations and optional scheduled scans.
- Local accountability: change timeline, SQLite audit history, optional persisted events/changes, exports and reviewed reverts where supported.
- Optional assistant with provider/agent choice, per-cluster opt-in, redacted context preview, read-only tools and review of generated YAML.
- English and Turkish UI, optional vim/k9s-style keyboard mode and custom actions with supported k9s plugin import.
- Cancellable Linux PTY input and output: closing a terminal releases a blocked large paste even when the child stops reading.
- English/Turkish Next.js static product website, the fixture-backed interactive browser demo, GitHub Pages deployment, contribution/security/release guides and version consistency checks.

- Follow-up release automation builds 11 installers across six OS/architecture targets from the frozen version tag, publishes a complete checksum manifest, generates a checksum-pinned Homebrew cask and refreshes website download metadata. The website gains a motion-controlled hero and platform/architecture download selection.

Known launch boundaries:

- macOS packages are ad-hoc signed without Developer ID/notarization; Windows packages are unsigned. The in-app updater is not configured. CI checks package structure, metadata and hashes; it does not certify runtime behavior on every supported machine.
- Integrations need their documented tools, permissions and data sources. The demo simulates cluster and provider behavior.
- Recommendations and cost numbers are estimates; health, network and upgrade findings have explicit coverage limits.
- Performance fixtures are reproducible engineering checks, not comparative benchmarks against other products. GitHub runner timing budgets still require calibration.

### Türkçe

Kubepit'in ilk herkese açık sürümü, tamamı MIT lisanslı topluluk ürününü ve kaynak
koddan derleme ve masaüstü paketlerini sunar. Bu sürüm deneyseldir; başarılı paket
derlemesi, üretime hazır olunduğunu veya platform imzası bulunduğunu belgelemez.

İlk kod tabanına dâhil olanlar:

- Yerel öncelikli çok kümeli masaüstü çalışma alanı: kubeconfig içe aktarma, bölümler, etiketler, ortamlar, canlı kaynaklar ve CRD'ler, bölünmüş paneller, sabitlenmiş sekmeler, çoklu pencere.
- Loglar ve hata ayıklama: birleşik iş yükü akışları, yapılandırılmış süzme, terminaller, exec/attach, debug container'ları, container dosyaları, kayıtlı port yönlendirmeleri.
- İncelenerek yapılan işlemler: küme şemasıyla YAML düzenleme, dry-run farkları, kaynak sihirbazları, rollout, Helm chart/values şeması/yükseltme incelemesi, GitOps görünümleri, çok kümeli manifest inceleme.
- Filo görünürlüğü: kümeler arası arama/karşılaştırma/farklılaşma, kaynak topolojisi, NetworkPolicy simülasyonu, sağlık ve sertifika kontrolleri, Trivy raporları, RBAC inceleme, yükseltmeye hazırlık.
- Gözlemlenebilirlik ve kapasite: metrics-server geçmişi, isteğe bağlı Prometheus ve Loki, OpenCost/Kubecost veya etiketli maliyet tahminleri, kaynak boyutlandırma önerileri, isteğe bağlı zamanlanmış taramalar.
- Yerel izlenebilirlik: değişiklik zaman çizelgesi, SQLite işlem geçmişi, isteğe bağlı kalıcı olay/değişiklikler, dışa aktarma, desteklenen işlemlerde incelenerek geri alma.
- Sağlayıcı/ajan seçimi, küme bazlı izin, maskelenmiş bağlam önizlemesi, salt okunur araçlar ve üretilen YAML'ı inceleme içeren isteğe bağlı asistan.
- İngilizce ve Türkçe arayüz, isteğe bağlı vim/k9s tarzı klavye modu, desteklenen k9s eklentilerinin içe aktarımıyla özel eylemler.
- İptal edilebilir Linux PTY giriş/çıkışı: alt süreç okumayı durdursa bile terminali kapatmak, büyük bir yapıştırma işleminde bekleyen yazmayı sonlandırır.
- İngilizce/Türkçe Next.js statik ürün sitesi, örnek verili etkileşimli tarayıcı demosu, GitHub Pages dağıtımı, katkı/güvenlik/yayımlama rehberleri, sürüm tutarlılığı denetimleri.

- Sonradan eklenen yayın otomasyonu, sabit sürüm etiketinden altı sistem/mimari hedefinde 11 kurulum paketi derler; eksiksiz sağlama bildirimi yayımlar, sağlama toplamına bağlı Homebrew cask dosyasını üretir ve sitenin indirme bilgilerini günceller. Siteye hareket kontrolü olan hero ve sistem/mimari seçmeli indirme alanı eklendi.

İlk yayının bilinen sınırları:

- macOS paketleri ad-hoc imzalıdır; Developer ID/noter onayı yoktur. Windows paketleri imzasızdır. Uygulama içi güncelleyici yapılandırılmamıştır. CI paket yapısını, üst veriyi ve sağlama toplamlarını denetler; desteklenen her makinede çalışma davranışını belgelemez.
- Entegrasyonlar belgelenen araçlara, izinlere ve veri kaynaklarına ihtiyaç duyar. Demo, küme ve sağlayıcı davranışlarını simüle eder.
- Öneriler ve maliyetler tahmindir; sağlık, ağ ve yükseltme bulgularının açık kapsam sınırları vardır.
- Performans örnekleri tekrarlanabilir mühendislik kontrolleridir; diğer ürünlerle karşılaştırmalı benchmark değildir. GitHub runner süre bütçelerinin kalibrasyonu henüz gereklidir.
