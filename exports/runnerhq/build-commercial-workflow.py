#!/usr/bin/env python3
"""Build the reviewed RunHQ package. Does not import or execute its workflow."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import zipfile

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent.parent
OUT = BASE / 'kubepit-commercial'
SPECS = [
    'specs/2026-09-29-open-core-commercial-strategy.md',
    'specs/2026-09-29-commercial-licensing-and-repository.md',
    'specs/2026-09-29-commercial-cloud-design.md',
    'specs/2026-09-29-commercial-desktop-design.md',
    'plans/2026-09-29-commercial-program.md',
    'plans/2026-09-29-commercial-cloud.md',
    'plans/2026-09-29-commercial-desktop.md',
]

def write(path, value):
    path = OUT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding='utf-8')

def jwrite(path, value):
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')

for file in SPECS:
    dest = OUT / 'reference/docs/superpowers' / file
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'docs/superpowers' / file, dest)
for file in ['AGENTS.md', 'docs/ARCHITECTURE.md']:
    dest = OUT / 'reference' / file
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / file, dest)

tasks = {}
for prefix, name in [('C', 'cloud'), ('D', 'desktop')]:
    source = (ROOT / f'docs/superpowers/plans/2026-09-29-commercial-{name}.md').read_text()
    for match in re.finditer(r'^### Task (\d+): ([^\n]*)\n(.*?)(?=^### Task |^## |\Z)', source, re.M | re.S):
        tasks[f'{prefix}{match[1]}'] = match[0].strip()

def refs(prefix, start, end):
    return [f'{prefix}{n}' for n in range(start, end + 1)]

# Each task is owned exactly once. L4 is accepted at P06 after its P04 spike.
rows = [
 ('01', 'Başlangıç, ücretsiz ürün ve hak envanteri', ['D1'], ['L1'], 'baseline',
  'Record the free-feature baseline and rights/provenance evidence. Prepare a concrete proposed license change and unresolved ownership list as draft artifacts and record unresolved rights in EXTERNAL_GATES.md; continue technical implementation without a manual approval step.'),
 ('02', 'Özel workspace, ortak sözleşmeler ve lisans taslakları', refs('C',1,2), ['L2','L3'], 'cloud',
  'Prepare the exact proposed license transition as PRIVATE/docs/legal/proposed-license-transition.patch and draft CLA/EULA/privacy/terms. Preserve currently effective license declarations; mark L2 activation and unresolved rights as external pending, without stopping technical implementation. Do not invent ownership, seller identity or counsel approval. Establish all verification harness conventions in EXECUTION.md.'),
 ('03', 'Public edition SDK, React bootstrap ve Tauri host', refs('D',2,4), [], 'public',
  'Add the public SDK test command pnpm --filter @kubepit/edition-contracts test; the desktop Vitest suite alone does not cover this package. Keep the default community bootstrap intact.'),
 ('04', 'İki edition için erken build denemesi', ['D5'], [], 'composition',
  'Pin the reviewed, clean public HEAD established by the preceding automatic checkpoint agent. Build from that commit without patching vendor. Required here: actual current-host production builds with a clean public/vendor commit and the current private working-tree candidate; report its captured snapshot/content identity, not a fictional clean private HEAD. Other operating-system/signing evidence stays pending in EXTERNAL_GATES until actually available; no remote CI launch is implied. Stop if the composition strategy fails; do not broaden features or copy premium code into public.'),
 ('05', 'Public import, katkı katmanı ve terminal arayüzleri', ['D6'], [], 'public',
  'Implement generic core origin/contribution/read-only/PTY boundaries only. Test actual mutating backend paths against fake APIs. The next automatic checkpoint agent makes this public API a durable local commit before private consumers use it.'),
 ('06', 'Özel IPC, demo ve Rust/TS sözleşme uyumu', ['D7'], ['L4'], 'desktop',
  'Refresh vendor/kubepit to the clean public HEAD recorded by the preceding automatic checkpoint, then prove both editions still build. Freeze Rust/TS wire fixtures and prevent real network/process calls from the private demo.'),
 ('07', 'PostgreSQL tenancy, RLS, işler ve idempotency', refs('C',3,5), [], 'cloud',
  'Use PostgreSQL 17 with distinct owner/runtime/intake roles. Add an append-only AuditWriter storage port now for later billing/role mutations; finish its complete audit/redaction module in C20. No production no-op audit adapter.'),
 ('08', 'Kimlik, organizasyon, koltuk ve davetler', refs('C',6,10), [], 'cloud',
  'Exercise real authorization policy on test-only fixture endpoints if later profile routes are not yet present. A 404 on a nonexistent route is not proof of denial. Complete actual route coverage again in C19/C25. Use durable outbox/fake mail; no real notifications.'),
 ('09', 'Masaüstü oturumu ve imzalı lease doğrulama', refs('D',8,10), [], 'desktop',
  'Build against C2/C7 contracts and test signing keys. Real server lease interoperability is C17 after C16, not a prerequisite cycle. Store secrets in native secret-store adapters; use MemorySecretStore in automated tests.'),
 ('10', 'Paddle, abonelik, webhook ve entitlement servisi', refs('C',11,16), [], 'cloud',
  'Implement the fake provider and sandbox-compatible Paddle adapter without live merchant credentials. USD 3/month and USD 30/year, seat reservations, pending decrease, capacity_conflict, reconciliation, durable intake and ES256 leases must share server-authoritative policy.'),
 ('11', 'Kimlik ve lease uçtan uca uyumluluğu', ['C17'], [], 'interop',
  'Consume actual server-generated fixture leases in the Rust verifier and prove DPoP/revocation/clock/error behavior. Never mark this phase passed based only on independent mocked implementations.'),
 ('12', 'Güvenli CLI çalıştırma, EKS/GKE/AKS adaptörleri', refs('D',11,13), [], 'desktop',
  'Use portable fake executables, bounded output and argv construction. Never read or mutate real kubeconfig/provider credentials. Cover GKE account/plugin pinning, AWS scopes and Windows process handling.'),
 ('13', 'Bulut keşfi, atomik import ve kullanıcı akışları', refs('D',14,17), [], 'desktop',
  'Prove partial streaming/cancellation, private temporary kubeconfig, stable origins, staged rollback, explicit login and free post-expiry cluster use. Reuse public hooks. Any necessary new public change requires a reviewed durable pin checkpoint before mixed-build verification; never patch vendor.'),
 ('14', 'Profil şeması, güvenli önizleme ve yerel katmanlar', refs('D',18,21), [], 'desktop',
  'Use the C2/D7 canonical envelope; add bounded Rust validation and shared fixture corpus. No arbitrary secret-bearing fields. Shared executable action rows remain disabled until D24 implements backend trust gates.'),
 ('15', 'Profil API, revision, erişim ve audit', refs('C',18,20), [], 'cloud',
  'Use the existing Rust/shared profile corpus for server validation. Enforce current membership and seat access, ETag conditional writes, tombstones, tenant-safe exports, redaction and rate limits. No last-writer-wins loss.'),
 ('16', 'Profil sync, iptal/detach, komut güveni ve UI', refs('D',22,25), [], 'desktop',
  'Implement lifecycle-safe sync, explicit detach, content-hash trust and backend read_only checks. Verify two synthetic devices/users, conflicts and offline removal. No unattended command execution or automatic credential lookup from profile content.'),
 ('17', 'Web konsolu, ödeme akışları ve veri yaşam döngüsü', refs('C',21,23), [], 'cloud',
  'Complete EN/TR account/team/seat/device/billing/profile/export/deletion UX using existing RunHQ tokens. Purchased, assigned and reserved capacity must be distinct. Use fake providers and fake inbox only.'),
 ('18', 'Dağıtım varlıkları, izole CI ve restore provası', ['C24'], ['L5'], 'cloud',
  'Create reproducible local images, migration/rollback/restore runbooks and isolated CI declarations. Run real local PostgreSQL backup/restore; do not deploy or configure remote secrets. Audit source/artifact allowlists, notices, alternative grants and private cache boundaries.'),
 ('19', 'Bağımsız entegrasyon, yük ve iki edition kabulü', ['C25','D26'], ['L6'], 'full',
  'Run the full acceptance matrix, fixture-only load measurements and OSS isolation checks. Record unsupported OS/signing/manual checks as pending external gates, never as passes. Missing executable local acceptance evidence blocks PASS.'),
 ('20', 'Dağıtım belgeleri ve yayına hazırlık teslimi', ['C26','D27','D28'], ['L7'], 'handoff',
  'Produce a reviewed local release candidate and precise external-action register. Paddle seller/<$10 fee approval, authorized provider sandbox, signing, region/legal and OS evidence remain pending unless actually provided. PASS here means local handoff complete, never live-ready or launched. Do not execute production or publication actions.'),
]

PUBLIC = [
 ['pnpm','typecheck'], ['pnpm','i18n:check'], ['pnpm','test:ui'],
 ['cargo','fmt','--all','--','--check'],
 ['cargo','clippy','--workspace','--all-targets','--locked','--','-D','warnings'],
 ['cargo','test','--workspace','--locked'],
 ['pnpm','--filter','@kubepit/desktop','build'],
]
PRIVATE_TS = [['pnpm','typecheck'],['pnpm','contracts:check']]
PRIVATE_UI = PRIVATE_TS + [['pnpm','i18n:check'], ['pnpm','test:ui'], ['pnpm','build:desktop']]
PRIVATE_RS = [['cargo','fmt','--all','--','--check'], ['cargo','clippy','--workspace','--all-targets','--locked','--','-D','warnings'], ['cargo','test','--workspace','--locked']]

def job(repo, argv):
    return {'repo': repo, 'argv': argv}

def cloud_checks(ids):
    commands=[]
    for key in ids:
        if not key.startswith('C'): continue
        for command in re.findall(r'`(pnpm [^`\n]+)`', tasks[key]):
            if command in ['pnpm db:test:up','pnpm db:test:down','pnpm db:test:migrate','pnpm contracts:generate']: continue
            if command not in commands: commands.append(command)
    return [job('private', c.split()) for c in commands]

extra_tests = {
 '05':['edition_host'], '09':['auth_session','entitlements'],
 '11':['entitlements'], '12':['cloud_process','cloud_aws','cloud_gcp','cloud_azure'],
 '13':['cloud_discovery','cloud_import','cloud_login'],
 '14':['team_export','team_mapping','team_layers'],
 '16':['team_sync','team_lifecycle','team_actions'],
}
phases=[]
for num,title,ids,licenses,kind,note in rows:
    checks=[]
    if kind in ['baseline','public','composition','full'] or num=='06':
        checks += [job('public', c) for c in PUBLIC]
    if num in ['03','04','05','06','19','20']:
        checks.append(job('public',['pnpm','--filter','@kubepit/edition-contracts','test']))
    if kind in ['cloud','interop','full']:
        checks += [job('private', c) for c in PRIVATE_TS] + cloud_checks(ids)
    if kind in ['composition','desktop','interop','full']:
        checks += [job('private',c) for c in PRIVATE_UI+PRIVATE_RS]
        checks.append(job('private',['pnpm','test:contract']))
    if num in ['03','04','06']: checks.append(job('public',['pnpm','tauri:build:local']))
    if kind=='composition': checks.append(job('private',['pnpm','tauri:build:local']))
    for name in extra_tests.get(num,[]):
        repo='public' if num=='05' else 'private'
        crate='kubepit-core' if repo=='public' else 'kubepit-commercial'
        checks.append(job(repo,['cargo','test','-p',crate,'--test',name,'--locked']))
    if num=='14':
        checks += [job('private',['cargo','test','-p','kubepit-commercial','team::validate','--locked','--','--list']), job('private',['cargo','test','-p','kubepit-commercial','team::validate','--locked'])]
        checks[-2]['requireTestList']=True
    if num in ['18','19']: checks.append(job('private',['pnpm','verify:oss-boundary']))
    if num in ['19','20']: checks += [job('private',c) for c in [['pnpm','lint'],['pnpm','test:unit'],['pnpm','test:integration'],['pnpm','test:e2e'],['pnpm','build']]]
    if num=='20': checks += [job('public',c) for c in PUBLIC] + [job('private',c) for c in PRIVATE_UI+PRIVATE_RS]
    if num in ['19','20']: checks += [job('private',['node','scripts/load-fixtures.mjs'])]
    if num in ['19','20']: checks += [job('public',['pnpm','tauri:build:local']),job('private',['pnpm','tauri:build:local'])]
    if num=='20': checks += [job('private',['pnpm','test:contract']),job('private',['pnpm','contracts:check']),job('private',['pnpm','verify:oss-boundary']), job('private',['node','scripts/check-commercial-handoff.mjs'])]
    # Stable de-duplication; do not run duplicate full suites from overlapping tasks.
    unique=[]
    for c in checks:
        if c not in unique: unique.append(c)
    database = kind in ['cloud','interop','full','handoff'] or any(c['argv'][:2] == ['pnpm','test:contract'] for c in checks)
    phase={'id':f'p{num}','title':title,'tasks':ids,'licensing':licenses,'kind':kind,'note':note,'database':database,'checks':unique,'pinRequired':int(num)>=4 and num!='05'}
    phases.append(phase)

assert sorted(t for p in phases for t in p['tasks']) == sorted(tasks), 'Task coverage missing or duplicated'
assert sorted(l for p in phases for l in p['licensing']) == [f'L{i}' for i in range(1,8)]
jwrite('phase-map.json',{'schemaVersion':1,'cloudTasks':26,'desktopTasks':28,'licensingWorkstreams':7,'phases':phases})

common='''Read EXECUTION.md in the resolved RUNHQ_PACKAGE_ROOT before editing. The user explicitly requested automatic continuation without human approval steps. Its execution refinements supersede historical manual-checkpoint/no-commit instructions in the captured reference plans. Read the phase brief and all linked task acceptance criteria, plus current repository AGENTS.md and architecture. PUBLIC and PRIVATE mean only the two declared repositories beneath RUNHQ_WORKSPACE_ROOT. Package reference files are immutable evidence; never edit the captured package to make a check pass.

Implement only the assigned tasks, preserve unrelated work, and use meaningful red/green tests where required. Core remains account-free and independently buildable. Commercial code stays private. Pair Rust/TS contracts and EN/TR strings, maintain demos and ClusterDef.read_only. Use fixture data, fake CLIs, fake providers, MemorySecretStore and disposable PostgreSQL only. Do not read real kube/provider credentials, use live accounts or send real messages. Do not deploy, publish, push, reset history, change remote visibility, charge, create provider products or sign with production keys. Scoped local checkpoint commits and matching vendor-pin refreshes are authorized within this workflow as defined in EXECUTION.md. Never commit unrelated edits. Do not ask for routine continuation approval. No real sandbox calls without separate scoped user authorization.

Tests run in the subsequent captured shell gate. During implementation, run focused checks as needed. Missing scripts/tests, disabled tests, passWithNoTests, swallowed errors or empty suites cannot prove acceptance. Introduce the verification commands expected for this phase and implement their real behavior. Audit records and report files do not replace tests. Report files may be written only by implementation/fix agents in the private docs/workflow directory. Tests and the independent reviewer must validate their claims.

Return a concise Turkish report: completed task IDs, exact changed paths, checks/results, compatibility/pin changes and pending external gates. Report a blocker explicitly. The very last nonempty line must be exactly PIPELINE_RESULT: SUCCESS only when this phase's local scope is complete; otherwise PIPELINE_RESULT: BLOCKED or PIPELINE_RESULT: FAILED. Never emit multiple result markers, never PARTIAL. Do not claim a mock success is live-provider or legal approval.
'''
review='''You are the independent READ-ONLY reviewer for this phase. Read EXECUTION.md, the phase brief and reference task criteria from the resolved package root. Inspect only the RunHQ-provided immutable review snapshot at RUNHQ_WORKSPACE_ROOT, the captured diff/version identities, prerequisite test-gate output and supplied prior review/fix history. The two repository folders remain kubepit and kubepit-commercial in that snapshot. Do not inspect live originals or confuse a snapshot commit identity with a durable public HEAD.

Do not modify files, write report files, create worktrees, maintain counters, run builds/tests, install dependencies or invoke external services. The shell gate ran the tests before this snapshot; assess those results and test implementation. Your final response is the report RunHQ records. Require executable evidence and review correctness rather than accepting an implementer's checklist. Ensure no missing test scripts, trivial pass-only checks, wrong filtered zero-test success or production credential access. Check contracts, tenant boundaries, money/seat invariants, native secret ownership, profile action trust, read_only composition, OSS/private boundary, EN/TR and regressions relevant to this phase.

Only PASS unblocks the next phase. CONDITIONAL and FAIL both trigger bounded correction; never downgrade a real defect because the loop limit approaches. Missing external launch prerequisites may remain explicitly pending only where the phase brief scopes them out; local technical failures cannot be reclassified as external. L1 inventory PASS is not legal sign-off; P20 handoff PASS is not live-ready. External legal/merchant decisions are recorded as pending outside this technical workflow. They never cause an invented approval or an in-graph human pause; license activation/distribution remains unapplied when evidence is missing.

Return Turkish findings with severity, snapshot-relative file/line, concrete evidence, impact and required correction; include which acceptance criteria were checked. The last nonempty line must be exactly one of REVIEW_VERDICT: PASS, REVIEW_VERDICT: CONDITIONAL or REVIEW_VERDICT: FAIL, with no other result-marker line anywhere.
'''
for p in phases:
    key=p['id']
    brief=f"# {key.upper()} — {p['title']}\n\nAssigned tasks: {', '.join(p['tasks'])}. Licensing: {', '.join(p['licensing']) or 'none'}.\n\n{p['note']}\n\nRead the relevant captured specification and the licensing L-row criteria for every listed L-item. All requirements of the assigned task sections below apply; this brief does not replace their specifications.\n\n"
    brief += '\n\n'.join(tasks[t] for t in p['tasks'])+'\n'
    if p['licensing']:
        licensing=(ROOT/'docs/superpowers/specs/2026-09-29-commercial-licensing-and-repository.md').read_text()
        brief+='\n## Assigned licensing criteria\n\n'+ '\n'.join(line for line in licensing.splitlines() if any(f'| {l} —' in line for l in p['licensing']))+'\n'
    write(f'phases/{key}.md',brief)
    write(f'prompts/{key}-implement.md',f'# Implement {key}: {p["title"]}\n\nRead `phases/{key}.md` and its assigned checks in `phase-map.json` from the resolved package root.\n\n'+common)
    write(f'prompts/{key}-review.md',f'# Review {key}: {p["title"]}\n\nRead `phases/{key}.md` and `phase-map.json`.\n\n'+review)
    write(f'prompts/{key}-fix.md',f'# Correct {key}: {p["title"]}\n\nRead `phases/{key}.md`. Address all actionable findings from the immediately preceding review and regression-test the corrections. Use the attempt history supplied by RunHQ; do not invent report paths or a turn counter. Stay in this phase scope. If an upstream contract must change, update its tests and all affected consumers coherently; record the deviation. Public pin rules still apply.\n\n'+common)

checkpoint_prompt="""# Automatic public checkpoint after {phase}

