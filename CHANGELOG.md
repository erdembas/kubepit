# Changelog / Değişiklik günlüğü

This file is the source for Kubepit's user-facing release notes, with the newest changes first. “Unreleased” describes work that has not been published in a release yet.

Bu dosya, Kubepit'in kullanıcıya yönelik sürüm notlarının kaynağıdır; en yeni değişiklikler önce gelir. “Henüz yayımlanmadı”, bir sürümde henüz yayımlanmamış çalışmaları belirtir.

## [Unreleased] — Upcoming changes / Gelecek değişiklikler

### English

No changes yet.

### Türkçe

Henüz değişiklik yok.

## [0.0.7] - 2026-10-05 — Copyable details, per-view namespaces and Secret copying / Kopyalanabilir ayrıntılar, görünüm namespace'leri ve Secret kopyalama

### English

#### Added

- **Copy key fields in the details panel:** the values you most often need elsewhere are now click-to-copy in the details panel. Click an object's name, UID, a Pod's Pod IP or Host IP, or a Service's Cluster IP and external IPs to copy it straight to the clipboard; the namespace and a Pod's node get a small copy button beside their links. A toast confirms what was copied.
- **Service DNS name:** every Service's details now show its in-cluster DNS name — `name.namespace.svc.cluster.local`, built from the standard cluster DNS suffix — as a click-to-copy field. ExternalName services also show their `externalName` target, copyable the same way.
- **Copy Secrets to other namespaces:** every Secret's context menu and details "More" menu has a new "Copy to namespaces…" action. Pick one or more target namespaces (searchable, with select-all) and the Secret is re-created under its own name in each of them — same data, type, labels and annotations. A Secret that already exists in a target is never overwritten: that target fails with the API server's message while the rest of the copies proceed, and the summary toast reports what succeeded and what failed. The usual guards apply: read-only clusters block it, production clusters ask for the typed-name confirmation, and each copy is recorded in the change journal.
- **Per-view namespace scope:** each view tab now remembers its own namespace selection. Scoping Pods to `einvoice` no longer drags Ingresses, Helm releases or any other tab along — switch tabs and each one keeps the scope you left it on. A view you never scoped yourself follows the last explicit selection, and views that were never scoped at all fall back to the cluster's default namespace. The `:ns` command and `:kind <namespace>` now scope the view they open (the focused tab for `:ns`), and saved views keep restoring their namespaces into their own kind's tab.
- **Namespace picker moved into the view toolbar:** the multi-select namespace picker left the workbench header and now sits at the top of each view, left of its search field — Pods, Ingresses and every other resource list, plus GitOps, Health, Security, Cost, Helm releases and charts, the resource map, workloads overview, the network policy simulator, Changes, Recommendations, network diagnostics and My Permissions. The header keeps its terminal and create actions on the shared scope.

#### Changed

- The workbench header no longer shows the namespace picker; the terminal and "Create resource" buttons there use the last explicitly selected namespace (or the cluster default), not any one view's scope.

### Türkçe

#### Eklenenler

- **Ayrıntılar panelinde kritik alanları kopyalama:** başka yerlerde en çok ihtiyaç duyduğunuz değerler artık ayrıntılar panelinde tıklayınca panoya kopyalanıyor. Nesnenin adına, UID'sine, bir Pod'un Pod IP'sine veya Host IP'sine ya da bir Service'in Cluster IP'sine ve harici IP'lerine tıklayın; doğrudan panoya kopyalanır. Namespace ve Pod'un node'u için bağlantılarının yanında küçük bir kopyala düğmesi var. Bir bildirim neyin kopyalandığını gösterir.
- **Service DNS adı:** her Service'in ayrıntılarında artık küme içi DNS adı — standart küme DNS ekiyle kurulan `ad.namespace.svc.cluster.local` — tıklayarak kopyalanabilen bir alan olarak görünüyor. ExternalName servisleri de aynı şekilde kopyalanabilen `externalName` hedefini gösterir.
- **Secret'ları başka namespace'lere kopyalama:** her Secret'ın bağlam menüsünde ve ayrıntılardaki "Daha fazla" menüsünde yeni bir "Namespace'lere kopyala…" eylemi var. Bir veya daha fazla hedef namespace seçin (aranabilir, tümünü seç ile) ve Secret, her birinde kendi adıyla yeniden oluşturulur — aynı veri, tür, etiket ve ek açıklamalarla. Bir hedefte zaten var olan Secret asla üzerine yazılmaz: o hedef API sunucusunun iletisiyle başarısız olurken diğer kopyalar sürer; özet bildirimi neyin başarılı neyin başarısız olduğunu rapor eder. Alışılmış korumalar geçerlidir: salt-okunur kümeler eylemi engeller, production kümeleri adını yazma onayı ister ve her kopya değişiklik günlüğüne kaydedilir.
- **Görünüm başına namespace kapsamı:** her görünüm sekmesi artık kendi namespace seçimini anımsıyor. Pod'ları `einvoice` kapsamına almak artık Ingress'leri, Helm release'lerini veya diğer sekmeleri sürüklemez — sekmeler arasında geçiş yaptığınızda her biri, bıraktığınız kapsamda kalır. Kendi başına kapsam seçmediğiniz bir görünüm son açık seçimi izler; hiç kapsam seçilmemiş görünümler kümenin varsayılan namespace'ine düşer. `:ns` komutu ve `:kind <namespace>` artık açtıkları görünümü kapsar (`:ns` için odaktaki sekme), kayıtlı görünümler de namespace'lerini kendi türlerinin sekmesine geri yüklemeyi sürdürür.
- **Namespace seçici görünüm araç çubuğuna taşındı:** çoklu seçimli namespace seçici çalışma alanı başlığından çıktı ve artık her görünümün üstünde, arama alanının solunda duruyor — Pod'lar, Ingress'ler ve diğer tüm kaynak listeleri; ayrıca GitOps, Sağlık, Güvenlik, Maliyet, Helm release'leri ve chart'ları, kaynak haritası, iş yükleri genel görünümü, ağ politikası simülatörü, Değişiklikler, Öneriler, ağ tanılama ve Yetkilerim. Başlık, terminal ve oluşturma eylemlerini paylaşılan kapsamda tutar.

#### Değişiklikler

