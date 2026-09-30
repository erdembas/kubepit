# Changelog / Değişiklik günlüğü

## 0.0.1 — Initial public release / İlk herkese açık sürüm

### English

Kubepit's first public version establishes the complete MIT-licensed community
edition and its source-first release path. This version is experimental; a tag or
source release does not certify production readiness or signed binary availability.

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

Known launch boundaries:

- This is a source-first release. Public installers, platform certification, notarization and a signed automatic-update feed are separate release work.
- Integrations need their documented tools, permissions and data sources. The demo simulates cluster and provider behavior.
- Recommendations and cost numbers are estimates; health, network and upgrade findings have explicit coverage limits.
- Performance fixtures are reproducible engineering checks, not comparative benchmarks against other products. GitHub runner timing budgets still require calibration.

### Türkçe

Kubepit'in ilk herkese açık sürümü, tamamı MIT lisanslı topluluk ürününü ve kaynak
koddan kullanım yolunu sunar. Bu sürüm deneyseldir; etiket veya kaynak yayını,
üretime hazır olunduğunu ya da imzalı kurulum paketi bulunduğunu belgelemez.

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

İlk yayının bilinen sınırları:

- Başlangıç yolu kaynak koddur. Herkese açık kurulum paketleri, platform doğrulaması, noter onayı ve imzalı otomatik güncelleme akışı ayrı yayın işleridir.
- Entegrasyonlar belgelenen araçlara, izinlere ve veri kaynaklarına ihtiyaç duyar. Demo, küme ve sağlayıcı davranışlarını simüle eder.
- Öneriler ve maliyetler tahmindir; sağlık, ağ ve yükseltme bulgularının açık kapsam sınırları vardır.
- Performans örnekleri tekrarlanabilir mühendislik kontrolleridir; diğer ürünlerle karşılaştırmalı benchmark değildir. GitHub runner süre bütçelerinin kalibrasyonu henüz gereklidir.