The user requested automatic continuation. Read EXECUTION.md and the immediately preceding accepted PASS review, its immutable snapshot/version identities, test-gate evidence and exact changed-file list. This step replaces a manual checkpoint; do not request another routine approval.

Do not edit product source or rerun implementation. Confirm the current public content still matches the accepted snapshot/diff. Check staged, unstaged and untracked paths. Include the reviewed cumulative public changes since the previous durable HEAD (including earlier accepted phases such as D1), using their PRIVATE/docs/workflow records and the full accepted snapshot; do not mistake those for unrelated edits. Verify the staged diff exactly matches that accepted cumulative tree and intended paths, then stage only those reviewed public files by explicit paths. Exclude unrelated/private/generated/secret files. Never use blanket add, stash, clean, reset, amend, rebase, force or remote operations. If unexpected concurrent changes exist, do not absorb or discard them; return BLOCKED with exact paths.

Create a normal LOCAL public Git commit, using existing configured author/hook policy; do not invent an author identity or disable hooks. Verify public clean and record full SHA plus source tree identity in PRIVATE/docs/workflow/{phase}-checkpoint.md. If already clean on retry and HEAD contains the accepted tree, reuse it without an empty commit. This is a local recovery/build checkpoint, not a release/legal approval. The next implementation phase refreshes the private vendor pin from this durable SHA and runs normal tests/review. Do not modify the vendor here.

