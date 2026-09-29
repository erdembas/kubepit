# Ticari lisanslama ve depo ayrımı

Tarih: 2026-09-29 · Durum: karar ve uygulama planı taslağı · Kapsam: lisans,
fikrî haklar, katkılar, açık/özel depo sınırı ve dağıtım güvenliği.

Bu belge uygulanmış bir lisans değişikliği veya yürürlüğe girmiş sözleşme değildir.
`LICENSE`, depo görünürlüğü, katkı koşulları ve yayımlanmış sürümler bu çalışmada
değiştirilmez. Satıcı tüzel kişiliği ve uygulanacak hukuk netleşince bir yazılım
lisanslama uzmanının onaylayacağı gereksinimleri tanımlar.

## 1. Önerilen karar

**İlk public yayın için AGPL-3.0-only çekirdek + ayrıca verilen alternatif
ticari çekirdek lisansı önerilir.** Yeni ücretli Cloud ve Team implementasyonu
özel depoda, genel compatibility SDK/edition sözleşmeleri MIT altında tutulur.
Resmî birleşik masaüstü ürünü, denetlenen çekirdek kodunu **alternatif ticari
izinle** ve premium kodu özel lisansla kullanır; AGPL'nin üzerine EULA ekleyerek
copyleft şartlarını kaldırdığı varsayılmaz. Bu tercih bütün ilgili first-party
haklarının kontrol edildiğinin doğrulanmasına bağlıdır.

Kullanıcı, kodun henüz remote'a push edilmediğini, kimseye dağıtılmadığını ve
başkasının MIT kopyası olmadığını belirtti. Plan bunu esas alır; yerel `LICENSE`
dosyasının MIT olması tek başına geçmiş bir kamuya dağıtım kanıtı değildir.
İlk yayın öncesi lisans değişikliği bu nedenle gerçek bir seçenektir. Bu belge
değişikliği uygulamaz; hak envanteri, lisans sahibinin açık kararı ve hukuki
inceleme yayın kapısıdır.

Barındırılan hizmet, kendi sunucusunda kimlik, üyelik ve abonelik kontrolü yapar.
Ücretli haklar kullanıcı başına **3 USD/ay veya 30 USD/yıl** olarak
satılır; yıllık plan aylık peşin fiyatla karıştırılmadan yıllık tahsilat olarak
gösterilir. Tercih edilen ödeme sağlayıcısı Paddle'dır; satıcı şirketin yargı
alanı ve sağlayıcı uygunluğu henüz kesinleşmemiştir. Vergi, satıcı, ödeme ve
abonelik yaşam döngüsü ayrı ticari planda çözülür.

