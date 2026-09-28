import { bench } from 'vitest';
import { netpolInputFor } from '@/lib/perf/fixtures';
import { buildCluster, namespaceMatrix } from '.';

// Budget ids are the bench names (`perf/budgets.json`). Inputs are built once.

const input = netpolInputFor('l');
const cluster = buildCluster(input);

bench('netpol/build_l', () => void buildCluster(input), { time: 2000 });

bench('netpol/matrix_namespace_l', () => void namespaceMatrix(cluster, 'ns-0001', null), {
  time: 2000,
});