Return the verified SHA, exact committed paths and clean-tree result in Turkish. Last nonempty line: PIPELINE_RESULT: SUCCESS; if genuinely blocked or failed use PIPELINE_RESULT: BLOCKED or PIPELINE_RESULT: FAILED respectively, exactly once.
"""
steps=[]
previous=None

for p in phases:
    k=p['id']; title=p['title']
    agent={'backend':'codex','model':'','effort':'','lock':'kubepit-commercial-write','success':{'lastLineRegex':'^PIPELINE_RESULT: SUCCESS$'},'haltIf':{'lastLineRegex':'^PIPELINE_RESULT: (BLOCKED|FAILED)$'}}
    shell={'lock':'kubepit-commercial-write','command':f'node ./scripts/verify.mjs {k}','success':{'exitCode':0},'haltIf':{'exitCodeNot':0},'timeoutMinutes':180}
    steps += [
      {'id':f'{k}-implement','type':'agent','title':f'{k.upper()} Uygula · {title}','dependsOn':([previous] if previous else []),'promptFile':f'prompts/{k}-implement.md',**agent},
      {'id':f'{k}-verify','type':'shell','title':f'{k.upper()} Test ve build','dependsOn':[f'{k}-implement'],**shell},
      {'id':f'{k}-review','type':'agent','title':f'{k.upper()} Bağımsız inceleme','backend':'codex','model':'','effort':'','mode':'plan','dependsOn':[f'{k}-verify'],'promptFile':f'prompts/{k}-review.md','capture':{'verdict':{'lastLineRegex':'^REVIEW_VERDICT: (PASS|CONDITIONAL|FAIL)$','group':1}},'maxRuns':4},
      {'id':f'{k}-fix','type':'agent','title':f'{k.upper()} İnceleme düzeltmesi','dependsOn':[f'{k}-review'],'promptFile':f'prompts/{k}-fix.md','runIf':f"{k}-review.verdict != 'PASS' && {k}-review.runCount < 4",'maxRuns':3,**agent},
      {'id':f'{k}-fix-verify','type':'shell','title':f'{k.upper()} Düzeltme doğrulaması','dependsOn':[f'{k}-fix'],'maxRuns':3,'onSuccess':{'rerun':f'{k}-review'},**shell},
      {'id':f'{k}-accepted','type':'barrier','title':f'{k.upper()} PASS kabulü','dependsOn':[f'{k}-review'],'completeIf':f"{k}-review.verdict == 'PASS'",'haltIf':f"{k}-review.verdict != 'PASS' && {k}-review.runCount >= 4"},
    ]
    previous=f'{k}-accepted'
    if k in ['p03','p05']:
        checkpoint_id=f'{k}-checkpoint'
        write(f'prompts/{checkpoint_id}.md',checkpoint_prompt.format(phase=k))
        steps.append({'id':checkpoint_id,'type':'agent','title':f'{k.upper()} Otomatik yerel commit ve SHA kaydı','dependsOn':[previous],'promptFile':f'prompts/{checkpoint_id}.md',**agent})
        previous=checkpoint_id

manifest={
 'version':2,'generatedAt':'2026-09-30T00:00:00+03:00',
 'name':'Kubepit · Community + Commercial · Otomatik Uygulama',
 'description':'54 uygulama görevi + 7 lisans/depo iş akışı; 20 sıralı bölüm; 122 adım, test, bağımsız inceleme, en çok 3 düzeltme turu; insan onayı adımı yok. Sonuç yerel release candidate; otomatik yayın/tahsilat yok.',
 'package':{'selfContained':True,'install':[],'contents':['README.md','EXECUTION.md','phase-map.json','reference','phases','prompts','scripts'],'runtimeDirectory':'.'},
 'semantics':['Strict PASS only; CONDITIONAL and FAIL require correction. Four reviews and at most three fixes per phase.','All tasks are sequential across both repositories. Captured shell gate verifies before readonly snapshot review.','No human steps. Scoped local checkpoint commits and vendor-pin refreshes are automatic. No push/deploy/publication/live provider actions.','External legal/merchant/signing/sandbox/platform gates stay pending without actual evidence. Final acceptance is local handoff only.'],
 'settings':{
   'pathsRelativeTo':'pipelineFile','agentWorkingDirectory':str(ROOT.parent),'shellWorkingDirectory':'.','agentMode':'agent',
   'agentPermissions':['read','write','terminal'],'agentTimeoutMinutes':240,'shellTimeoutMinutes':180,
   'maxConcurrentUnlockedSteps':1,'locks':{'kubepit-commercial-write':{'maxConcurrent':1}},
   'review':{'maxReviewsPerPlan':4,'maxFixesPerPlan':3,'acceptConditionalFromReview':0,'strictPlans':[p['id'] for p in phases]},
   'failurePolicy':{'onMissingOrAmbiguousResultLine':'treatAsFailed','onHalt':'stopStartingNewSteps','runningStepsOnHalt':'letFinish','notifyHuman':True,'resume':'rerunHaltedStep'},
   'repositories':[{'name':'kubepit','path':str(ROOT),'branch':'main'},{'name':'kubepit-commercial','path':str(ROOT.parent/'kubepit-commercial'),'branch':'main'}],
   'resultLine':{'position':'last','trimTrailingWhitespace':True,'agentSteps':'^PIPELINE_RESULT: (SUCCESS|BLOCKED|FAILED)$','reviewSteps':'^REVIEW_VERDICT: (PASS|CONDITIONAL|FAIL)$'}
 },'steps':steps,
}
jwrite('pipeline.json',manifest)
source_hashes={str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((OUT/'reference').rglob('*')) if p.is_file() and p.name != 'SHA256SUMS.json'}
jwrite('reference/SHA256SUMS.json',source_hashes)

table='\n'.join(f'| {p["id"].upper()} | {p["title"]} | {", ".join(p["tasks"]+p["licensing"])} |' for p in phases)
write('PHASES.md','# Yürütme sırası\n\n| Bölüm | Amaç | Plan görevleri |\n| --- | --- | --- |\n'+table+'\n')
manifest['package']['contents'].append('PHASES.md')
jwrite('pipeline.json',manifest)

archive=BASE/'kubepit-commercial.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(OUT.rglob('*')):
        if p.is_file(): z.write(p,p.relative_to(OUT))
print(json.dumps({'steps':len(steps),'phases':len(phases),'tasks':len(tasks),'humanGates':sum(s['type']=='human' for s in steps),'archive':str(archive),'bytes':archive.stat().st_size},ensure_ascii=False))