İki isteğin sınırı açık olmalıdır: gerçek açık kaynak çekirdek ile fork, yeniden
dağıtım ve ticari yeniden kullanım yasağı aynı lisans altında sağlanamaz. OSI
tanımı değiştirilmiş sürümlere ve ticari kullanıma izin verilmesini ister.
Rakiplerin kullanımını yasaklayan görünür kaynak, **source-available** olarak
adlandırılmalıdır; OSS olarak tanıtılmamalıdır.
[OSI Open Source Definition](https://opensource.org/osd)

AGPL de rakiplerin fork yapmasını, ücret almasını veya şartlarına uyarak hizmet
vermesini yasaklamaz. Tercihin amacı kapalı türev dağıtımı ve kapsamdaki ağ
değişiklikleri için kaynak paylaşımı yükümlülüğü getirmektir; “kopyalanamaz”
ürün vaat etmek değildir. AGPL yolunu seçen alıcının hakları Cloud aboneliğine
bağlanmaz. [OSI: AGPL-3.0 metni](https://opensource.org/license/agpl-3.0)

Ücretsiz sürüm kaynak kodundan, hesap açmadan ve ticari depoya erişmeden
derlenebilir. Kullanıcı kendi Kubernetes cluster'larına bağlanmak için Kubepit
hesabına veya lisans sunucusuna ihtiyaç duymaz. Ücretli aboneliğin sona ermesi
mevcut yerel çekirdek kullanımını, kubeconfig erişimini veya kullanıcı verisini
kilitlemez.

## 2. Lisans seçenekleri ve karar matrisi

| Seçenek                                                                | Gerçek OSS mi?                            | Fork ve rakip ürün                                                | Kapalı ücretli masaüstü modülü                                                 | Kubepit için karar                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| AGPL-3.0-only public çekirdek + alternatif ticari izin + özel modüller | Public çekirdek evet; private ekler hayır | Fork/rekabet mümkündür; AGPL yolunda copyleft uygulanır           | Denetlenen çekirdeğin alternatif ticari izni ve uyumlu bağımlılıklar sayesinde | **Önerilen başlangıç**, mülkiyet ve CLA kapılarıyla                               |
| Yalnız AGPL-3.0-only çekirdek, ek ticari hak olmadan                   | Evet                                      | Rakip kullanım yasaklanmaz                                        | Aynı birleşik programdaki özel modülleri kapalı dağıtmak genellikle uyumsuzdur | Önerilen modelle karıştırılmaz                                                    |
| MIT veya Apache-2.0 çekirdek + özel kod/hizmet                         | Çekirdek evet                             | Kapalı ticari fork dâhil geniş yeniden kullanım mümkündür         | İlgili bildirim ve bağımlılık şartları korunarak mümkündür                     | Daha az lisans/katkı idaresi isteyen alternatif; sahiplik incelemesi yine gerekli |
| MPL-2.0 çekirdek + özel kod/hizmet                                     | Çekirdek evet                             | Fork/rekabet mümkündür; dosya düzeyinde karşılıklılık vardır      | Kapsamdaki dosyaların yükümlülükleri korunarak daha esnek olabilir             | Daha hafif copyleft istenirse alternatif                                          |
| BSL 1.1 veya FSL                                                       | Kısıtlama dönemi boyunca hayır            | Lisansın üretim/rekabet sınırlarına bağlı                         | Ek ticari izin ve bileşen analizi gerekir                                      | Ancak OSS hedefinden bilinçli vazgeçilirse yeniden değerlendirilir                |
| Tüm kodu ilk yayından önce kapalı yapmak                               | Hayır                                     | Hak sahibi özel izin verir; bağımsız yeniden uygulama engellenmez | Ticari lisansla dağıtılır                                                      | Ücretsiz OSS çekirdek talebiyle uyuşmuyor                                         |

Apache-2.0 açık bir katkıcı patent izni, patent davasıyla ilişkili sona erme
hükmü, değişiklik/NOTICE koşulları ve marka izni sınırı içerir. Bunlar MIT'e göre
farklı kurumsal özelliklerdir; rekabet yasağı değildir. Başkalarının koduna yalnızca
etiket değiştirerek onların vermediği patent hakları eklenemez.
[Apache License 2.0, §§2–6](https://www.apache.org/licenses/LICENSE-2.0)

MPL-2.0'ın dosya düzeyindeki copyleft'i, kapsamdaki dosyaların değişikliklerini
paylaşmayı gerektirirken ayrı yeni dosyaların daha büyük bir özel ürün içinde
farklı lisansla yer almasına izin verebilir. AGPL'nin ağ hükmünün eşdeğeri
değildir. [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

AGPL §13, **değiştirilmiş kapsamdaki programın** uzaktaki ağ kullanıcılarına
ilgili kaynak kodunu alma fırsatını sunmayı gerektirir. Her SaaS, her HTTP
istemcisi veya onunla konuşan her ayrı sunucu otomatik olarak AGPL olmaz.
Program/birleşik eser sınırı ve diğer dağıtım hükümleri ayrıca değerlendirilir.
Community binary dağıtımı için ilgili kaynak, değişiklikler ve gerekli build
malzemeleri sürümle eşleştirilir; uygun kaynak sağlama yolu release tasarımında
tanımlanır. [AGPL-3.0, özellikle §§1, 6 ve 13](https://opensource.org/license/agpl-3.0)

FSF'nin yorumunda statik bağlama ve yakın işlev/veri paylaşan dinamik eklentiler
birleşik program oluşturabilir. Tauri Rust binary'sine bağlanan özel crate veya
aynı React bundle'ına eklenen özel modül için sadece ayrı depo, feature flag,
eklenti adı ya da araya bir MIT wrapper koymak çözüm sayılmaz. Ayrı süreç/HTTP
iletişimi de her durumda otomatik istisna değildir. Bu planın özel birleşik
binary'si bu yüzden denetlenen çekirdek için **ayrı alternatif ticari izne**
dayanır. Üçüncü taraf AGPL/GPL kodu için
Kubepit tek başına istisna veremez.
[FSF GPL FAQ: plugins ve birleşik programlar](https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins)

Hak sahibi, kontrol ettiği aynı kod için farklı, münhasır olmayan izinler
verebilir; FSF'nin açıkladığı ticari istisna modeli de buna dayanır. Public
alıcılara varsayılan AGPL sunulur; commercial hak kendiliğinden herkese verilmez.
“Çift lisans” burada iki izin yolunu anlatır, EULA'nın AGPL'yi daraltmasını değil.
Şirket hak sahibinden ayrıysa çekirdeği ticari koşullarda dağıtma yetkisi yazılı
olarak belgelenir. Standart Cloud/Team koltuğu müşteriye OEM yeniden dağıtım
lisansı vermez; böyle bir ürün ayrıca kararlaştırılmalıdır.
[FSF: Selling Exceptions](https://www.gnu.org/philosophy/selling-exceptions.html)

BSL 1.1'in standart tabanı üretim dışı kullanıma izin verir; ek kullanım izni
üretim kapsamını belirler. Belirtilen değişim tarihinde veya ilgili sürümün ilk
yayınından dört yıl sonra, hangisi önceyse, değişim lisansı devreye girer. MariaDB
BSL'nin açık kaynak olmadığını açıkça belirtir.
[MariaDB BSL 1.1](https://mariadb.com/bsl11/)

FSL'nin açılımı **Functional Source License**'tır. İlgili sürüm, yayımlanmasından
iki yıl sonra MIT veya Apache-2.0'a geçer. Dolayısıyla
kalıcı bir kopyalama engeli değildir ve kısıtlı dönemde OSS diye sunulmamalıdır.
[FSL resmi açıklaması ve metinleri](https://fsl.software/)

## 3. Yayınlanmamış kod, hak envanteri ve lisans geçişi

Kullanıcının beyanına göre dışarıda MIT kopyası yoktur. Geçmiş MIT dağıtımı bu
planın ön koşulu veya lisans tercihini engelleyen sabit bir kabul değildir.
Yerel dosyalarda MIT yazması ile kodun üçüncü kişilere bu izinle ulaşması ayrı
olgulardır. Envanter aksini gösterirse yalnız ilgili parçalar ve dağıtımlar için
eski izinler değerlendirilir; yeni etiket veya history reset bunları otomatik
geri almaz. MIT'in geniş yeniden dağıtım izni için temel metin:
[MIT License](https://opensource.org/license/mit).

Kullanıcının daha sonra temiz Git geçmişi oluşturma niyeti bu turda reset,
silme veya force push yetkisi sayılmaz. History reset hak sahipliğini,
üçüncü taraf atıf/lisans yükümlülüğünü veya gerçekten verilmiş eski izinleri
ortadan kaldıran bir işlem değildir. Hiçbir reset bu planlama işinde yapılmaz.

Uygulamadan önce özel bir hak envanteri hazırlanır:

1. Yerel dosyalar, bütün Git geçmişi, tag'ler, yayınlar, paketler ve daha önce
   gönderilmiş kaynak arşivleri ayrı ayrı kaydedilir. Henüz yayınlanmamış kod ile
   MIT altında alıcılara ulaşmış kod birbirine karıştırılmaz.
2. Erdem Baş'ın kendi kodu, RunHQ'dan gelen kod/tasarım, üçüncü taraf katkıları,
   işveren/müşteri kapsamında yazılmış kod, ikonlar, fontlar ve görsellerin kökeni
   ve izinleri doğrulanır. Tek bir copyright satırı tam mülkiyet kanıtı sayılmaz.
3. npm ve Cargo bağımlılıkları, vendored dosyalar, kopyalanmış snippet'ler,
   derleme araçları ve binary ile dağıtılan bileşenler ayrı lisans sınıflandırması
   alır. Derleme aracı ile dağıtılan runtime yükümlülüğü aynı şey değildir.
4. First-party çekirdeğin AGPL public ve alternatif commercial dağıtımı için
   telif/patent hak zinciri kaydedilir. Dışarıdan alınmış MIT/Apache bileşenler
   özgün izinleri ve bildirimleriyle kullanılabilir; onların tüm kodu üzerinde
   münhasır hak iddia edilmez. Dışarıdan AGPL/GPL gelen kod veya yalnız AGPL
   izni veren katkı otomatik olarak commercial kola taşınamaz: ayrıca izin,
   uygun farklı bileşen veya ticari build'den çıkarma kararı gerekir.
5. Kökeni veya hak kapsamı belirsiz parçalar için izin alma, değiştirme veya
   kapsamdan çıkarma kararı kayda girer. Bu belge hiçbir parçayı taşımayı,
   silmeyi veya yeniden lisanslamayı kendi başına yetkilendirmez.

### Lisans metadata geçişi — gelecekteki ayrı uygulama işi

Bugün `LICENSE`, kök `package.json`, `apps/desktop/package.json`,
`apps/desktop/src-tauri/Cargo.toml` ve `crates/kubepit-core/Cargo.toml` MIT
belirtiyor. Onaylanan geçişte public first-party core metadata ve SPDX
başlıkları **`AGPL-3.0-only`** olarak birbiriyle tutarlı güncellenir;
`AGPL-3.0-or-later` seçilmez. Public lisans bildirimi, ayrı sözleşmeyle
alternatif ticari hak edinilebildiğini açıklar; belirsiz bir `AND` ifadesiyle
AGPL ve ticari koşulları birlikte zorunlu kılmaz.

SDK'nin bağımsız dosyaları ve package metadata'sı **`MIT`** kalır; AGPL
implementasyonu SDK'ye kopyalanmaz. Özel assembly/modüller için SBOM'da
**`LicenseRef-Kubepit-Commercial`** ve metin referansı kullanılır. Paket araçları
custom SPDX id kabul etmiyorsa onların doğru özel lisans mekanizması seçilir
(Cargo `license-file`, npm `UNLICENSED` veya `SEE LICENSE IN ...`); geçersiz
license değeri yazılmaz. Üçüncü taraf lisansları ayrı kalır. Commercial release
manifesti controlled core için seçilen ticari izin belgesini ve kapsamını
gösterir; public source'da görülen AGPL etiketini sessizce yok saymaz.
[SPDX AGPL-3.0-only](https://spdx.org/licenses/AGPL-3.0-only.html),
[Cargo lisans alanları](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields),
[npm lisans alanı](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license)

## 4. Açık ve ticari ürün sınırı

| Alan                | Kamuya açık `kubepit`                                                                                                                             | Özel `kubepit-commercial`                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Çekirdek            | Bugün mevcut yerel IDE, kubeconfig import, kaynaklar, YAML, log, terminal, Helm, analiz ve güvenlik işlevleri; önerilen public izin AGPL-3.0-only | Aynı sabitlenmiş çekirdek sürümü ayrıca yetkilendirilmiş alternatif ticari izinle kullanılır       |
| Yeni ücretli kapsam | Bağımsız MIT edition/compatibility SDK ve ücretsiz fallback; sır içermeyen kamuya açık API şemaları                                               | Cloud ve Team'in ücretli iş akışları, ticari UI ve backend implementasyonu                         |
| Hesap               | Yerel kullanım için hesap gerektirmez                                                                                                             | Kimlik, kuruluş, davet, roller, koltuklar, abonelik, yetki kontrolleri                             |
| Hizmet              | Demo/fixture verisi; ticari servise zorunlu bağımlılık yok                                                                                        | Barındırılan API, veritabanı şemaları, iş kuyruğu, billing webhook ve yönetim araçları             |
| Dağıtım             | Community kaynak ve binary üretimi, AGPL karşılık gelen kaynak sağlama ve üçüncü taraf bildirimleri                                               | Resmî birleşik binary, alternatif core izni + özel modül lisansı + geçerli bağımlılık bildirimleri |
| İş bilgisi          | Seçilmiş halka açık roadmap ve kullanım belgeleri                                                                                                 | Fiyat ekonomisi, kötüye kullanım prosedürleri, operasyon rehberleri ve ayrıntılı ticari planlar    |

Cloud/Team işlevlerinin kesin ürün listesi ana ticari planın yetki matrisinde
tek yerde tutulur. Mevcut yerel çekirdek yeteneği yeni ödeme
kontrolünün arkasına taşınmaz. Yeni ticari implementasyonun halka açık depoya
önce eklenip sonra gizlenmesi önerilmez. Kamuya açık generic contract, premium
algoritma, implementation stub içine gömülmüş ücretli kod veya gerçek hizmet
credential'ı içermez.

Mevcut Cloud Import ve Team Sharing tasarımları kaynak/yerel profile dayalı
özellikler tarif eder ve kullanıcının beyanına göre henüz dışarıya yayımlanmış
değildir. İş gizliliği istenen taslaklar ilk public push'tan önce private planning
deposuna ayrılır. Daha sonra seçilerek yayımlanan tasarım bir gizlilik sınırı
sayılmaz; başkasının bağımsız uygulamasını yazmasına lisans metniyle mutlak engel
konulamaz. Yeni ticari kapsam kullanıcı belgelerinde özellik bazında belirtilir.

## 5. Depo ve build düzeni

Önerilen düzen; mevcut depoya uygulanacak bir komut listesi değildir:

```text
kubepit/                         ilk public yayın: AGPL-3.0-only çekirdek
  apps/desktop/                  bağımsız Community build
  crates/kubepit-core/
  packages/edition-contracts/    bağımsız, sır içermeyen MIT SDK/arayüz
  docs/                          yalnız yayınlanması seçilmiş belgeler
  LICENSE                       AGPL-3.0-only; ayrı commercial seçenek bildirimi

kubepit-commercial/              ayrı özel depo; yeni ücretli kod burada
  vendor/kubepit/                sabit public SHA
  apps/desktop-commercial/       ticari assembly ve premium UI
  apps/api/                      kimlik, team/cloud, entitlement API ve worker
  apps/console/                  hesap, takım ve faturalama arayüzü
  crates/kubepit-commercial/      premium masaüstü implementasyonu
  packages/billing/              ödeme sağlayıcısı adaptörleri
  licenses/                      controlled core ticari izin kaydı ve notices
  docs/decisions/                onaylanmış kararlar ve hak envanteri
  docs/plans/                    ticari tasarım belgeleri
  docs/operations/               operasyon belgeleri
  ops/                           paketleme, SBOM, lisans manifesti
```

- Özel depo public `main`'i hareketli referans olarak kullanmaz: release manifesti
  tam public commit SHA, tam commercial SHA, lockfile hash'leri, edition,
  uygulama sürümü ve toolchain bilgisi taşır. Submodule güncellemesi incelenen bir
  değişikliktir. İki ayrı uzun ömürlü çekirdek kopyası tutulmaz.
- Public çekirdekte gereken genel extension noktaları public PR ile geliştirilir.
  Ücretli dosyalar public crate'in feature ile kapatılan alt klasörü olmaz.
  Community derleme grafiği private Git URL, private npm paketi veya private
  submodule gerektirmez. Lisans sunucusuna erişilemediğinde test/build bozulmaz.
- İki edition'ın ortak IPC ve veri modeli uyumu fixture ve contract testleriyle
  doğrulanır. Private build, gerçek cluster'a bağlanmadan çekirdek kontrollerini
  çalıştırır; ücretli özelliklerin demo/test örnekleri sentetiktir.
- Resmî release imzalama ve updater feed'i kontrollü pipeline'dan çıkar. Fork'lar
  kendi adlarını, imzalarını ve update endpoint'lerini kullanabilir. Resmî imza
  ürünün kaynağını doğrular; kullanıcıdaki programın değiştirilemez olduğunu
  garanti etmez.

### Kaynak ve paket sızıntısı sınırı

Bu ticari planlama belgeleri şu anda kullanıcının kamuya açık çekirdek için
kullandığı **yerel workspace'e** yazılıyor; bu çalışma onları yayınlamaz.
İş gizliliği isteniyorsa, **public push öncesinde** onaylı kopyaları özel planning
deposuna alınmalı ve public değişikliklerden çıkarılmalıdır. Tüm Kubepit deposunu
özel yapma önerisi yoktur. `.gitignore`, daha önce commit edilmiş veya yayınlanmış
bir belgenin geçmişini ortadan kaldırmaz. Mevcut yayın/geçmiş kontrolü ayrı bir
görevdir; geçmiş yeniden yazımı veya veri silme burada yapılmaz.

Ticari source map'ler, `sourcesContent`, debug symbol'lar, `.git`, özel kaynak
arşivleri, build log'ları, npm/Cargo publish girdileri ve CI artifact'leri
yayımlama öncesi allowlist ile denetlenir. Hata izleme için gereken map/symbol
dosyaları erişimi sınırlı özel depoda tutulur. Public source arşivi yalnız public
SHA'dan üretilir. OSS kaynak/nesne dosyası sağlama yükümlülüğü olan bağımlılıklar
varsa bunlar lisanslarına göre ayrıca sağlanır; özel kodu saklama hedefi lisans
uyumunun önüne geçmez.

Private kodu public repoya kopyalayıp minify etmek ayrım değildir. Masaüstüne
gönderilen JS ve binary tersine mühendisliğe açıktır; kaynak haritalarını kaldırmak
yanlışlıkla kaynak yayınını azaltır, yetkilendirme sağlamaz.

## 6. CI erişimi ve tedarik zinciri

GitHub, normal fork PR olaylarında repository secrets vermediğini ve
`GITHUB_TOKEN`'ın salt okunur olduğunu belgeler. Tasarım yalnız bu varsayılana
güvenmez: public CI'nın private depo erişimi ve ticari secrets'ı hiç olmaz.
[GitHub fork workflow davranışı](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories)

Proje için zorunlu kontroller:

1. Public PR: yalnız public kaynak, salt okunur token, sentetik fixture, community
   build. GitHub App/private checkout token'ı, imzalama anahtarı, ödeme anahtarı
   ve lisans imzalama anahtarı public repo secrets'ına konulmaz.
2. Commercial entegrasyon: özel depoda incelenmiş public SHA'yı alan job.
   Upstream PR kodu, dependency install script'i dâhil, değerlendirilmeden
   private source veya secret gören süreçte çalıştırılmaz.
3. Credential'lar repository/path ve amaç bakımından en dar kapsamla verilir;
   mümkünse kısa ömürlü GitHub App token'ı/OIDC kullanılır. Build, deploy,
   artifact publish ve imzalama ayrı yetkilere sahiptir.
4. Korunan branch, CODEOWNERS ve environment onayı imzalı release ile prod
   deployment'ı sınırlar. Action'lar commit SHA'ya sabitlenir. Private build
   cache ve artifact'leri public workflow'larla paylaşılmaz.
5. `pull_request_target` veya ayrı privileged workflow untrusted PR checkout'unu
   çalıştırarak güven sınırını aşmaz. Üst workflow'un artifact'leri güvenilir
   kabul edilmez. GitHub'ın bu olaylar ve cache poisoning için uyarıları release
   incelemesinin kontrol maddesidir.
   [GitHub secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
6. Release işi lisans manifesti/SBOM, dosya allowlist'i, secret taraması ve paket
   açılıp incelenmesi tamamlanmadan public upload yapmaz. Bir özel kaynak
   sızıntısında yayını durdurma, secret iptali gerekiyorsa iptal ve etki tespiti
   prosedürü vardır; kaynak kodu sızması ile secret sızması ayrılır.

## 7. Gerçekte ne korunur?

**Sunucu hizmeti:** Her ücretli istekte kimlik, kuruluş üyeliği, rol, aktif koltuk
ve entitlement sunucuda değerlendirilir. Request'teki `isPaid`, edition veya
client'ta görünen düğme kanıt değildir. Kullanıcının kendi hesabına ait bile olsa
başka tenant verisine erişim ayrı olarak reddedilir. Yetki sözleşmesindeki API
sürümleri ve feature id'leri sır sayılmaz.

**Yerel ücretli kod:** Lisans doğrulaması ve imzalı offline lease kullanılabilir;
ancak binary sahibi kontrolleri patch edebilir. Rust'a taşımak, obfuscation,
cihaz fingerprint'i veya public key saklamak bunu kesin olarak engellemez.
Özel implementasyonun lisansı, resmî dağıtım ve hizmet değeri birlikte ticari
koruma sağlar. Client içine provider secret, signing private key ya da ortak
“master license” yerleştirilmez.

**Fork ve yeniden uygulama:** Community fork kendi sunucusunu veya kendi cloud
entegrasyonunu yazabilir; bizim barındırılan hizmetimizi abonelik olmadan
kullanma hakkını elde etmez. Telif hakkı genel özellik fikrini tekelleştirmez.
ABD Copyright Office örneğinde fikirler, yöntemler ve sistemler telif kapsamı
dışındadır; bu bütün ülkelerdeki bütün patent, sözleşme ve marka sonuçlarını
çözmüş sayılmaz. Plan bağımsız yeniden implementasyonu imkânsız vaat etmez.
[U.S. Copyright Office: koruma kapsamı](https://www.copyright.gov/help/faq/faq-protect.html)

## 8. Marka ve ticari sözleşme paketi

Marka politikası, yazılım lisansından ayrı yayımlanır. Kubepit adı, logo, resmî
web sitesi, signing identity ve hizmet isimleri için sahiplik/uygunluk araştırılır.
Kayıt yapılmadan tescil iddiası veya ® işareti kullanılmaz. Hedef, değişmiş bir
fork'un resmî ürün olduğu izlenimini önlemek; OSS kodunun kullanımına ek yasak
getirmek değildir. Kaynak hakkında doğru atıf ve izin verilen tanımlayıcı
kullanımlar korunur. ASF'nin politikası bu ayrım için örnektir; Kubepit'e
kendiliğinden hak vermez.
[ASF marka politikası](https://www.apache.org/foundation/marks/)

Logo/görsel dosyalarının telif lisansı da marka hakkından ayrı incelenir.
İlk public yayında marka varlıklarının izin kapsamı açıkça belirlenir. Eğer
envanterde daha önce lisanslanmış bir varlık bulunursa onun copyright izni
sonradan marka belgesiyle sessizce daraltılmaz. Fork'lar markayı değiştirebilmeli;
zorunlu silinemez reklam veya lisansa ek “rakip olamazsın” hükmü eklenmemelidir.

Hukuk uzmanı için hazırlanacak belgelerin gereksinimleri:

| Belge                                   | Açıkça düzenlenecek konu                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Çekirdek alternatif ticari izin belgesi | Hak sahibi/dağıtıcı zinciri; kapsanan controlled core dosya/sürümleri; özel modüllerle birleştirme ve binary dağıtma izni; üçüncü taraflar için istisna olmadığı; varsa kurumsal/OEM kullanımın ayrı kapsamı |
| Ticari masaüstü EULA                    | Alternatif izinle sunulan controlled core ve özel bileşenlerin müşteri lisansı; kullanıcı/koltuk; cihazlar; süre; kullanım/yeniden dağıtım; bağımsız OSS lisansları ve zorunlu hukuk istisnaları             |
| Hizmet/abonelik koşulları               | Satıcı kimliği; 3 USD aylık/30 USD yıllık plan; dönem; otomatik yenileme; seat değişimi; iptal/iade; vergi; fesih; veri dışa aktarma ve hizmet kapanışı                                                      |
| Gizlilik bildirimi ve gerekiyorsa DPA   | Aktarılan veriler; controller/processor rolleri; alt işleyenler; saklama/silme; bölgeler/uluslararası aktarım; müşteri talepleri                                                                             |
| Güvenlik ve kabul edilebilir kullanım   | Tenant izolasyonu; abuse/rate limit; olay iletişimi; erişim askıya alma; yetkili güvenlik araştırması                                                                                                        |
| Marka politikası                        | Resmî dağıtımın tanımı; isim/logo kullanımı; değiştirilmiş dağıtımları ayırt etme; doğru atıf ve izin süreci                                                                                                 |
| OSS bildirim paketi                     | Community için AGPL ve kaynak sağlama; SDK için MIT; her edition'ın bağımlılık lisansları; gerekli NOTICE/attribution ve kaynak teklifleri; seçilen core lisans yolunu gösteren manifest ve SBOM             |

Bu tabloda sayılan hükümler hazır uygulanabilir hukuk metni değildir. Satıcının
yargı alanı, hedef ülkeler, bireysel/kurumsal müşteri yapısı, tüketici kuralları ve
ödeme sağlayıcı sözleşmesi belirlenmeden kesin fesih/iade/vergi hükümleri yazılmaz.
İptal sonucu ücretli haklar sona erebilir; müşterinin bağımsız OSS hakları sona
ermiş gibi ifade edilmez. EULA, bilerek ya da yanlışlıkla açığa çıkan private kodu
otomatik geri çağıran bir teknik mekanizma gibi sunulmaz.

## 9. Katkılar: DCO ve CLA

**Bu modelde dış katkı birleştirmeden önce, alternatif ticari lisanslama yetkisini
açıkça veren CLA gerekir.** Public CONTRIBUTING belgesi çekirdeğin AGPL public
ve commercial alternatif yollarını baştan anlatır. Katkıcı, hak sahibi olarak
katkıyı açık kaynak ve ticari/proprietary koşullarla dağıtma/alt lisanslama için
gerekli açık izni verir; bunun kapsamını hukuk uzmanı hazırlar. Copyright
assignment tek olası yöntem değildir; yeterli lisans grant'i de değerlendirilebilir.

DCO sign-off köken beyanı için ayrıca kullanılabilir. Katkıcının kodu ilgili
açık kaynak lisansı altında sunma hakkına dair beyan verir; tek başına assignment
veya **alternatif commercial yeniden lisanslama yetkisi sağlamaz**.
[Developer Certificate of Origin 1.1](https://developercertificate.org/)

Her CLA aynı yetkiyi vermez; Apache CLA örneği otomatik olarak Kubepit için
uygun sözleşme değildir. Patent izni, şirket adına katkı için işveren yetkisi,
katkıcının kendi haklarını koruması ve önceki katkılar ayrıca incelenir.
[ASF contributor agreements açıklaması](https://www.apache.org/licenses/contributor-agreements.html)

Commercial çalışan/contractor katkıları için ayrı IP ve gizlilik düzeni gerekir.
CLA kaydı commit/katkıcı ile izlenir. İzin vermeyen bir AGPL katkısı sessizce
commercial build'e alınmaz; merge öncesi reddetme/ayırma veya ayrı izin kararı
gerekir. Fork'taki AGPL değişikliği görülebiliyor olması upstream'in onu kapalı
üründe yeniden lisanslayabilmesi anlamına gelmez.
Kamuya açık issue/PR'a ücretli kaynak, müşteri verisi veya gizli implementasyon
gönderilmemesi katkı rehberinde anlatılır. Public katkıyı özel depoya taşımak o
katkının ilk lisans bildirimlerini ortadan kaldırmaz.

## 10. Uygulama işleri ve çıkış ölçütleri

| İş                                          | Çıktı                                                                                                             | Tamamlanma ölçütü                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 — Mülkiyet/yayın envanteri               | Dağıtılmadığı beyanı ve hak zinciri, katkıcılar, RunHQ/asset/bağımlılık kökenleri                                 | Controlled core AGPL ve commercial grant için yetki doğrulanmış; olası üçüncü taraf/önceki dağıtım istisnaları çözülmüş; reset yapılmamış  |
| L2 — Lisans geçiş değişikliği               | AGPL-3.0-only core + commercial alternatif; MIT SDK; özel LicenseRef manifesti                                    | Hak sahibi ve hukuki inceleme sonrası ayrı değişiklik; LICENSE, dört package manifesti, SPDX, README ve release bildirimleri tutarlı       |
| L3 — Katkı ve sözleşme taslakları           | Commercial relicensing grant'li CLA; CONTRIBUTING/isteğe bağlı DCO; core izin belgesi, EULA/ToS/privacy/DPA/marka | Dış katkı öncesi CLA kapısı çalışır; satıcı yetkisi ve üçüncü taraf/OSS istisnaları açık                                                   |
| L4 — Özel depo ve public extension contract | Sabit SHA assembly, kamuya açık bağımsız build, private erişim rolleri                                            | Temiz Community checkout private token/depo/service gerektirmeden build olur; ücretli kaynak public geçmişe girmemiş                       |
| L5 — İzole CI ve lisans envanteri           | Yetki ayrımı, dependency policy, hak grant kontrolü, SBOM/NOTICE, paket allowlist                                 | Fork PR private kaynak/secret/cache okuyamaz; public artifact'te premium source/map yok; commercial build'e izinsiz AGPL/GPL katkı giremez |
| L6 — İki edition release provası            | Community binary + karşılık gelen kaynak; commercial binary + alternatif izin manifesti                           | Aynı public SHA izlenebilir; seçilen lisans yolu açık; sentetik ortamda Community hesap/lisans sunucusu olmadan çalışır                    |
| L7 — Yayın öncesi denetim                   | Ticari planning belgelerinin private konumu, public diff ve release incelemesi                                    | İş gizliliği tercihine uygun içerik; yanlış public paketleme yok; onaylanmış sözleşmeler ve satıcı bilgisi yayıma hazır                    |

Bu işler birer review kapısıdır; bu belge yalnız planlama yapar. Repo oluşturma,
görünürlük değiştirme, kaynak taşıma, branch protection, secret oluşturma,
sözleşme kabul ettirme veya yayınlama işlemleri yapılmış sayılmaz.

## 11. Kaynak doğrulama notu

Yukarıdaki resmi lisans metinleri ve OSI, FSF, Mozilla, MariaDB, FSL, GitHub,
Linux Foundation/DCO, ASF ve U.S. Copyright Office kaynakları **2026-09-29**
tarihinde kontrol edildi. AGPL için OSI'nin yayımladığı özgün İngilizce lisans
metni kullanıldı. Bağlantılar ilgili iddiaların yanındadır.
Tablolardaki ürün, repo ve workflow tercihleri Kubepit için önerilen tasarımdır;
kaynakların Kubepit mimarisini veya hukuki sonucunu onayladığı iddia edilmez.
