import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
import { useState } from 'react';
import { Switch } from '@/components/ui/Switch';
import { enableAssistantFor } from '@/components/assistant/enableCluster';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';
import { SettingsSection } from '../SettingsView';
import { errorText } from './Fields';

export function ClustersSection() {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const ai = useAppStore((s) => s.settings?.ai);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (cluster: ClusterDef, enabled: boolean) => {
    setBusy(cluster.id);
    try {
      if (enabled) await enableAssistantFor(cluster);
      else useAppStore.getState().setSettings(await ipc.aiClusterSet(cluster.id, false, false));
    } catch (e) {
      useAppStore.getState().pushToast('error', assistantErrorMessage(errorText(e)));
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection
      title={i18n.t('Enabled clusters')}
      description={i18n.t(
        'Changes here are saved immediately. Production clusters require typing the cluster name to confirm.',
      )}
    >
      <div className="border-border/70 divide-border/60 divide-y rounded-md border">
        {clusters.map((cluster) => {
          const production = cluster.environment === 'production';
          const confirmed = ai?.production_acknowledged.includes(cluster.id) ?? false;
          const enabled =
            (ai?.clusters.includes(cluster.id) ?? false) && (!production || confirmed);
          return (
            <div key={cluster.id} className="px-3 py-2">
              <Switch
                disabled={busy !== null}
                checked={enabled}
                onChange={(value) => void toggle(cluster, value)}
                label={cluster.name}
                description={
                  <span>
                    {production ? i18n.t('Production') : cluster.environment}
                    {production && confirmed ? ` · ${i18n.t('Confirmed')}` : ''}
                    {cluster.read_only ? ` · ${i18n.t('Read-only')}` : ''}
                  </span>
                }
              />
            </div>
          );
        })}
        {clusters.length === 0 && (
          <p className="text-fg-dim px-3 py-2 text-[12px]">{i18n.t('No clusters yet.')}</p>
        )}
      </div>
    </SettingsSection>
  );
}
