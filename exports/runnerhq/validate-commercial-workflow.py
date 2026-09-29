#!/usr/bin/env python3
"""Static integrity/coverage checks. RunHQ's real importer must also be checked."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

base = Path(__file__).resolve().parent
root = base / 'kubepit-commercial'
manifest = json.loads((root / 'pipeline.json').read_text())
phase_map = json.loads((root / 'phase-map.json').read_text())
phases = phase_map['phases']
steps = {s['id']: s for s in manifest['steps']}
assert len(steps) == len(manifest['steps']) == 122
assert len(phases) == 20
tasks = [t for p in phases for t in p['tasks']]
expected = [f'C{i}' for i in range(1,27)] + [f'D{i}' for i in range(1,29)]
assert len(tasks) == len(set(tasks)) == 54 and set(tasks) == set(expected)
assert sorted(t for p in phases for t in p['licensing']) == [f'L{i}' for i in range(1,8)]
assert sum(s['type']=='human' for s in steps.values()) == 0
assert all(s['maxRuns']==4 for s in steps.values() if 'capture' in s)
assert not any(s['type']=='human' for s in steps.values())
assert steps['p01-implement']['dependsOn']==[]
for p,n in [('p03','p04'),('p05','p06')]:
    assert steps[p+'-checkpoint']['type']=='agent'
    assert steps[p+'-checkpoint']['dependsOn']==[p+'-accepted']
    assert steps[n+'-implement']['dependsOn']==[p+'-checkpoint']
assert all(s.get('success',{}).get('lastLineRegex')=='^PIPELINE_RESULT: SUCCESS$' for s in steps.values() if s['type']=='agent' and 'capture' not in s)
seen=set()
while len(seen)<len(steps):
    ready={i for i,s in steps.items() if all(d in seen for d in s.get('dependsOn',[]))}
    assert ready-seen, 'Dependency cycle or missing ID'
    seen |= ready
for p in phases:
    k=p['id']
    review=steps[k+'-review']; fix=steps[k+'-fix']; gate=steps[k+'-fix-verify']; accepted=steps[k+'-accepted']
    assert review['dependsOn']==[k+'-verify'] and review['mode']=='plan' and 'lock' not in review
    assert fix['dependsOn']==[k+'-review'] and fix['maxRuns']==3
    assert fix['runIf']==f"{k}-review.verdict != 'PASS' && {k}-review.runCount < 4"
    assert gate['dependsOn']==[k+'-fix'] and gate['maxRuns']==3
    assert gate['onSuccess']['rerun']==k+'-review'
    assert accepted['dependsOn']==[k+'-review'] and 'requirePass' not in accepted
    assert accepted['completeIf']==f"{k}-review.verdict == 'PASS'"
    assert accepted['haltIf']==f"{k}-review.verdict != 'PASS' && {k}-review.runCount >= 4"
    assert p['checks'], f'Empty verification: {k}'
    for check in p['checks']:
        assert check['repo'] in ['public','private'] and isinstance(check['argv'],list)
        assert check['argv'][0] in ['pnpm','cargo','node']
        assert not any('passWithNoTests' in x or x=='--if-present' for x in check['argv'])
for step in steps.values():
    if 'promptFile' in step:
        prompt=(root/step['promptFile']).read_bytes()
        assert 0 < len(prompt) < 128*1024
hashes=json.loads((root/'reference/SHA256SUMS.json').read_text())
assert len(hashes)==9 and 'reference/SHA256SUMS.json' not in hashes
for file,digest in hashes.items():
    assert hashlib.sha256((root/file).read_bytes()).hexdigest()==digest, file
files={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
assert len(files) <= 1024 and sum(map(len,files.values())) <= 16*1024*1024
with zipfile.ZipFile(base/'kubepit-commercial.zip') as archive:
    assert len(archive.namelist())==len(set(archive.namelist()))
    assert set(archive.namelist())==set(files), 'ZIP contains missing/stale files'
    assert archive.testzip() is None
    for name,body in files.items(): assert archive.read(name)==body, name
for file in manifest['package']['contents']:
    assert (root/file).exists(), file
print(json.dumps({'staticValidation':'passed','steps':len(steps),'phases':len(phases),'taskCoverage':len(tasks),'licensingCoverage':7,'humanGates':0,'files':len(files),'expandedBytes':sum(map(len,files.values())),'zipParity':'passed','sourceHashes':'passed'},ensure_ascii=False))
