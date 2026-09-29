# Uygulayıcı ve inceleyici sözleşmesi

Bu paket, yedi planın uygulanabilir RunHQ uyarlamasıdır. İçe aktarma uygulamayı başlatmaz. Kullanıcının son talimatı doğrultusunda workflow başlatıldıktan sonra ajanlar test/inceleme sonuçlarına göre otomatik ilerler; grafikte insan onayı adımı yoktur. Referans belgelerindeki “planning only” notları, bu dosyanın oluşturulmasıyla kod uygulanmadığını anlatır; bu export işleminin uygulamayı kendiliğinden çalıştırdığını ifade etmez. Son otomatik yürütme talimatı, eski referanslardaki manuel checkpoint ve otomatik commit yapmama varsayımlarının önündedir.

## Dosya ve görev otoritesi

1. Kullanıcının son açık talimatları; rutin devam onayı istemeden otomatik yürütme.
2. Mevcut depoların AGENTS.md güvenlik, IPC, UI ve EN/TR kuralları.
3. Bu dosya, `phase-map.json` görev sahipliği ve bölüm brief'leri.
4. `reference/docs/superpowers/` içindeki yedi tasarım/planın ilgili kabul kriterleri.

Çelişkiyi sessizce çözerek kapsamı genişletme. Somut farkı raporla. Eski team-sharing/cloud-import planları alternatif uygulama talimatı değildir. L1–L7 hedefleri izlenir; bu otomatik teknik teslimde çözülmemiş hukuki/hizmet etkinleştirme kriterleri ayrı pending statüsündedir. AI incelemesi hak sahipliği/hukuki onayın yerine geçmez. L1–L3 için tamamlanmış hak envanteri ve somut taslaklar teknik PASS alabilir; gerçek lisans geçişi yapılmış sayılmaz.

`RUNHQ_PACKAGE_ROOT` yakalanmış paket köküdür; değiştirilemez doğrulama girdisi gibi ele al. `RUNHQ_WORKSPACE_ROOT` implement/fix/shell adımlarında iki deponun ortak ebeveyni, bağımsız review adımında salt okunur snapshot ebeveynidir. Alt adlar **kubepit** ve **kubepit-commercial** olarak kalır. Yalnız bu iki kayıtlı depoda çalış; ebeveyn klasördeki başka projeleri keşfetme/değiştirme. RunHQ çözümlenmiş yolları prompt bağlamında JSON olarak da verir. Review sırasında canlı checkout'a gitme.

Her implement/fix ajanı `PRIVATE/docs/workflow/pNN.md` içine görev kimlikleri, değişiklik kapsamı, exact test komutları/sonuçları, pinler, sapmalar ve gerçek engelleri yazar. P01 ayrıca `license-proposal.md`, P02 öneri/taslak statüsünü, kanıt kaynaklarını ve bekleyen lisans etkinleştirmesini açıkça içeren `license-decision.md` üretir. Bu kayıtlar inceleme girdisidir; doğruluk kanıtı olarak tek başına yeterli değildir. Review ajanı dosya yazmaz; sonucu RunHQ kaydeder.

## Lisans ve dış kararlar

P01 hak envanterinin tamamlandığına karar verebilir; bu hakların doğrulandığı veya lisans geçişinin hukuken onaylandığı anlamına gelmez. P01 belirsiz hakları EXTERNAL_GATES.md içine kaydeder ve teknik işe devam eder. P02 geçişin tam dosya/metadata değişikliğini `PRIVATE/docs/legal/proposed-license-transition.patch` olarak hazırlar; etkin LICENSE/dependency lisanslarını otomatik değiştirmez. L2 “taslak hazır, etkinleştirme bekliyor” statüsünde kalır. Çözümlenmemiş hukuki karar için workflow ortasında onay beklenmez. AGPL ile yasal fork/ticari kullanımın yasaklandığını söyleme. Alternatif commercial grant üçüncü taraf kodunu kapsıyormuş gibi davranma.

