import { bench } from 'vitest';
import { healthInputFor } from '@/lib/perf/fixtures';
import { scanHealth } from '.';

// Budget ids are the bench names (`perf/budgets.json`). Inputs are built once.

const inputM = healthInputFor('m');
const inputL = healthInputFor('l');

bench('health/scan_m', () => void scanHealth(inputM), { time: 2000 });

bench('health/scan_l', () => void scanHealth(inputL), { time: 2000 });
