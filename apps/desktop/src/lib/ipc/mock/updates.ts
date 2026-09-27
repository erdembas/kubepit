import type { UpdateInfo, UpdateProgress, UpdaterStatus } from '@/types';
import { sleep } from './bus';
import { register, type MockArgs } from './registry';

/**
 * Demo updater: this "build" is configured and always finds one newer
 * release, then fakes a ~3 s download so the About & Updates page can be
 * reviewed end to end in `pnpm dev:ui`.
 */

const CURRENT = '0.1.0';
const TOTAL_BYTES = 18_874_368;

const AVAILABLE: UpdateInfo = {
  version: '0.2.0',
  current_version: CURRENT,
  date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  notes: [
    '## Highlights',
    '',
    '- Export any table as CSV, JSON or multi-document YAML',
    '- Saved views per kind, with a default view per cluster',
    '- Bookmarks for objects and views in the navigator and the palette',
    '',
    '## Fixes',
    '',
    '- Port forwards reconnect after the laptop wakes up',
  ].join('\n'),
};

let installed = false;

register({
  update_status: (): UpdaterStatus => ({
    configured: true,
    current_version: CURRENT,
    endpoint: 'https://github.com/erdembas/kubepit/releases/latest/download/latest.json',
  }),
  update_check: async (): Promise<UpdateInfo | null> => {
    await sleep(700);
    return installed ? null : AVAILABLE;
  },
  update_install: async ({ onEvent }: MockArgs) => {
    const emit = onEvent as (progress: UpdateProgress) => void;
    if (installed) throw new Error('No update to install. Check for updates first.');
    emit({ event: 'started', total: TOTAL_BYTES });
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      await sleep(100);
      emit({
        event: 'progress',
        downloaded: Math.round((TOTAL_BYTES * i) / steps),
        total: TOTAL_BYTES,
      });
    }
    emit({ event: 'finished' });
    await sleep(400);
    installed = true;
  },
});