Şirket/ülke, Paddle seller ve 10 USD altı fiyat onayı, gerçek sandbox, region, gizlilik/saklama, imzalama ve işletim sistemi kanıtları ayrı dış kapılardır. Eksikler sahte “PASS” olmaz. Teknik fixture geliştirmesi, kimlik/provider secrets uydurmadan devam eder. P20 PASS yalnız yerel teslim paketinin tamamlandığı anlamına gelir; eksik dış kapılar `PRIVATE/docs/workflow/EXTERNAL_GATES.md` içinde sahibi, gerekli kanıtı ve engellenen eylemiyle açık kalır. Bu workflow gerçek sandbox çağrısı, canlı tahsilat, mesaj gönderimi, üretim deployment'ı veya yayın çalıştırmaz. İstenen gerçek sandbox provası ayrı açık kapsam/onayla yürütülür ve sonradan kanıt olarak eklenir.

## Git ve kalıcı public pin

RunHQ doğrudan checkout'lara yazar. Bu otomatik workflow'da ajanların gerekli, açık kapsamlı **yerel checkpoint commitleri** ve vendor-pin güncellemeleri yapması yetkilidir; otomatik push/merge/yayın yoktur. P03 ve P05 PASS sonrasında checkpoint ajanı kabul edilen snapshot/diff ile canlı public içeriğin hâlâ eşleştiğini kontrol eder; yalnız incelenmiş dosyaları açık yollarla stage edip commit yapar. Temiz retry durumunda mevcut doğru HEAD yeniden kullanılır. `git add -A`, körlemesine stash/clean, reset, amend/rebase, `.git` silme ve force-push yoktur. Kullanıcının eşzamanlı/ilgili olmayan değişiklikleri commit kapsamına katılmaz. Snapshot kimliği kalıcı public HEAD yerine geçmez.

P04, P03 checkpoint'inin temiz public HEAD'ini pinler ve erken composition denemesini bitirir. P05 yalnız public origin/contribution/PTY API'lerini ekler. P06, ikinci otomatik checkpoint'ten gelen HEAD'i pinleyip iki edition'ı tekrar doğrular. Rutin commit/pin için kullanıcıdan devam onayı istenmez.

Sonraki implement/fix fazında private build için yeni public değişiklik kaçınılmazsa ajan sadece kendi görev dosyalarını ve scope listesini kontrol eder, ilgili public testleri çalıştırır, bu dosyalarla yeni bir **yerel entegrasyon checkpoint'i** oluşturur ve vendor pinini günceller. Bu commit henüz bağımsız inceleme kabulü değildir: ardından normal shell gate ve bağımsız snapshot review zorunludur. Review düzeltmesi gerekirse geçmişi değiştirmeden yeni commit eklenir. Tek taraflı contract değişimi veya test atlama yoktur. Public HEAD temiz ve vendor eşleşmiş olmadan private gate geçmez; ajan bunu aynı görev içinde otomatik tamamlar. İlgisiz/eşzamanlı kullanıcı değişiklikleri varsa bunları otomatik stage/discard etmez; gerçek çatışmayı açık raporlar.

Vendorda patch, symlink ile canlı public'e bağlama veya uncommitted dosya kopyalama çözüm değildir. P19/P20 manifestinde public SHA ve private çalışma ağacı/snapshot durumu dürüstçe belirtilir. Private kaynak gerekiyorsa aynı açık dosya kapsamı ve test koşullarıyla normal yerel checkpoint yapılabilir. Commit; hukuki onay, review PASS veya publication yerine geçmez.

## Test harness: P02'nin ek uygulama sözleşmesi

Bu paketin `scripts/verify.mjs` dosyası kodu doğrulama komutlarını kendisi seçer. Eksik script/test başarısızdır. Ajan yakalanmış dosyayı veya `phase-map.json` listesini kolay geçmek için değiştiremez. Somut test dosyası isimleri bu pakette yürütülebilir sözleşmedir; plan yalnız örnek isim verdiyse ilgili gerçek suite'i bu isimle oluştur.

