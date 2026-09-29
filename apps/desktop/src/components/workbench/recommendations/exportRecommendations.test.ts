import { beforeEach, describe, expect, it, vi } from 'vitest';

const recommendationsExport = vi.hoisted(() => vi.fn());
const saveTextAs = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ ipc: { recommendationsExport } }));
vi.mock('../dock/shared/saveFile', () => ({ saveTextAs }));

const { useAppStore } = await import('@/store/useAppStore');
const { exportRecommendations, exportSelection, workloadRefs } =
  await import('./exportRecommendations');

const ref = (name: string) => ({ kind: 'Deployment', namespace: 'shop', name });

describe('export selection', () => {
  it('sends only the fields the backend matches on', () => {
    expect(workloadRefs([{ ...ref('web'), uid: 'u1', replicas: 3 } as never])).toEqual([
      ref('web'),
    ]);
  });

  it('sends no workloads (every row) when the rows are all of the scan', () => {
    expect(exportSelection([ref('web'), ref('api')], 2)).toEqual([]);
    expect(exportSelection([ref('web')], 2)).toEqual([ref('web')]);
  });
});

describe('exportRecommendations', () => {
  const pushToast = vi.fn();
  beforeEach(() => {
    recommendationsExport.mockReset();
    saveTextAs.mockReset();
    pushToast.mockReset();
    useAppStore.setState({ pushToast });
  });

  it('saves the backend document as <cluster>_recommendations_<time>.<format>', async () => {
    recommendationsExport.mockResolvedValue('resources: {}\n');
    saveTextAs.mockResolvedValue('/tmp/out.yaml');
    await exportRecommendations('c1', 7, [ref('web')], 'yaml', 'prod eu/1');
    expect(recommendationsExport).toHaveBeenCalledWith('c1', 7, [ref('web')], 'yaml');
    const [name, text, filter] = saveTextAs.mock.calls[0]!;
    expect(name).toMatch(/^prod-eu-1_recommendations_\d{8}-\d{4}\.yaml$/);
    expect(text).toBe('resources: {}\n');
    expect(filter).toEqual({ name: 'YAML files', extensions: ['yaml', 'yml'] });
    expect(pushToast).toHaveBeenCalledWith('success', 'Saved /tmp/out.yaml');
  });

  it('stays quiet when the user cancels or the browser downloads', async () => {
    recommendationsExport.mockResolvedValue('{}');
    saveTextAs.mockResolvedValue(null);
    await exportRecommendations('c1', null, [], 'json', 'dev');
    expect(saveTextAs.mock.calls[0]![0]).toMatch(/^dev_recommendations_.*\.json$/);
    expect(saveTextAs.mock.calls[0]![2]).toEqual({ name: 'JSON files', extensions: ['json'] });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('reports a backend refusal as an error toast', async () => {
    recommendationsExport.mockRejectedValue(new Error('there is no scan to export yet'));
    await expect(exportRecommendations('c1', null, [], 'json', 'dev')).resolves.toBeUndefined();
    expect(saveTextAs).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith('error', 'there is no scan to export yet');
  });
});
