import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSuccessfulSourceCi, verifySourceCi } from './ci-gate.mjs';

const source = { repository: 'erdembas/kubepit', commit: 'a'.repeat(40), workflowId: 371500516 };
const run = (overrides = {}) => ({
  id: 100,
  run_number: 5,
  run_attempt: 1,
  workflow_id: source.workflowId,
  path: '.github/workflows/ci.yml',
  head_sha: source.commit,
  repository: { full_name: source.repository },
  head_repository: { full_name: source.repository },
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

test('publication requires a successful exact-source CI run', () => {
  const successful = run();
  assert.equal(requireSuccessfulSourceCi([successful], source), successful);
  for (const unrelated of [
    [],
    [run({ head_sha: 'b'.repeat(40) })],
    [run({ workflow_id: 123 })],
    [run({ path: '.github/workflows/release.yml' })],
    [run({ repository: { full_name: 'another/kubepit' } })],
    [run({ head_repository: { full_name: 'fork/kubepit' } })],
    [run({ event: 'pull_request' })],
  ]) {
    assert.throws(() => requireSuccessfulSourceCi(unrelated, source), /no source CI run/);
  }
});

test('a newer queued, running or failed CI run blocks an older success', () => {
  for (const [status, conclusion] of [
    ['queued', null],
    ['in_progress', null],
    ['waiting', null],
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['completed', 'timed_out'],
    ['completed', 'skipped'],
    ['completed', 'neutral'],
  ]) {
    const latest = run({ id: 101, run_number: 6, status, conclusion });
    assert.throws(
      () => requireSuccessfulSourceCi([run(), latest], source),
      /latest source CI run 101/,
    );
  }
});

test('latest exact-source success wins regardless of response order or unrelated runs', () => {
  const latest = run({ id: 103, run_number: 8, event: 'workflow_dispatch' });
  assert.equal(
    requireSuccessfulSourceCi(
      [latest, run({ conclusion: 'failure' }), run({ run_number: 99, head_sha: 'b'.repeat(40) })],
      source,
    ),
    latest,
  );
  assert.throws(
    () =>
      requireSuccessfulSourceCi(
        [run(), run({ run_attempt: 2, status: 'in_progress', conclusion: null })],
        source,
      ),
    /Publication blocked/,
  );
});

test('API gate checks repository/workflow identity and reads unfiltered exact-SHA history', async () => {
  const paths = [];
  const latest = run({ id: 101, run_number: 6 });
  const responses = [
    { full_name: source.repository },
    { id: source.workflowId, path: '.github/workflows/ci.yml', state: 'active' },
    { total_count: 2, workflow_runs: [run()] },
    { total_count: 2, workflow_runs: [latest] },
  ];
  const selected = await verifySourceCi(source.repository, source.commit, async (path) => {
    paths.push(path);
    return responses.shift();
  });
  assert.equal(selected, latest);
  assert.deepEqual(paths, [
    `repos/${source.repository}`,
    `repos/${source.repository}/actions/workflows/ci.yml`,
    `repos/${source.repository}/actions/workflows/${source.workflowId}/runs?head_sha=${source.commit}&per_page=100&page=1`,
    `repos/${source.repository}/actions/workflows/${source.workflowId}/runs?head_sha=${source.commit}&per_page=100&page=2`,
  ]);
  await assert.rejects(
    verifySourceCi(source.repository, source.commit, async () => ({
      full_name: 'wrong/repository',
    })),
    /repository identity mismatch/,
  );
});

test('missing or incomplete API evidence fails closed', async () => {
  for (const workflow of [
    { id: source.workflowId, path: '.github/workflows/ci.yml', state: 'disabled_manually' },
    { id: source.workflowId, path: '.github/workflows/release.yml', state: 'active' },
  ]) {
    const responses = [{ full_name: source.repository }, workflow];
    await assert.rejects(
      verifySourceCi(source.repository, source.commit, async () => responses.shift()),
      /missing, disabled or unexpected/,
    );
  }
  const responses = [
    { full_name: source.repository },
    { id: source.workflowId, path: '.github/workflows/ci.yml', state: 'active' },
    { total_count: 2, workflow_runs: [run()] },
    { total_count: 2, workflow_runs: [] },
  ];
  await assert.rejects(
    verifySourceCi(source.repository, source.commit, async () => responses.shift()),
    /Incomplete source CI run history/,
  );
});
