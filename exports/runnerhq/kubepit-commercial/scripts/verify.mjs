#!/usr/bin/env node
// Captured RunHQ gate. Importing the package never executes this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phaseMap = JSON.parse(fs.readFileSync(path.join(packageRoot, 'phase-map.json'), 'utf8'));
const phase = phaseMap.phases.find(p => p.id === process.argv[2]);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(phase, 'Unknown phase; expected p01 through p20');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ required for this workflow');
assert(process.env.RUNHQ_WORKSPACE_ROOT && path.isAbsolute(process.env.RUNHQ_WORKSPACE_ROOT), 'RunHQ workspace root missing');
const root = fs.realpathSync(process.env.RUNHQ_WORKSPACE_ROOT);
const repos = { public: path.join(root, 'kubepit'), private: path.join(root, 'kubepit-commercial') };
for (const p of Object.values(repos)) {
  assert(fs.existsSync(path.join(p, '.git')), `Declared Git checkout missing: ${p}`);
  assert(fs.realpathSync(p) === p, `Use canonical, nonsymlink checkout roots: ${p}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kubepit-${phase.id}-`));
let databaseStarted = false;
let failed = false;
// Keep tool discovery/caches available; discard account/provider/database secrets.
const inherited = ['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TEMP','TMP','SystemRoot','COMSPEC','PATHEXT','USERPROFILE','LOCALAPPDATA','APPDATA','CARGO_HOME','RUSTUP_HOME','PNPM_HOME','NVM_DIR','DEVELOPER_DIR','SDKROOT'];
const env = Object.fromEntries(inherited.filter(k => process.env[k]).map(k => [k,process.env[k]]));
const isolated = n => path.join(scratch, n);
for (const n of ['kubepit','commercial','aws','gcloud','azure','deny-bin']) fs.mkdirSync(isolated(n));
fs.writeFileSync(isolated('kubeconfig'), 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n');
fs.writeFileSync(isolated('aws/config'), '');
fs.writeFileSync(isolated('aws/credentials'), '');
fs.writeFileSync(isolated('google-adc.json'), '{}');
Object.assign(env, {
  CI:'1', NODE_ENV:'test', NO_COLOR:'1',
  KUBEPIT_HOME:isolated('kubepit'), KUBEPIT_COMMERCIAL_HOME:isolated('commercial'),
  KUBECONFIG:isolated('kubeconfig'), AWS_CONFIG_FILE:isolated('aws/config'),
  AWS_SHARED_CREDENTIALS_FILE:isolated('aws/credentials'), AWS_EC2_METADATA_DISABLED:'true',
  CLOUDSDK_CONFIG:isolated('gcloud'), GOOGLE_APPLICATION_CREDENTIALS:isolated('google-adc.json'),
  AZURE_CONFIG_DIR:isolated('azure'),
  KUBEPIT_TEST_MODE:'fixtures', KUBEPIT_SECRET_STORE:'memory',
  KUBEPIT_TEST_RUN_ID:crypto.randomUUID(), KUBEPIT_TEST_DATABASE_FILE:isolated('postgres.json'),
  KUBEPIT_TEST_NETWORK:'loopback-only', KUBEPIT_WORKFLOW_PHASE:phase.id,
  RUNHQ_PACKAGE_ROOT:packageRoot, RUNHQ_WORKSPACE_ROOT:root,
});
// Real CLI names must not fall through PATH. Tests launch their own generated fake
// executables by absolute path. This is a guard, not an OS/network sandbox.
for (const name of ['aws','gcloud','az','kubectl','helm','kind','k3d','minikube']) {
  const file=isolated(`deny-bin/${name}`);
  fs.writeFileSync(file, '#!/bin/sh\necho "Real cloud/cluster CLI forbidden in verification" >&2\nexit 91\n', {mode:0o700});
  fs.writeFileSync(`${file}.cmd`, '@echo off\r\necho Real cloud/cluster CLI forbidden in verification 1>&2\r\nexit /b 91\r\n');
}
env.PATH = isolated('deny-bin') + path.delimiter + (env.PATH || '');

function run(argv, cwd, {capture=false, allowFailure=false}={}) {
  assert(argv.length > 0, 'Empty command');
  process.stdout.write(`\n[${phase.id}] ${path.basename(cwd)} :: ${argv.join(' ')}\n`);
  // Current macOS runner; other product platforms require their own CI evidence.
  const build=argv[0]==='pnpm' && argv.some(a=>['build','build:desktop','tauri:build:local'].includes(a));
  const childEnv=build?{...env,NODE_ENV:'production'}:env;
  const result=spawnSync(argv[0],argv.slice(1),{cwd,env:childEnv,encoding:'utf8',stdio:capture?'pipe':'inherit',timeout:1000*60*120,maxBuffer:32*1024*1024,shell:false});
  if (capture) { process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); }
  if (!allowFailure) assert(!result.error && result.status===0, `Command failed (${result.status ?? result.error?.message}): ${argv.join(' ')}`);
  return result;
}
function git(repo,...args) {
  const r=spawnSync('git',['-C',repo,...args],{env,encoding:'utf8',timeout:30000});
  assert(!r.error && r.status===0, `Git check failed: ${args.join(' ')}`);
  return r.stdout.trim();
}
function requiredFile(repo, file) {
  const resolved=path.resolve(repo,file);
  assert(resolved.startsWith(repo+path.sep), 'Required file escapes repo');
  assert(fs.statSync(resolved,{throwIfNoEntry:false})?.isFile(), `Required file missing: ${file}`);
  assert(fs.statSync(resolved).size>0, `Required file empty: ${file}`);
}
function checkCommand(c) {
  const repo=repos[c.repo];
  for (const file of c.argv.filter(a=>a.startsWith('tests/') || a.startsWith('scripts/'))) requiredFile(repo,file);
  if(c.argv[0]==='pnpm') {
    let manifest=path.join(repo,'package.json');
    let script=c.argv[1];
    if(script==='--filter') {
      const names={'@kubepit/desktop':'apps/desktop','@kubepit/edition-contracts':'packages/edition-contracts'};
      assert(names[c.argv[2]],'Unsupported package filter');
      manifest=path.join(repo,names[c.argv[2]],'package.json'); script=c.argv[3];
    }
    const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
    assert(typeof pkg.scripts?.[script]==='string',`Required package script missing: ${manifest}#${script}`);
    assert(!/passWithNoTests|--if-present|\|\|\s*true/.test(pkg.scripts[script]), `Fail-open script forbidden: ${script}`);
  }
  const result=run(c.argv,repo,{capture:!!c.requireTestList});
  if(c.requireTestList) assert(/^.+: test\s*$/m.test(result.stdout||''),'Filtered Rust suite lists no tests');
}