P02 private harness'i şu değişkenleri okuyacak biçimde kurar:

| Girdi | Anlam |
| --- | --- |
| `KUBEPIT_TEST_MODE=fixtures` | Fake IdP/Paddle/mail, real client seçilemez |
| `KUBEPIT_SECRET_STORE=memory` | Otomatik testler OS keychain açmaz |
| `KUBEPIT_TEST_NETWORK=loopback-only` | Test HTTP transport'ları yalnız yerel fake server'a gider; metadata/link-local veya dış provider adresi reddedilir |
| `KUBEPIT_TEST_RUN_ID` | Bu gate'in benzersiz fixture sahibi; aynı makinedeki farklı test DB'sine dokunulmaz |
| `KUBEPIT_TEST_DATABASE_FILE` | Gate'in temp dizininde, test PostgreSQL bağlantı manifestinin mutlak yolu |
| `KUBEPIT_HOME`, `KUBEPIT_COMMERCIAL_HOME`, `KUBECONFIG` | Gate'in ürettiği geçici/sentetik state yolları |

`pnpm db:test:up`, sadece **yerel Docker context** üzerinde izole PostgreSQL 17'i başlatır. DB adı `kubepit_test_` önekli; rastgele yerel port ve fixture-only roller kullanılır. Manifesti `{ "run_id": "<aynı run id>", "url": "postgresql://<yalnız test kimliği>@127.0.0.1:<port>/kubepit_test_<id>" }` biçiminde yazar. App/test runtime rolü owner değildir; owner/intake yolları gerektiğinde ayrı fixture alanlarıyla yönetilir. URL/log'a gerçek secret yazılmaz. Harness `.env` veya production DATABASE_URL'e fallback yapmaz. `db:test:migrate` ve DB kullanan integration/contract/e2e suite'leri bu run'ın manifestini okuyup hostname/name/run-id güvenliğini **bağlantıdan önce** kontrol eder. `db:test:down` yalnız aynı run'ın oluşturduğu container/volume kaynaklarını kapatır; yoksa idempotent biçimde tamamlanır. Saf unit/policy/fixture testleri DB manifestine bağımlı değildir. Tam `test:contract` ilerleyen fazlarda gerçek API/DB uyumu da içerdiğinden, bu komutu çağıran her gate test PostgreSQL sağlar. Her testte gereksiz global DB reset yapılmaz.

Captured gate hesap/provider env değişkenlerini aktarmayan dar bir process environment oluşturur, kube/cloud config yollarını temp'e yönlendirir, gerçek CLI adlarını PATH'te reddeden shim'ler koyar. Bunlar OS sandbox garantisi değildir: test kodu da verilen adapters/paths ve fake executables kullanmalı; gerçek credential/keychain veya mutlak cloud CLI yollarına erişmemelidir. Fixture CLI'lar testin ürettiği mutlak executable yollarıdır. Mevcut güvenli package/tool cache yolları korunur; kullanıcı HOME'u değiştirilmez.

P03 SDK paketi `@kubepit/edition-contracts` adını ve gerçek `test` script'ini sunar; mevcut desktop Vitest yalnız başına SDK'yı kapsamıyor. P12 ek provider suite adları `cloud_process`, `cloud_aws`, `cloud_gcp`, `cloud_azure`; P13 fake PTY/login/cancellation suite'i `cloud_login` olarak yaratılır. Rust `team::validate` filtresinin `--list` çıktısında test yoksa gate başarısızdır. `passWithNoTests`, `--if-present`, `|| true`, pass-only script ve boş assertion “kanıt” değildir.

