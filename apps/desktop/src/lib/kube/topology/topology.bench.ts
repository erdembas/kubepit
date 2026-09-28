import { bench } from 'vitest';
import { topologyInputFor } from '@/lib/perf/fixtures';
import {
  buildTopology,
  DEFAULT_MAX_NODES,
  deriveView,
  layoutTopology,
  type TopologyInput,
  type TopologyView,
} from '.';

// Budget ids are the bench names (`perf/budgets.json`). Inputs are built once.

const NONE: ReadonlySet<string> = new Set();

function view(input: TopologyInput, maxNodes: number): TopologyView {
  return deriveView(buildTopology(input), {
    rootId: null,
    hops: 1,
    expanded: NONE,
    hiddenKinds: NONE,
    maxNodes,
  });
}

/** What the Resource Map does on open: build, derive the capped view, lay it out. */
function map(input: TopologyInput) {
  const v = view(input, DEFAULT_MAX_NODES);
  return layoutTopology(v.nodes, v.edges);
}

const namespaceL = topologyInputFor('l', 'ns-0001');
const allM = topologyInputFor('m', null);
const view800 = view(allM, 800);
const view1200 = view(allM, 1200);

bench('topology/namespace_l', () => void map(namespaceL), { time: 2000 });

bench('topology/all_m', () => void map(allM), { time: 2000 });

bench('topology/layout_800', () => void layoutTopology(view800.nodes, view800.edges), {
  time: 2000,
});

bench('topology/layout_1200', () => void layoutTopology(view1200.nodes, view1200.edges), {
  time: 2000,
});