try {
  for (const [name,repo] of Object.entries(repos)) {
    console.log(`${name} HEAD=${git(repo,'rev-parse','HEAD')} branch=${git(repo,'branch','--show-current')}`);
    // Record changed paths, never file contents or account values.
    console.log(`${name} status:\n${git(repo,'status','--short') || '(clean)'}`);
  }
  requiredFile(repos.private,`docs/workflow/${phase.id}.md`);
  if(phase.pinRequired) {
    const vendor=path.join(repos.private,'vendor/kubepit');
    assert(fs.existsSync(path.join(vendor,'.git')), 'Pinned vendor Git checkout missing');
    assert(git(repos.public,'status','--porcelain')==='', 'Implementer must create the scoped automatic local checkpoint and refresh vendor pin before private verification');
    assert(git(vendor,'status','--porcelain')==='', 'Vendor checkout is modified; do not patch vendor');
    assert(git(repos.public,'rev-parse','HEAD')===git(vendor,'rev-parse','HEAD'), 'Private vendor pin differs from reviewed public HEAD');
  }
  if(phase.id==='p01') requiredFile(repos.private,'docs/workflow/license-proposal.md');
  if(phase.id==='p02') {
    requiredFile(repos.private,'docs/workflow/license-decision.md');
    requiredFile(repos.private,'docs/legal/proposed-license-transition.patch');
    requiredFile(repos.private,'docs/workflow/EXTERNAL_GATES.md');
  }
  if(phase.database) {
    // A remembered remote Docker context must never become the fixture target.
    const context=run(['docker','context','inspect','--format','{{json .Endpoints.docker.Host}}'],repos.private,{capture:true});
    const endpoint=JSON.parse(context.stdout.trim());
    assert(typeof endpoint==='string' && /^(unix:\/\/|npipe:\/\/)/.test(endpoint),'Fixture PostgreSQL requires a local Docker socket/context');
    databaseStarted=true;
    checkCommand({repo:'private',argv:['pnpm','db:test:up']});
    const database=JSON.parse(fs.readFileSync(env.KUBEPIT_TEST_DATABASE_FILE,'utf8'));
    const url=new URL(database.url);
    assert(['postgres:','postgresql:'].includes(url.protocol),'Invalid fixture DB protocol');
    assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Fixture DB must be loopback');
    assert(url.pathname.startsWith('/kubepit_test_'),'Fixture DB name must begin kubepit_test_');
    assert(database.run_id===env.KUBEPIT_TEST_RUN_ID,'Fixture DB run ownership mismatch');
    // Never print the URL or fixture credentials. Tests load this guarded file.
    checkCommand({repo:'private',argv:['pnpm','db:test:migrate']});
  }
  for (const check of phase.checks) checkCommand(check);
  console.log(`\n${phase.id}: all ${phase.checks.length} declared local checks passed.`);
} catch(error) {
  failed=true;
  console.error(`Verification blocked: ${error.message}`);
} finally {
  if(databaseStarted) {
    try { checkCommand({repo:'private',argv:['pnpm','db:test:down']}); }
    catch(error) { failed=true; console.error(`Fixture cleanup failed: ${error.message}`); }
  }
  // Delete only this process's newly created fixture directory, never a checkout.
  if(!failed) fs.rmSync(scratch,{recursive:true,force:true});
  else console.error(`Fixture diagnostics preserved at ${scratch}; remove after inspection.`);
}
process.exitCode=failed?1:0;