- Çalışma alanı başlığı artık namespace seçiciyi göstermiyor; oradaki terminal ve "Kaynak oluştur" düğmeleri son açıkça seçilen namespace'i (veya küme varsayılanını) kullanır, herhangi bir görünümün kapsamını değil.

## [0.0.6] - 2026-10-02 — Policy reports, time travel and preview tabs / Politika raporları, zaman yolculuğu ve önizleme sekmeleri

### English

#### Added

- **Policy reports in Security:** a new "Policy reports" tab in the Security view reads `wgpolicyk8s.io` PolicyReports and ClusterPolicyReports — what Kyverno, Falcosidekick and other policy engines write about the objects they evaluated. See totals by result (fail, error, warn, pass, skip), failing policies grouped by name with the objects they flagged and their worst severity, one row per report with its scope, and search across policy, rule, message and object. Reports open in the details panel with their scope, a filterable results list and table columns in their own right. The tab appears when the cluster serves the report kinds; when it does not, the tab offers the same one-click helm install as Trivy Operator — Kyverno is added with its repository and waited on, with the production confirmation, RBAC and read-only checks of every install, and the equivalent commands to run yourself. Reports may come from any engine, so when the kinds are served but empty the tab only says so. Policy and rule names, categories and messages are shown verbatim; only result words are translated.
- **State at a past time (change journal time travel):** the details Changes tab can now reconstruct an object's state at any recorded time and diff it with the live object. Every journaled change keeps a full normalized snapshot, so "the object at time T" is the last change at or before T — pick a time (or use 15 minutes / 1 hour / 6 hours ago) and see what changed since, including deletions and re-creations. Both sides are normalized like the journal (status, bookkeeping and noise annotations dropped; Secret values shown only as markers), bodies dropped for being too large fall back to the previous kept change with a notice, and times before the oldest known change — journal coverage plus whatever older history was loaded — stay explicitly unknown. Reading the state sends nothing to the cluster.
- **Preview tabs in the cluster navigator:** a single click in a cluster's left navigator now opens one reusable temporary tab, like VS Code's preview mode. Browsing kinds replaces the tab in place instead of piling up new ones; its label is italic while it is temporary. Double-click the navigator row or the tab itself (or pin it, drag it to another pane, or split with it) to make it permanent. Links, the command palette and other programmatic navigation always open permanent tabs.
- **Setting for how views open:** choose **Settings → General → View tabs** between "Open temporarily (preview)" (default) and "Open permanently" to make every navigator click open a permanent tab.
- **Details panel closes on workspace clicks:** clicking an empty area of the workspace now closes the open details panel, the same way Esc does — handy when clicking through resources without reaching for the keyboard. Clicks on tables, tabs, menus, dialogs, text selections and other interactive elements never close it, and in split layouts only the pane you click closes its panel. Turn it off in **Settings → General → Details panel** if you prefer closing it only with Esc or the close button.
- **CVE risk analysis with the assistant:** when the assistant is enabled, every CVE row in the security overview and the vulnerability sections of workload details has a sparkle action that asks the assistant to assess the risk. The analysis weighs how the affected workloads are exposed (services, ingresses, network reachability) against the severity, the installed and fixed versions and whether a fix exists, and leads with the verdict, the evidence and the smallest mitigation steps.
- **Keyboard shortcuts for the cluster navigator:** the left menu items in a cluster (Pods, Services, Ingresses, …) now have keyboard shortcuts shown as a badge on each row. The most-used kinds ship with defaults using Alt+1…9 (Overview, Pods, Deployments, Services, Ingresses, Namespaces, Nodes, ConfigMaps, Secrets); every other kind is unassigned by default. Press a chord while a cluster workbench is focused to jump straight to that kind. Edit, assign or clear any shortcut in **Settings → Keyboard → Navigator shortcuts** — click a field and press a key combination, Backspace clears it. A combination opens one kind; reassigning it moves it off the previous kind.
- **Context menu on navigator rows:** right-clicking a cluster navigator item now opens a menu with Open, Open permanently, Pin/Unpin, Assign shortcut and Clear shortcut instead of the webview's Reload/Inspect Element. “Assign shortcut” jumps straight to that kind's capture field in Settings → Keyboard.

#### Changed

- The production-cluster confirmation dialogs let you copy the word you are asked to type, so a long resource name can be pasted into the field instead of retyped. Pasting still requires the explicit confirm step; copying alone never confirms anything.

#### Fixed

- Closing a cluster's inner view tab no longer strands its tooltip in the top-left corner of the window. The tooltip now hides the moment its target leaves the DOM, and a zero-size target never pins a tooltip to the origin.

### Türkçe

#### Eklenenler

