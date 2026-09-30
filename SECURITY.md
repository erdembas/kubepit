# Security / Güvenlik

[English](#english) · [Türkçe](#türkçe)

## English

### Reporting a vulnerability

Use GitHub's **Report a vulnerability** option under this repository's Security
tab if private reporting is enabled. If it is unavailable, open an issue titled
“Private security contact requested” with no exploit details or sensitive data,
so a maintainer can arrange a private channel. Do not post kubeconfigs, tokens,
private keys, cluster identifiers or exploitable details in public issues.

Include the affected version/commit, OS, impact, a minimal reproduction using
synthetic resources and any proposed fix. Kubepit is a community project at
experimental version 0.0.1; there is no guaranteed response time, long-term support
branch or independent security-audit claim. Fixes target the current codebase.

### Trust boundaries

- **Cluster permissions:** Kubernetes RBAC is authoritative. Built-in mutations check `ClusterDef.read_only`; production workflows add reviews and confirmations. These controls reduce mistakes but do not create a sandbox around arbitrary local shell commands. Custom actions rely on their saved `mutating` declaration; import and review them as executable code.
- **Kubeconfigs:** Importing a kubeconfig is a trust decision: exec authentication may run a local program. Kubepit keeps managed copies and does not rewrite the original. Optional OS credential storage protects stored kubeconfigs, but subprocess workflows can materialize temporary single-context files. Local administrators, malware and backups remain outside this protection.
- **Local history:** The desktop enables audit recording by default. Events/changes can be persisted per cluster; recommendation scans and optional AI request logs also use `history.db`. Secret values and known sensitive fields are redacted, but arbitrary logs, ConfigMaps, error messages or user-defined content can contain sensitive information. Review exports before sharing. This local database is not a tamper-proof, complete cluster audit.
- **AI:** The assistant starts disabled and clusters require opt-in. Remote providers and supported installed agents can receive redacted selected context and messages. Context previews, tool-result consent and masking are provided; redaction is not a guarantee against every form of secret. IP/hostname masking is off by default. Typed follow-ups without context send directly. AI local-only mode limits assistant transports, not all application networking.
- **Diagnostics:** NetworkPolicy simulation does not test live traffic or evaluate every CNI policy. Health/security findings and upgrade checks have coverage limits. Trivy integration displays existing operator reports. An empty or incomplete result is not a security attestation.
- **Demo:** The browser demo uses fixtures and simulated actions. Never submit real credentials or confidential material to it. Browser preferences can persist locally.
- **Distribution:** The current source configuration does not establish signed/notarized public installers. The in-app updater refuses to operate without a configured public signing key and HTTPS endpoints. Updater signatures and operating-system code signing are separate. See [Releasing](docs/RELEASING.md).

Use least-privilege credentials, keep trusted executables on your `PATH`, inspect
manifests and commands before execution, and treat exported diagnostic material
according to your organization's rules. Architectural details and implementation
limits are documented in [Architecture](docs/ARCHITECTURE.md).

## Türkçe

### Güvenlik açığı bildirme

Özel bildirim etkinse deponun Security sekmesindeki **Report a vulnerability**
seçeneğini kullanın. Seçenek yoksa bakım sorumlusunun özel iletişim kanalı
oluşturabilmesi için, saldırı ayrıntısı veya hassas veri içermeyen “Private security
contact requested” başlıklı bir issue açın. Kubeconfig, token, özel anahtar, küme
tanımlayıcıları veya kötüye kullanılabilecek ayrıntıları herkese açık paylaşmayın.

Etkilenen sürüm/commit, işletim sistemi, etki, örnek kaynaklarla hazırlanmış en
küçük tekrar senaryosu ve varsa çözüm önerisini iletin. Kubepit, deneysel 0.0.1
sürümünde bir topluluk projesidir; garanti edilen yanıt süresi, uzun süre desteklenen
sürüm dalı veya bağımsız güvenlik denetimi iddiası yoktur. Düzeltmeler güncel kodu
hedefler.

### Güven sınırları

- **Küme izinleri:** Kubernetes RBAC yetkilendirmede son sözü söyler. Yerleşik değişiklikler `ClusterDef.read_only` denetiminden geçer; üretim akışlarında inceleme ve onay eklenir. Bunlar hataları azaltır ancak yerel kabukta yazılan komutları yalıtmaz. Özel eylemler kayıtlı `mutating` tanımına güvenir; bunları çalıştırılabilir kod olarak inceleyip içe aktarın.
- **Kubeconfig:** İçe aktarma bir güven kararıdır; exec kimlik doğrulaması yerel program çalıştırabilir. Kubepit yönetilen kopyaları tutar, orijinali yeniden yazmaz. İsteğe bağlı işletim sistemi kimlik deposu saklanan kubeconfig'leri korur; alt süreç akışları geçici tek bağlamlı dosyalar oluşturabilir. Yerel yöneticiler, zararlı yazılımlar ve yedekler bu korumanın dışındadır.
- **Yerel geçmiş:** Masaüstünde işlem kaydı varsayılan olarak açıktır. Olay/değişiklik geçmişi küme bazında saklanabilir; öneri taramaları ve isteğe bağlı yapay zekâ istek günlükleri de `history.db` kullanır. Secret değerleri ve bilinen hassas alanlar maskelenir; ancak herhangi bir log, ConfigMap, hata mesajı veya kullanıcı içeriği hassas bilgi barındırabilir. Dışa aktarılan veriyi paylaşmadan önce inceleyin. Yerel veritabanı değiştirilemez ve eksiksiz bir küme denetim kaydı değildir.
- **Yapay zekâ:** Asistan başlangıçta kapalıdır; kümeler için ayrı izin gerekir. Uzak sağlayıcılar ve desteklenen kurulu ajanlar, maskelenmiş seçili bağlamı ve mesajları alabilir. Bağlam önizlemesi, araç sonucu onayı ve maskeleme sağlanır; maskeleme her gizli bilginin yakalanacağını garanti etmez. IP/host adı maskelemesi varsayılan olarak kapalıdır. Bağlamsız yazılı takip mesajları doğrudan gönderilir. Yalnızca yerel mod, tüm uygulama ağını değil asistan bağlantılarını sınırlar.
- **Tanı araçları:** NetworkPolicy simülasyonu canlı trafik testi yapmaz ve her CNI politikasını değerlendirmez. Sağlık/güvenlik bulguları ve yükseltme kontrollerinin kapsam sınırları vardır. Trivy entegrasyonu mevcut operator raporlarını gösterir. Boş veya eksik sonuç güvenlik sertifikası değildir.
- **Demo:** Tarayıcı demosu örnek veri ve simüle edilmiş işlemler kullanır. Gerçek kimlik bilgisi veya gizli içerik girmeyin. Tarayıcı tercihleri yerelde saklanabilir.
- **Dağıtım:** Mevcut kaynak ayarları imzalı/noter onaylı herkese açık kurulum paketi bulunduğunu göstermez. Açık imzalama anahtarı ve HTTPS uç noktaları tanımlanmadan uygulama içi güncelleme çalışmaz. Güncelleme imzası ile işletim sistemi kod imzası farklıdır. Ayrıntılar [Yayımlama](docs/RELEASING.md) belgesindedir.

En az yetkili kimlik bilgilerini kullanın, `PATH` üzerindeki programların
güvenilirliğini koruyun, manifest ve komutları çalıştırmadan önce inceleyin,
dışa aktarılan tanı verilerini kurumunuzun kurallarına göre ele alın. Mimari
ayrıntılar ve uygulama sınırları [Mimari](docs/ARCHITECTURE.md) belgesindedir.
