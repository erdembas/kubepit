import { assert } from './model.mjs';
import { github } from './github.mjs';

const workflowPath = '.github/workflows/ci.yml';

// Never select only completed/successful runs: a newer pending or failed run
// must block publication even when an older run of the same commit succeeded.
export function requireSuccessfulSourceCi(runs, { repository, commit, workflowId }) {
  assert(Array.isArray(runs), 'Invalid CI workflow run response');
  const relevant = runs.filter(
    (run) =>
      run.head_sha === commit &&
      run.workflow_id === workflowId &&
      run.path === workflowPath &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      ['push', 'workflow_dispatch'].includes(run.event),
  );
  assert(relevant.length > 0, `Publication blocked: no source CI run for ${commit}`);
  for (const run of relevant) {
    assert(
      Number.isSafeInteger(run.run_number) &&
        run.run_number > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        Number.isSafeInteger(run.id) &&
        run.id > 0,
      'Invalid source CI run identity',
    );
  }
  const latest = relevant.sort(
    (a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt || b.id - a.id,
  )[0];
  assert(
    latest.status === 'completed' && latest.conclusion === 'success',
    `Publication blocked: latest source CI run ${latest.id} is ${latest.status}/${latest.conclusion ?? 'pending'} for ${commit}. Rerun the publish job after this exact source commit passes CI.`,
  );
  return latest;
}

export async function verifySourceCi(repository, commit, request = github) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid CI repository');
  assert(/^[a-f0-9]{40}$/.test(commit), 'Invalid CI source commit');
  const remote = await request(`repos/${repository}`);
  assert(remote.full_name === repository, 'CI repository identity mismatch');
  const workflow = await request(`repos/${repository}/actions/workflows/ci.yml`);
  assert(
    workflow.path === workflowPath &&
      workflow.state === 'active' &&
      Number.isSafeInteger(workflow.id) &&
      workflow.id > 0,
    'Source CI workflow is missing, disabled or unexpected',
  );
  const runs = [];
  for (let page = 1; ; page++) {
    assert(page <= 10, 'Source CI run history exceeds the GitHub search limit');
    // Intentionally omit status/conclusion filters so an unfinished latest run
    // cannot be hidden by an older success. PR runs do not test the frozen tree.
    const response = await request(
      `repos/${repository}/actions/workflows/${workflow.id}/runs?head_sha=${commit}&per_page=100&page=${page}`,
    );
    assert(
      Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        response.total_count <= 1000 &&
        Array.isArray(response.workflow_runs),
      'Invalid or incomplete source CI run history',
    );
    runs.push(...response.workflow_runs);
    if (runs.length >= response.total_count) break;
    assert(response.workflow_runs.length > 0, 'Incomplete source CI run history');
  }
  return requireSuccessfulSourceCi(runs, { repository, commit, workflowId: workflow.id });
}