- **Güvenlik görünümünde politika raporları:** Güvenlik görünümündeki yeni "Politika raporları" sekmesi, `wgpolicyk8s.io` PolicyReport ve ClusterPolicyReport'ları okur — Kyverno, Falcosidekick ve diğer politika motorlarının değerlendirdikleri nesneler hakkında yazdıkları raporlar. Sonuca göre toplamlar (başarısız, hata, uyarı, geçti, atlandı), adlarına göre gruplanmış başarısız politikalar ile işaretledikleri nesneler ve en yüksek önem dereceleri, kapsam bilgisiyle her rapor için bir satır ve politika, kural, ileti ile nesne üzerinden arama görebilirsiniz. Raporlar; kapsamları, filtrelenebilir sonuç listeleri ve kendi tablo sütunlarıyla ayrıntılar panelinde açılır. Sekme, küme rapor türlerini sunuyorsa görünür; sunmuyorsa sekme, Trivy Operator'dakiyle aynı tek tıkla helm kurulumunu sunar — Kyverno deposuyla eklenir ve beklenir; her kurulumdaki production onayı, RBAC ve salt-okunur denetimleriyle birlikte, elle çalıştırılacak eşdeğer komutlar da gösterilir. Raporlar herhangi bir motordan gelebileceğinden, türler sunuluyor ama boşsa sekme yalnızca bunu belirtir. Politika ve kural adları, kategoriler ve iletiler olduğu gibi gösterilir; yalnızca sonuç sözcükleri çevrilir.
- **Geçmiş bir andaki durum (değişiklik günlüğünde zaman yolculuğu):** ayrıntılardaki Değişiklikler sekmesi artık kayıtlı herhangi bir anda nesnenin durumunu yeniden kurabiliyor ve canlı nesneyle karşılaştırabiliyor. Günlüğe alınan her değişiklik tam bir normalize edilmiş anlık görüntü tuttuğundan, "T anındaki nesne" yalnızca T'de veya öncesindeki son değişikliktir — bir zaman seçin (veya 15 dakika / 1 saat / 6 saat önce'yi kullanın) ve o zamandan beri neyin değiştiğini görün; silmeler ve yeniden oluşturmalar dahil. Her iki taraf da günlük gibi normalize edilir (status, defter kayıtları ve gürültü ek açıklamaları çıkarılır; Secret değerleri yalnızca işaretçi olarak gösterilir), tutulamayacak kadar büyük olduğu için gövdesi bırakılan değişiklikler bir uyarıyla önceki tutulan değişikliğe düşer ve bilinen en eski değişiklikten önceki zamanlar — günlük kapsamı artı yüklenen eski geçmiş — açıkça bilinmiyor olarak kalır. Durumu okumak kümeye hiçbir şey göndermez.
- **Küme gezgininde önizleme sekmeleri:** bir kümenin sol gezgininde tek tıklama artık VS Code'un önizleme kipinde olduğu gibi yeniden kullanılabilen tek bir geçici sekme açar. Türler arasında gezinmek yeni sekmeler yığmak yerine sekmeyi yerinde değiştirir; geçiciyken etiketi eğik yazıyla gösterilir. Kalıcı olması için gezgin satırına ya da sekmenin kendisine çift tıklayın (veya sabitleyin, başka bir pane'e sürükleyin, onunla bölme yapın). Bağlantılar, komut paleti ve diğer programatik gezinmeler her zaman kalıcı sekme açar.
- **Görünümlerin açılma biçimi ayarı:** **Ayarlar → Genel → Görünüm sekmeleri** bölümünden "Geçici aç (önizleme)" (varsayılan) ve "Kalıcı aç" arasında seçim yaparak gezgindeki her tıklamanın kalıcı sekme açmasını sağlayabilirsiniz.
- **Ayrıntılar paneli çalışma alanı tıklamasıyla kapanır:** çalışma alanının boş bir yerine tıklamak artık açık ayrıntılar panelini, Esc ile kapatıldığı gibi kapatır — klavyeye uzanmadan kaynaklar arasında tıklayarak gezinmek için pratik. Tablolar, sekmeler, menüler, iletişim kutuları, metin seçimleri ve diğer etkileşimli öğelere yapılan tıklamalar paneli asla kapatmaz; bölünmüş düzende yalnızca tıkladığınız bölme kendi panelini kapatır. Yalnızca Esc veya kapatma düğmesiyle kapanmasını tercih ediyorsanız **Ayarlar → Genel → Ayrıntılar paneli** bölümünden kapatabilirsiniz.
- **Asistan ile CVE risk analizi:** asistan etkinleştirildiğinde güvenlik genel görünümündeki ve iş yükü ayrıntılarındaki güvenlik açıklığı bölümlerindeki her CVE satırında, riski asistana değerlendirten bir kıvılcım eylemi bulunur. Analiz, etkilenen iş yüklerinin nasıl maruz kaldığını (servisler, ingress'ler, ağdan erişilebilirlik) önem derecesi, kurulu ve düzeltilmiş sürümler ve bir düzeltmenin olup olmamasıyla karşılaştırır; sonuçta önce hüküm, ardından kanıtlar ve en küçük hafifletme adımları öne çıkar.
- **Küme gezgini için klavye kısayolları:** bir kümenin sol menüsündeki öğelerde (Pods, Services, Ingresses, …) artık klavye kısayolları var ve her satırda bir rozet olarak gösterilir. En çok kullanılan türler Alt+1…9 ile öntanımlıdır (Genel Bakış, Pod'lar, Deployment'lar, Servisler, Ingress'ler, Namespace'ler, Node'lar, ConfigMap'ler, Secret'lar); diğer türler varsayılan olarak atamasızdır. Bir küme çalışma alanı odaktayken bir tuş bileşimine basarak doğrudan o türe atlayabilirsiniz. Kısayolları **Ayarlar → Klavye → Gezgin kısayolları** bölümünde düzenleyebilir, atayabilir veya temizleyebilirsiniz — alana tıklayıp tuş bileşimine basın, Backspace temizler. Bir bileşim tek bir türü açar; yeniden atamak önceki türden kaldırır.
- **Gezgin satırlarında bağlam menüsü:** bir küme gezgini öğesine sağ tıklamak artık webview'in Reload/Inspect Element menüsü yerine Aç, Kalıcı aç, Sabitle/Kaldır, Kısayol ata ve Kısayolu temizle seçeneklerini içeren bir menü açar. “Kısayol ata”, Ayarlar → Klavye bölümünde o türün atama alanına doğrudan konumlanır.

#### Değişiklikler

- Production cluster onay iletişimlerinde yazmanız istenen kelimeyi kopyalayabilirsiniz; uzun bir kaynak adını yeniden yazmak yerine alana yapıştırabilirsiniz. Yapıştırmak yine açık onay adımını gerektirir; kopyalamak tek başına hiçbir şeyi onaylamaz.

#### Düzeltilenler

- Bir kümenin iç görünüm sekmesi kapatıldığında tooltip'i artık pencerenin sol üst köşesinde takılı kalmıyor. Tooltip, hedefi DOM'dan ayrıldığı an gizleniyor ve sıfır boyutlu bir hedef hiçbir zaman tooltip'i köşeye sabitlemiyor.

## [0.0.5] - 2026-10-02 — PVC usage in Overview / Genel Bakış'ta PVC doluluğu

### English

#### Added

- **PVC usage in Overview:** below TLS certificates, see up to five PVCs with the highest current usage across all namespaces. Each row shows the namespace, used and total capacity, and a usage percentage; click a row to open the PVC details. Usage is highlighted at 80% for warning and 90% for critical.
- The card requires Prometheus `kubelet_volume_stats_used_bytes` and `kubelet_volume_stats_capacity_bytes` metrics. Only PVCs with valid measurements are included; the card stays hidden when none are available. Ranking uses the current percentage and does not predict when a volume will fill.
- The last available metrics remain visible with a warning and Retry action if a refresh fails. Prometheus warnings flag a potentially incomplete ranking, and the card shows when it was last updated.

### Türkçe

#### Eklenenler

- **Genel Bakış'ta PVC doluluğu:** TLS sertifikalarının altında, tüm namespace'ler arasında anlık doluluk oranı en yüksek beş PVC'ye kadar gösterilir. Her satırda namespace, kullanılan ve toplam kapasite ile doluluk yüzdesi bulunur; satıra tıklayarak PVC ayrıntılarını açabilirsiniz. %80'de uyarı, %90'da kritik renk kullanılır.
- Kart, Prometheus'ta `kubelet_volume_stats_used_bytes` ve `kubelet_volume_stats_capacity_bytes` metriklerini gerektirir. Yalnızca geçerli ölçümü bulunan PVC'ler listelenir; hiç ölçüm yoksa kart gizlenir. Sıralama anlık yüzdeye dayanır, hacmin ne zaman dolacağını tahmin etmez.
- Yenileme başarısız olursa son metrikler uyarı ve Yeniden dene seçeneğiyle görünür kalır. Prometheus uyarıları, sıralamanın eksik olabileceğini belirtir; kartta son güncelleme zamanı gösterilir.

## [0.0.4] - 2026-10-01 — Safer operations and fleet troubleshooting / Daha güvenli işlemler ve filo tanılaması

<!-- kubepit-actions: image-matrix,fleet-search,investigations,connection-doctor,network-diagnostics -->

### English

#### Added

- **Configuration impact review:** before saving ConfigMap or Secret data, inspect the affected keys, workload containers and reference modes. Environment variables, mounted files, projected volumes, subPath mounts and image-pull credentials have distinct refresh explanations. After a successful save, select supported controllers for a reviewed restart; production, GitOps, permissions and read-only checks still apply. The consumer view can also be opened without editing data.
- **Guided Pod troubleshooting:** open a Pod's **Diagnosis** tab to bring current container states, failure reasons, recent events, configuration references and available memory observations together. Crash loops, OOM termination, scheduling, image-pull and configuration failures include evidence and a next check. Read bounded previous-container logs on demand, open related resources, or save an investigation.
- **Fleet image version matrix:** open **Image version matrix** from the fleet navigator, command palette or changelog. Compare Deployment, StatefulSet and DaemonSet container images across up to eight selected clusters, filter by namespace or workload, and isolate differences. Inspect workload templates, Pod spec references, runtime-reported image references, container readiness and runtime image IDs grouped by reported platform. Click through to the workload for further investigation.
- **Node maintenance review and progress:** inspect a read-only plan before draining a node. Review affected and skipped Pods, unmanaged workloads, disruption-budget restrictions and local-volume risks before any cordon. A reviewed drain rechecks the plan and object identities, then reports eviction outcomes and subsequent Pod observations separately so an accepted eviction is not mistaken for a ready replacement.
- **Saved Fleet searches:** save a query together with its resource types and scope, give it a name, and pin frequent searches below the search field. Reopen, rename, pin or remove searches from **Saved searches**. Restoring a search applies all three settings together; a removed scope is reported instead of silently searching all clusters.
- **Investigation comparison:** use **Compare snapshots** in a saved investigation to compare two captures of the same workload, entirely offline. Inspect the saved manifest diff, Pod states and restart observations, and changes in captured events. Coverage gaps and recreated workloads remain explicit.
- **What's new after an upgrade:** see a short summary once when the installed version increases, covering the releases since the last seen installed version. First launch establishes a baseline. **Preview highlights** in the changelog also lets you revisit a release or preview Unreleased work without changing that history.
- **Feature shortcuts in release notes:** open the image matrix, saved Fleet searches, investigations, Connection doctor or Network diagnostics directly from the relevant changelog entry. Cluster-specific shortcuts offer a cluster picker; opening a shortcut does not connect a cluster or start a diagnostic probe.
- **Changelog in the app and on the website:** read English or Turkish version notes from **Settings → About & Updates**, including offline access and a version selector. The website adds `/changelog/` and `/tr/changelog/` pages. All views use this file as their source; Unreleased work stays separate from numbered release notes and downloadable packages.
- **Saved investigations:** capture a workload's current object, related Pods, recent events, bounded container log tails, recorded changes and available metrics in a frozen local record. Start from **Start investigation** on a Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob; choose a 15- or 60-minute lookback. Missing permissions, unavailable sources, timeouts and truncated evidence remain visible in the record.
- **Investigation notes and offline access:** name investigations, save notes, reopen them after restarting Kubepit, and browse records even when their cluster is disconnected or has been removed. Open **Investigations** in the navigator, **Open saved investigations** from the fleet dashboard or disconnected cluster screen, or `:investigations` in the command bar. **Capture again** creates a new record and preserves the original evidence.
- **Reviewed investigation bundles:** import and export portable JSON bundles without a cluster connection. Known credentials and literal environment values are masked before storage; imported and exported content is checked again. Choose which evidence sections to include, inspect the exact export preview and confirm it before saving. Unsaved note edits must be saved before export; delete and discard actions require confirmation.
- **Connection doctor:** run staged checks for kubeconfig and context, the configured authentication helper, DNS/network or proxy reachability, TLS, Kubernetes API access, authenticated identity and common namespace permissions. Open it from the connection screen, the navigator or `:doctor`; use its **Edit cluster** and **Tools** shortcuts to address findings. Reports distinguish failures, warnings and skipped checks, and separate RBAC denial, read-only restrictions and unknown results.
- **Connection capability details:** check access to namespace and Pod browsing, Pod watches, container logs, metrics, Helm release Secrets, Pod shells and Deployment changes. Local `kubectl`/`helm` availability and metrics API availability are reported separately from permission to use them.
- **Live network diagnostics:** select an existing running Pod and container, a target Service, its TCP port, and TCP, HTTP or HTTPS probes. Open **Network diagnostics** in the navigator or use `:network`. Results show DNS and TCP connectivity, TLS verification for HTTPS, and HTTP HEAD status where applicable, with the executed source, target, command, duration and bounded output.
- **Service context for network checks:** inspect Service selectors, ClusterIP or ExternalName, and EndpointSlice readiness and addresses alongside probe results. Partial or unavailable endpoint data is marked explicitly. A shortcut opens the existing Network Policy Simulator for further inspection.
- **Smart Fleet search:** get suggestions for `kind:`, `ns:`, `cluster:`, `env:` and `label:` filters, including discovered custom resource kinds, known namespaces, registered clusters and observed label keys and values. Completed filters appear as removable inline tags. Use arrow keys to navigate, Enter or Tab to select, Escape to dismiss, and Backspace in an empty input to reopen the last tag for editing.

#### Changed

- Fleet search understands quoted filter values, so names such as `cluster:"Production Europe"` stay together. Existing aliases, comma-separated kind/cluster/environment lists, name globs and `/regex/` searches remain available. Label filters support equality, inequality, key presence and absence, including `app=api`, `app!=api`, `label:app`, `!app` and explicit empty values.
- Suggestions follow the current search scope, kinds and known namespace context. They use metadata already available from opened views and previous searches; typing does not start discovery requests or connect a cluster. Users can still enter their own filter values.
- Incomplete or invalid filters stay editable instead of becoming tags or silently broadening a search. Manually entered valid filters can be committed without accepting an unrelated suggested value.
- The investigation, connection and network workflows include English and Turkish interfaces and browser-demo implementations. Demo diagnostic results are clearly identified as synthetic or simulated.

#### Fixed

- Cluster names containing spaces, commas, quotes or backslashes are preserved when selected from Fleet search suggestions and parsed as quoted values.
- Fleet result highlighting now uses the parsed name query, keeping quoted filter values out of the highlighted text while preserving regular-expression name patterns.

#### Notes

- Configuration impact uses standard Kubernetes references in the edited namespace. Partial scans and unsupported consumers remain explicit. Mounted-file refresh does not establish that the application reloads the file; Secret values are not fetched for consumer discovery. Configuration writes reject a changed reviewed UID or resource version. Restarts revalidate workload identity and spec, then apply an atomic resource-version precondition.
- The image matrix joins Pod ownership by UID and matches rows by kind, namespace, workload and container name. Disconnected or unreadable data remains unknown; init containers are separate. Different runtime digests can be valid for different platforms or OCI indexes. No registry lookup, newest-version inference or automatic deployment is performed. Each source is processed up to 10,000 objects and the table displays up to 500 matching rows.
- Pod diagnosis reflects available observations, not a guaranteed root cause. Current memory metrics do not prove memory use at the moment of an earlier failure. Previous logs depend on what the node still retains. Maintenance preflight is a bounded observation, not a scheduler simulation or a guarantee of uninterrupted service; live permissions, admission and disruption budgets remain authoritative.
- Saved searches are local to this device, with up to 50 records and eight pins. They store search settings, not results. Comparison requires matching saved cluster and workload identities; imported bundles lack a local cluster ID and cannot be compared. Missing sampled Pods or events do not prove creation or deletion; restart deltas require the same Pod UID and container. Masked values cannot be compared.
- Automatic upgrade summaries include only numbered releases up to the installed version. Unreleased notes are available by explicit preview and never imply an installed update.
- Investigation capture requires an already connected cluster and works with read-only clusters. It is a bounded snapshot, not a complete historical archive: capture samples up to three Pods and two regular containers per Pod, with up to 200 log lines per tail. Changes and metrics depend on the data already recorded or available. Storage holds up to 50 investigations; a portable bundle is limited to 1 MiB. Automatic masking cannot identify every sensitive value in logs or notes; review the exact export and omit sections as needed.
- Connection doctor does not change Kubernetes resources, start the normal cluster session or change its connection status. It may run the authentication helper configured in kubeconfig, and checks finish within one minute. Capability results cover common operations in the selected namespace; admission policies, individual resources and other namespaces can impose different restrictions.
- Network probes require Pod exec permission and a writable cluster. They use tools already installed in the selected container; missing or incompatible tools are reported as unavailable. Each probe has an eight-second limit and an 8 KiB output cap. HTTP uses HEAD without redirects or response bodies; paths cannot include query strings or fragments. Results describe the tested Service path and do not establish which NetworkPolicy caused a failure. The audit history records the diagnostic action without storing the request path or probe output.
- Browser-demo investigations use separate browser-local storage. Demo connection and network diagnostics do not run local tools or contact a cluster; ExternalName network targets are reported as unavailable in the demo. Search suggestions reflect known, bounded metadata rather than an exhaustive cluster inventory.

### Türkçe

#### Eklenenler

- **Yapılandırma etki incelemesi:** ConfigMap veya Secret verisini kaydetmeden önce etkilenen anahtarları, iş yükü container’larını ve referans biçimlerini inceleyin. Ortam değişkenleri, bağlı dosyalar, projected volume’lar, subPath mount’ları ve imaj çekme kimlik bilgileri için güncellenme davranışı ayrı açıklanır. Başarılı kayıttan sonra desteklenen controller’ları seçip incelenerek yeniden başlatın; production, GitOps, izin ve salt okunur kontrolleri uygulanır. Kullanım görünümü veri düzenlenmeden de açılabilir.
- **Yönlendirmeli Pod tanılaması:** bir Pod’un **Tanılama** sekmesinde güncel container durumlarını, hata nedenlerini, son olayları, yapılandırma referanslarını ve mevcut bellek gözlemlerini birlikte inceleyin. Yeniden başlatma döngüsü, OOM sonlanması, zamanlama, imaj çekme ve yapılandırma hatalarında kanıt ve sonraki kontrol gösterilir. İsteğe bağlı olarak sınırlandırılmış önceki container loglarını okuyun, ilgili kaynakları açın veya bir inceleme kaydedin.
- **Filo imaj sürüm matrisi:** filo gezgininden, komut paletinden veya değişiklik günlüğünden **İmaj sürüm matrisi** görünümünü açın. Deployment, StatefulSet ve DaemonSet container imajlarını en fazla sekiz seçili kümede karşılaştırın; namespace veya iş yüküne göre filtreleyip farkları gösterin. İş yükü şablonlarını, Pod tanımındaki imaj referanslarını, runtime’ın bildirdiği imaj referanslarını, container hazırlığını ve bildirilen platforma göre gruplanmış çalışan imaj kimliklerini inceleyin. Ayrıntılı inceleme için iş yüküne geçin.
- **Node bakım incelemesi ve ilerleme:** node’u boşaltmadan önce salt okunur planı inceleyin. Etkilenen ve atlanan Pod’ları, controller’sız iş yüklerini, kesinti bütçesi kısıtlamalarını ve yerel volume risklerini herhangi bir cordon işleminden önce görün. İncelenen drain, planı ve nesne kimliklerini yeniden denetler; ardından tahliye sonuçlarını ve sonraki Pod gözlemlerini ayrı gösterir. Tahliyenin kabul edilmesi, yerine gelen Pod’un hazır olmasıyla karıştırılmaz.
- **Kayıtlı filo aramaları:** sorguyu kaynak türleri ve kapsamıyla birlikte kaydedin, adlandırın ve sık kullanılan aramaları arama alanının altına sabitleyin. **Kayıtlı aramalar** bölümünden aramaları açın, yeniden adlandırın, sabitleyin veya kaldırın. Bir arama açıldığında üç ayar birlikte uygulanır; kapsam kaldırılmışsa tüm kümelerde arama yapmak yerine durum bildirilir.
- **İnceleme karşılaştırması:** kayıtlı bir incelemede **Anlık görüntüleri karşılaştır** ile aynı iş yükünün iki kaydını tamamen çevrimdışı karşılaştırın. Kayıtlı manifest farkını, Pod durumlarını ve yeniden başlatma gözlemlerini, kaydedilmiş olaylardaki değişiklikleri inceleyin. Eksik kanıtlar ve yeniden oluşturulmuş iş yükleri açıkça belirtilir.
- **Güncelleme sonrası yenilik özeti:** kurulu sürüm yükseldiğinde, son görülen kurulu sürümden sonraki yayınları kapsayan kısa özet bir kez gösterilir. İlk açılış başlangıç sürümünü kaydeder. Değişiklik günlüğündeki **Özeti önizle** ile bu geçmişi değiştirmeden bir sürümü yeniden inceleyebilir veya henüz yayımlanmamış çalışmaları görebilirsiniz.
- **Sürüm notlarından özelliklere kısayollar:** ilgili değişiklik günlüğü kaydından imaj matrisini, kayıtlı filo aramalarını, incelemeleri, bağlantı tanılamayı veya ağ tanılamayı açın. Kümeye özel kısayollarda küme seçici gösterilir; kısayolu açmak kümeye bağlanmaz veya tanılama denetimi başlatmaz.
- **Uygulamada ve sitede değişiklik geçmişi:** İngilizce veya Türkçe sürüm notlarını **Ayarlar → Hakkında ve Güncellemeler** bölümünde çevrimdışı okuyun ve sürüm seçicisiyle geçmişe göz atın. Siteye `/changelog/` ve `/tr/changelog/` sayfaları eklendi. Tüm görünümler bu dosyayı kaynak olarak kullanır; henüz yayımlanmamış çalışmalar, numaralı sürüm notlarından ve indirilebilir paketlerden ayrı gösterilir.
- **Kayıtlı incelemeler:** bir iş yükünün güncel nesnesini, ilgili Pod'larını, son olaylarını, sınırlandırılmış container loglarını, kaydedilmiş değişikliklerini ve mevcut metriklerini sabit bir yerel kayıtta saklayın. Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job veya CronJob üzerinde **İnceleme başlat** eylemini kullanın; 15 veya 60 dakikalık aralık seçin. Eksik izinler, erişilemeyen kaynaklar, zaman aşımları ve kısaltılmış kanıtlar kayıtta açıkça gösterilir.
- **İnceleme notları ve çevrimdışı erişim:** incelemelere ad verin, notları kaydedin, Kubepit'i yeniden başlattıktan sonra açın ve kümeleri bağlı olmasa veya kaldırılmış olsa bile kayıtları inceleyin. Gezginden **İncelemeler** bölümünü, filo panosundan ya da bağlantısı kesilmiş küme ekranından **Kayıtlı incelemeleri aç** düğmesini veya komut çubuğunda `:investigations` komutunu kullanın. **Yeniden kaydet** yeni bir kayıt oluşturur ve özgün kanıtları korur.
- **İncelenerek paylaşılan inceleme paketleri:** küme bağlantısı olmadan taşınabilir JSON paketlerini içe ve dışa aktarın. Bilinen kimlik bilgileri ve doğrudan yazılmış ortam değişkeni değerleri saklanmadan önce maskelenir; içe ve dışa aktarılan içerik yeniden denetlenir. Eklenecek kanıt bölümlerini seçin, dışa aktarılacak dosyanın tam önizlemesini inceleyin ve kaydetmeden önce onaylayın. Dışa aktarmadan önce not değişiklikleri kaydedilmelidir; silme ve değişiklikleri atma işlemleri onay gerektirir.
- **Bağlantı tanılama:** kubeconfig ve bağlam, yapılandırılmış kimlik doğrulama yardımcısı, DNS/ağ veya proxy erişimi, TLS, Kubernetes API erişimi, doğrulanmış kimlik ve yaygın namespace izinleri için aşamalı denetimler çalıştırın. Bağlantı ekranından, gezginden veya `:doctor` komutuyla açın; bulguları gidermek için **Cluster'ı düzenle** ve **Araçlar** kısayollarını kullanın. Raporlar hata, uyarı ve atlanan denetimleri; RBAC reddi, salt okunur kısıtlamaları ve bilinmeyen sonuçları ayrı gösterir.
- **Bağlantı yeteneklerinin ayrıntıları:** namespace ve Pod listeleme, Pod değişikliklerini izleme, container logları, metrikler, Helm sürüm Secret'ları, Pod terminalleri ve Deployment değişiklikleri için erişimi denetleyin. Yerel `kubectl`/`helm` araçlarının ve metrik API'sinin bulunması, bunları kullanma izninden ayrı gösterilir.
- **Canlı ağ tanılama:** mevcut ve çalışan bir Pod ile container'ını, hedef Service'i, TCP portunu ve TCP, HTTP veya HTTPS denetimlerini seçin. Gezginden **Ağ tanılama** bölümünü veya `:network` komutunu açın. Sonuçlar DNS ve TCP bağlantısını, HTTPS için TLS doğrulamasını ve uygun olduğunda HTTP HEAD durumunu; kullanılan kaynak, hedef, komut, süre ve sınırlandırılmış çıktıyla birlikte gösterir.
- **Ağ denetimlerinde Service bağlamı:** denetim sonuçlarının yanında Service selector'larını, ClusterIP veya ExternalName bilgisini, EndpointSlice adreslerini ve hazır olma durumlarını inceleyin. Kısmi veya alınamayan endpoint verisi açıkça belirtilir. Bir kısayol, daha ayrıntılı inceleme için mevcut Ağ Politikası Simülatörü’nü açar.
- **Akıllı filo araması:** `kind:`, `ns:`, `cluster:`, `env:` ve `label:` filtreleri için öneriler alın; keşfedilmiş özel kaynak türlerini, bilinen namespace'leri, kayıtlı kümeleri ve gözlemlenmiş etiket anahtarları ile değerlerini seçin. Tamamlanan filtreler, arama alanında kaldırılabilir etiketler olarak görünür. Ok tuşlarıyla gezinin, Enter veya Tab ile seçin, Escape ile önerileri kapatın; boş girişte Backspace ile son filtreyi yeniden düzenlemeye açın.

#### Değişiklikler

- Filo araması tırnak içindeki filtre değerlerini anlar; `cluster:"Production Europe"` gibi adlar bölünmez. Mevcut kısaltmalar, virgülle ayrılmış tür/küme/ortam listeleri, adlarda glob kalıpları ve `/regex/` aramaları kullanılabilir. Etiket filtreleri `app=api`, `app!=api`, `label:app`, `!app` ve açıkça belirtilmiş boş değerler dâhil eşitlik, eşitsizlik, anahtarın varlığı ve yokluğu koşullarını destekler.
- Öneriler güncel arama kapsamını, kaynak türlerini ve bilinen namespace bağlamını izler. Açılmış görünümlerden ve önceki aramalardan elde edilmiş üst veriyi kullanır; yazarken keşif isteği başlatılmaz veya kümeye bağlanılmaz. Kullanıcı kendi filtre değerini de girebilir.
- Eksik veya geçersiz filtreler etikete dönüştürülmek ya da aramanın kapsamını sessizce genişletmek yerine düzenlenebilir kalır. Elle yazılmış geçerli filtreler, ilgisiz bir önerilen değer kabul edilmeden tamamlanabilir.
- İnceleme, bağlantı ve ağ iş akışları İngilizce ve Türkçe arayüzlerle ve tarayıcı demosuyla çalışır. Demo tanılama sonuçlarının örnek veri veya simülasyon olduğu açıkça belirtilir.

#### Düzeltmeler

- Filo arama önerilerinden seçilen; boşluk, virgül, tırnak veya ters eğik çizgi içeren küme adları korunur ve tırnak içindeki değerler olarak doğru ayrıştırılır.
- Filo sonuçlarındaki vurgulama artık ayrıştırılmış ad sorgusunu kullanır; tırnaklı filtre değerleri vurgulanacak metne karışmaz, düzenli ifadeyle yazılan ad kalıpları korunur.

#### Notlar

- Yapılandırma etkisi, düzenlenen namespace’teki standart Kubernetes referanslarını kullanır. Kısmi taramalar ve desteklenmeyen kullanımlar açıkça belirtilir. Bağlı dosyanın güncellenmesi, uygulamanın dosyayı yeniden okuduğunu göstermez; kullanan kaynaklar keşfedilirken Secret değerleri alınmaz. Yapılandırma yazımları, incelenen UID veya kaynak sürümü değişmişse reddedilir. Yeniden başlatmalar iş yükünün kimliğini ve spec alanını tekrar doğrular, ardından atomik kaynak sürümü önkoşuluyla uygulanır.
- İmaj matrisi Pod sahipliğini UID ile çözer; satırları tür, namespace, iş yükü ve container adına göre eşleştirir. Bağlantısı olmayan veya okunamayan veri bilinmiyor olarak kalır; init container’lar ayrıdır. Farklı platformlarda veya OCI indekslerinde farklı çalışan imaj digest değerleri geçerli olabilir. Registry sorgusu, en yeni sürüm çıkarımı veya otomatik dağıtım yapılmaz. Her kaynaktan en fazla 10.000 nesne işlenir; tabloda en fazla 500 eşleşen satır gösterilir.
- Pod tanılaması mevcut gözlemleri yansıtır; kesin kök neden garantisi vermez. Güncel bellek metrikleri önceki hatanın oluştuğu andaki kullanımı kanıtlamaz. Önceki loglar node’un hâlâ sakladığı veriye bağlıdır. Bakım ön kontrolü sınırlı bir gözlemdir; scheduler simülasyonu veya kesintisiz hizmet garantisi değildir. Güncel izinler, admission ve kesinti bütçeleri belirleyici olmaya devam eder.
- Aramalar bu cihazda yerel olarak tutulur; en fazla 50 kayıt ve sekiz sabitleme desteklenir. Arama ayarları saklanır, sonuçlar saklanmaz. Karşılaştırma için kayıtlı küme ve iş yükü kimlikleri eşleşmelidir; içe aktarılan paketler yerel küme kimliği taşımadığından karşılaştırılamaz. Örneklerde eksik olan Pod veya olaylar oluşturulma ya da silinmeyi kanıtlamaz; yeniden başlatma farkları aynı Pod UID'si ve container'ı gerektirir. Maskelenmiş değerler karşılaştırılamaz.
- Otomatik yenilik özeti yalnızca kurulu sürüme kadar olan numaralı yayınları içerir. Henüz yayımlanmamış notlar isteğe bağlı önizlemede gösterilir; kurulu bir güncellemeyi ifade etmez.
- İnceleme kaydı, önceden bağlanılmış bir küme gerektirir ve salt okunur kümelerde de çalışır. Kayıt, tam bir geçmiş arşivi değil, sınırlandırılmış bir anlık görüntüdür: en fazla üç Pod, Pod başına iki normal container ve her log kuyruğunda en fazla 200 satır örneklenir. Değişiklikler ve metrikler, önceden kaydedilmiş veya erişilebilir veriye bağlıdır. En fazla 50 inceleme saklanır; taşınabilir paket sınırı 1 MiB'dir. Otomatik maskeleme, log ve notlardaki her hassas değeri belirleyemez; tam dışa aktarma önizlemesini inceleyin ve gereken bölümleri çıkarın.
- Bağlantı tanılama Kubernetes kaynaklarını değiştirmez, normal küme oturumunu başlatmaz ve bağlantı durumunu değiştirmez. Kubeconfig'te yapılandırılmış kimlik doğrulama yardımcısını çalıştırabilir; denetimler bir dakika içinde tamamlanır. Yetenek sonuçları seçilen namespace'teki yaygın işlemleri kapsar; admission ilkeleri, tekil kaynaklar ve diğer namespace'ler farklı kısıtlamalar uygulayabilir.
- Ağ denetimleri Pod exec izni ve yazılabilir bir küme gerektirir. Seçilen container'da zaten kurulu olan araçları kullanır; eksik veya uyumsuz araçlar kullanılamıyor olarak gösterilir. Her denetimin süre sınırı sekiz saniye, çıktı sınırı 8 KiB'dir. HTTP, yönlendirmeleri izlemeden ve yanıt gövdesini almadan HEAD kullanır; yolda sorgu parametresi veya fragment bulunamaz. Sonuçlar denenen Service yolunu açıklar; hataya hangi NetworkPolicy'nin neden olduğunu belirlemez. İşlem geçmişi, istek yolunu ve denetim çıktısını saklamadan tanılama eylemini kaydeder.
- Tarayıcı demosundaki incelemeler, tarayıcıya ait ayrı yerel depoda tutulur. Demo bağlantı ve ağ tanılaması yerel araçları çalıştırmaz veya kümeye erişmez; ExternalName ağ hedefleri demoda kullanılamıyor olarak gösterilir. Arama önerileri, kümenin eksiksiz envanterini değil, bilinen ve sınırlandırılmış üst veriyi yansıtır.

## 0.0.3 — Linux process cleanup fix / Linux süreç temizleme düzeltmesi

### English

- Replace the Unix custom-action cleanup shell command with a direct, validated process-group signal. This fixes Linux timeout and background-pipe cleanup that could otherwise terminate processes outside the intended child group. Invalid process IDs are ignored; Windows behavior is unchanged.
- Identify 0.0.1 and 0.0.2 as affected versions; do not install or continue using them. Their source tags and original release bytes remain unchanged.
- Migration: manually install a published 0.0.3 or later package once available. Version 0.0.1 has no updater public key; 0.0.2 introduced it but predates this correction. Version 0.0.3 combines the process cleanup fix with signed-update support.

### Türkçe

- Unix özel eylem temizliğindeki kabuk komutu, doğrulanmış süreç grubuna doğrudan sinyal gönderimiyle değiştirildi. Linux'ta zaman aşımı ve arka plan pipe temizliğinin hedef alt süreç grubunun dışındaki süreçleri sonlandırabilmesi düzeltildi. Geçersiz süreç kimlikleri yok sayılır; Windows davranışı değişmez.
- 0.0.1 ve 0.0.2 etkilenen sürümler olarak belirtilir; bu sürümleri kurmayın veya kullanmaya devam etmeyin. Kaynak etiketleri ve özgün yayın dosyaları değiştirilmez.
- Geçiş: 0.0.3 veya daha yeni bir paket yayımlandığında elle kurun. 0.0.1 güncelleyici açık anahtarı içermez; anahtarın eklendiği 0.0.2 bu düzeltmeden öncedir. 0.0.3, süreç temizleme düzeltmesini imzalı güncelleme desteğiyle birleştirir.

## 0.0.2 — Signed updates / İmzalı güncellemeler

### English

**Affected by the Linux cleanup bug; use 0.0.3 or later once published.**

- Check for updates after startup and every five minutes when automatic checks are enabled. A dismissible announcement presents the new version, release notes and explicit download/install controls without repeatedly announcing the same version.
- Show download progress and a restart action after installation; protect checks and installation from overlapping across application windows.
- Require Developer ID signing and Apple notarization for new macOS release packages. Verify signed update artifacts for all six desktop targets and publish the update feed through GitHub Pages.
- Refresh the Homebrew cask every six hours after verifying release metadata and checksums. Website version labels follow verified published releases; unchanged metadata no longer triggers redundant browser asset requests.
- Historical migration design: v0.0.1 has no updater public key; v0.0.2 introduced it. This version is affected by the Linux cleanup bug: install a published v0.0.3 or later package once available. Linux updates preserve AppImage, DEB or RPM format; package-manager installation may request administrator permission.

### Türkçe

**Linux temizleme hatasından etkilenir; yayımlandığında 0.0.3 veya sonrasını kullanın.**

- Otomatik denetim açıksa açılıştan sonra ve her beş dakikada bir güncelleme kontrol edilir. Kapatılabilir duyuru yeni sürümü, sürüm notlarını ve kullanıcının başlattığı indirme/kurulum seçeneklerini sunar; aynı sürümü tekrar tekrar duyurmaz.
- İndirme ilerlemesi ve kurulumdan sonra yeniden başlatma seçeneği gösterilir; farklı uygulama pencerelerindeki kontrollerin ve kurulumların çakışması önlenir.
- Yeni macOS sürüm paketlerinde Developer ID imzası ve Apple noter onayı zorunludur. Altı masaüstü hedefinin imzalı güncelleme paketleri doğrulanır ve güncelleme akışı GitHub Pages üzerinden yayımlanır.
- Homebrew cask dosyası, sürüm bilgileri ve sağlama toplamları doğrulandıktan sonra altı saatte bir güncellenir. Sitedeki sürüm etiketleri doğrulanmış yayınları izler; değişmemiş bilgiler için gereksiz tarayıcı indirme istekleri yapılmaz.
- Tarihsel geçiş tasarımı: v0.0.1 güncelleyici açık anahtarı içermez; anahtar v0.0.2'de eklendi. Bu sürüm Linux temizleme hatasından etkilenir; v0.0.3 veya daha yeni bir paket yayımlandığında onu kurun. Linux güncellemeleri AppImage, DEB veya RPM biçimini korur; paket yöneticisiyle kurulum yönetici izni isteyebilir.

## 0.0.1 — Initial public release / İlk herkese açık sürüm

### English

**Affected by the Linux cleanup bug; use 0.0.3 or later once published.**

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

**Linux temizleme hatasından etkilenir; yayımlandığında 0.0.3 veya sonrasını kullanın.**

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