C25 kapsamında `scripts/load-fixtures.mjs` gerçek production build üzerinde 50 eşzamanlı metadata istemcisini yalnız bu run'ın loopback API/DB ve fake provider'larıyla çalıştırır. API/worker süreçlerini bu çalışma için başlatıp finally kapatır; dış URL'yi reddeder; ölçülmüş p50/p95, webhook intake, kuyruk/pool/metrik ve maliyet varsayımlarını secret olmadan raporlar. p95 metadata <500 ms ve webhook intake <2 s eşikleri aşılırsa nonzero çıkar. P19 ve final kaynak değişikliklerinden sonra P20 gate'i bu script'i üretim build'inden sonra gerçekten çalıştırır; yazılı tahmin yeterli değildir.

P20 `scripts/check-commercial-handoff.mjs` oluşturur: final manifest/evidence referansları, dosya hash'leri, public SHA/vendor eşleşmesi, test sonuçlarının son kaynak sürümüne aidiyeti, L1–L7 statüsü ve EXTERNAL_GATES satırlarının sahibi/gereken kanıtını doğrular. Eksik yerel kanıt veya hatalı hash'te nonzero çıkış yapar; dış kapının hâlâ pending olması yerel handoff'u geçersiz yapmaz ama live-ready iddiasını reddeder. Bu script hukuki/merchant onayı icat edemez. İnceleyici script'in gerçek kontrollerini de okur.

## Fazlar arası bağımlılıklar

- C2 ortak politika/profile envelope sözleşmesini D7'den önce dondurur; D18 Rust validator'ü geliştirir; C18 gerçek fixture uyumunu doğrular.
- D9, C2 ve C7 fixture'larını kullanır. C16'nın gerçek signer fixture'ları ancak C17'de Rust verifier ile birleştirilir; D9 ↔ C17 döngüsü yaratma.
- C8 daha sonra gelecek profile route'u için 404'ü yetki başarısı saymaz. Paylaşılan policy test endpoint'i kullanılır, gerçek profile-route matrisi C19/C25'te tekrar kanıtlanır.
- C13/C15'in ihtiyaç duyduğu append-only audit port/storage temeli C3–C5 sırasında hazırlanır. C20 modülü ve tam redaction/abuse matrisini bitirir. Production no-op audit yoktur.
- C9 davetleri C10'dan önce durable outbox/fake transport ile sınanabilir. D21'de shared action satırları D24 trust bitene kadar disabled kalır.
- DB migration sıra numaraları ve ortak sözleşmeler tek sahipte kalır; bölüm içi subagent'lar ancak ayrı dosyalarda çalışabilir.

## İnceleme ve durma davranışı

Her bölüm: implement → shell verify → bağımsız review. Review PASS değilse en çok üç kez fix → shell reverify → aynı review yeniden çalışır. Dördüncü review hâlâ PASS değilse kapı durur. Teknik shell/agent hatası da durur; RunHQ'nun Retry işlemiyle ilgili adım tekrarlanır. Test hatasının kendi kendine reviewer döngüsüne aktarılacağını varsayma.

`accepted` barrier yalnız review'a bağlıdır; atlanan fix'e bağlanmaz. `completeIf` PASS, `haltIf` son turda non-PASS olur. Iterative barrier'a `requirePass` eklenmez: bu RunHQ sürümünde ilk FAIL'de düzeltmeyi durdurabilir. Grafikte human adımı yoktur. PASS sonrası bir sonraki bölüm otomatik açılır; P03/P05 sonrasında önce otomatik checkpoint ajanı çalışır. RunHQ ayarında otomatik ilerleme açık tutulur. Bütün yürütme sıralıdır; tek global write lock ve concurrency 1 vardır.

Reviewer ayrı snapshot'ta kodu ve gate çıktısını inceler. Test/build/rapor dosyası yazmaz, canlı repo/credential'a erişmez. Son cevap tek `REVIEW_VERDICT` satırıyla biter; RunHQ tüm raporu ve denemeyi kaydeder. Implement/fix son satırı yalnız `PIPELINE_RESULT: SUCCESS|BLOCKED|FAILED` olur. Eksik/çelişkili sonuç satırı başarısızdır.
