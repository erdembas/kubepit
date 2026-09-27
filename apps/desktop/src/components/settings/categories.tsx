import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { CheckCircle2, FolderOpen, Plus, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { Settings } from '@/types';
import { SettingsPageShell, SettingsSection } from './SettingsView';
import { UpdatesSection } from './UpdatesSection';

/** Local draft of backend settings with an explicit Save, like RunHQ's settings pages. */
function useSettingsDraft() {
  const settings = useAppStore((s) => s.settings);
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await ipc.settingsSet(draft);
      useAppStore.getState().setSettings(saved);
      useAppStore.getState().pushToast('success', i18n.t('Settings saved'));
    } catch (e) {
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const footer = dirty ? (
    <>
      <span className="text-fg-dim text-[11.5px]">{i18n.t('You have unsaved changes.')}</span>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDraft(settings)}>
        {i18n.t('Discard')}
      </Button>
      <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
        {i18n.t('Save')}
      </Button>
    </>
  ) : undefined;
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  return { draft, update, footer };
}

function Unavailable() {
  i18n.useLocale();
  return <p className="text-fg-dim text-[12px]">{i18n.t('Loading settings…')}</p>;
}

export function GeneralCategory({ description }: { description: string }) {
  const locale = i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  return (
    <SettingsPageShell description={description} footer={footer}>
      <SettingsSection
        title={i18n.t('Display language')}
        description={i18n.t(
          'Changes apply immediately. Kubernetes data, logs, YAML and your own content keep their original language.',
        )}
      >
        <select
          aria-label={i18n.t('Display language')}
          value={locale}
          onChange={(event) => i18n.setLocale(event.target.value as i18n.Locale)}
          className="border-border bg-surface-raised text-fg rounded-app-sm border px-3 py-2 text-sm"
        >
          <option value="tr" lang="tr">
            Türkçe
          </option>
          <option value="en" lang="en">
            English
          </option>
        </select>
      </SettingsSection>
      {draft ? (
        <>
          <SettingsSection title={i18n.t('Safety')}>
            <Switch
              checked={draft.confirm_destructive}
              onChange={(v) => update('confirm_destructive', v)}
              label={i18n.t('Confirm destructive actions on every cluster')}
              description={i18n.t(
                'Delete, scale to zero, drain and Helm uninstall always ask first. Production clusters additionally require typing the resource name.',
              )}
            />
          </SettingsSection>
          <SettingsSection
            title={i18n.t('Logs')}
            description={i18n.t('How many lines a new log tab loads before following.')}
          >
            <Input
              type="number"
              min={10}
              max={100000}
              value={draft.log_tail_lines}
              onChange={(e) => update('log_tail_lines', Math.max(10, Number(e.target.value) || 0))}
              className="w-40"
            />
          </SettingsSection>
        </>
      ) : (
        <Unavailable />
      )}
    </SettingsPageShell>
  );
}

export function KubeconfigCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  const [path, setPath] = useState('');
  if (!draft) return <Unavailable />;
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || draft.kubeconfig_sync_paths.includes(trimmed)) return;
    update('kubeconfig_sync_paths', [...draft.kubeconfig_sync_paths, trimmed]);
    setPath('');
  };
  const browse = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') add(picked);
  };
  return (
    <SettingsPageShell description={description} footer={footer}>
      <SettingsSection
        title={i18n.t('Always scanned')}
        description={i18n.t(
          'Every path in $KUBECONFIG, ~/.kube/config and other files directly in ~/.kube.',
        )}
      >
        <code className="bg-surface-muted/60 text-fg-muted block rounded-md px-3 py-2 font-mono text-[11.5px]">
          $KUBECONFIG · ~/.kube/config · ~/.kube/*
        </code>
      </SettingsSection>
      <SettingsSection
        title={i18n.t('Extra folders and files')}
        description={i18n.t('Kubepit only reads these; your kubeconfig files are never modified.')}
      >
        <div className="space-y-1.5">
          {draft.kubeconfig_sync_paths.map((p) => (
            <div
              key={p}
              className="border-border/70 bg-surface-raised/50 flex items-center gap-2 rounded-md border px-3 py-1.5"
            >
              <FolderOpen className="text-fg-dim h-3.5 w-3.5" />
              <span className="text-fg min-w-0 flex-1 truncate font-mono text-[11.5px]">{p}</span>
              <button
                type="button"
                aria-label={i18n.t('Remove')}
                onClick={() =>
                  update(
                    'kubeconfig_sync_paths',
                    draft.kubeconfig_sync_paths.filter((x) => x !== p),
                  )
                }
                className="text-fg-dim hover:text-status-error rounded p-1"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              mono
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add(path)}
              placeholder="~/work/kubeconfigs"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => add(path)}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              {i18n.t('Add')}
            </Button>
            {isTauri && (
              <Button variant="secondary" size="sm" onClick={() => void browse()}>
                {i18n.t('Browse…')}
              </Button>
            )}
          </div>
        </div>
      </SettingsSection>
    </SettingsPageShell>
  );
}

export function TerminalCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  if (!draft) return <Unavailable />;
  return (
    <SettingsPageShell description={description} footer={footer}>
      <SettingsSection
        title={i18n.t('Shell')}
        description={i18n.t('Leave empty to use your login shell ($SHELL).')}
      >
        <Input
          mono
          value={draft.shell_path ?? ''}
          placeholder="/bin/zsh"
          onChange={(e) => update('shell_path', e.target.value.trim() || null)}
        />
      </SettingsSection>
      <SettingsSection title={i18n.t('Font size')}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={10}
            max={20}
            value={draft.terminal_font_size}
            onChange={(e) => update('terminal_font_size', Number(e.target.value))}
            className="w-56 accent-[rgb(var(--accent))]"
          />
          <span className="text-fg font-mono text-[12px] tabular-nums">
            {draft.terminal_font_size}px
          </span>
        </div>
      </SettingsSection>
      <SettingsSection
        title={i18n.t('Node shell image')}
        description={i18n.t(
          'Node shells start a short-lived privileged pod on the node with this image and use nsenter to reach the host.',
        )}
      >
        <Input
          mono
          value={draft.node_shell_image}
          onChange={(e) => update('node_shell_image', e.target.value)}
        />
      </SettingsSection>
      <SettingsSection
        title={i18n.t('Debug container image')}
        description={i18n.t(
          'Default image for ephemeral debug containers (Debug… on a pod). It needs a shell; netshoot is a good pick for network issues.',
        )}
      >
        <Input
          mono
          value={draft.debug_image}
          placeholder="docker.io/library/busybox:1.36"
          onChange={(e) => update('debug_image', e.target.value)}
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}

export function ToolsCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  const appInfo = useAppStore((s) => s.appInfo);
  if (!draft) return <Unavailable />;
  const row = (
    label: string,
    detected: { path: string | null; version: string | null } | undefined,
    value: string | null,
    onChange: (v: string | null) => void,
    placeholder: string,
    help: string,
  ) => (
    <SettingsSection title={label} description={help}>
      <div className="mb-2 flex items-center gap-2 text-[11.5px]">
        {detected?.path ? (
          <>
            <CheckCircle2 className="text-status-running h-3.5 w-3.5" />
            <span className="text-fg font-mono">{detected.path}</span>
            {detected.version && <span className="text-fg-dim">{detected.version}</span>}
          </>
        ) : (
          <>
            <XCircle className="text-status-error h-3.5 w-3.5" />
            <span className="text-fg-muted">{i18n.t('Not found on PATH')}</span>
          </>
        )}
      </div>
      <Input
        mono
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim() || null)}
      />
    </SettingsSection>
  );
  return (
    <SettingsPageShell description={description} footer={footer}>
      {row(
        'kubectl',
        appInfo?.kubectl,
        draft.kubectl_path,
        (v) => update('kubectl_path', v),
        '/usr/local/bin/kubectl',
        i18n.t('Used for pod shells, attach and node shells. Leave empty to auto-detect.'),
      )}
      {row(
        'helm',
        appInfo?.helm,
        draft.helm_path,
        (v) => update('helm_path', v),
        '/opt/homebrew/bin/helm',
        i18n.t(
          'Used for charts, installs, upgrades, rollback and uninstall. Browsing releases works without it.',
        ),
      )}
    </SettingsPageShell>
  );
}

export function AboutCategory({ description }: { description: string }) {
  i18n.useLocale();
  const appInfo = useAppStore((s) => s.appInfo);
  const { draft, update, footer } = useSettingsDraft();
  return (
    <SettingsPageShell description={description} footer={footer}>
      <div className="glass mb-6 flex items-center gap-4 p-5">
        <span className="bg-accent/12 text-accent flex h-12 w-12 items-center justify-center rounded-xl">
          <KubepitMark className="h-7 w-7" />
        </span>
        <div>
          <h2 className="text-fg text-[16px] font-semibold">Kubepit</h2>
          <p className="text-fg-muted text-[12px]">
            {i18n.t('A local-first Kubernetes IDE for many clusters.')}
          </p>
          {appInfo && (
            <p className="text-fg-dim mt-1 font-mono text-[11px]">
              v{appInfo.version} · {appInfo.platform}
            </p>
          )}
        </div>
      </div>
      <UpdatesSection
        autoCheck={draft ? draft.auto_check_updates : null}
        onAutoCheck={(v) => update('auto_check_updates', v)}
      />
      <SettingsSection
        title={i18n.t('Data folder')}
        description={i18n.t('Cluster registry, settings and workspace layout live here as JSON.')}
      >
        <div className="flex items-center gap-2">
          <code className="bg-surface-muted/60 text-fg flex-1 rounded-md px-3 py-2 font-mono text-[11.5px]">
            {appInfo?.data_dir ?? '~/.kubepit'}
          </code>
          {isTauri && appInfo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void ipc.revealPath(appInfo.data_dir)}
            >
              {i18n.t('Reveal')}
            </Button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title={i18n.t('Privacy')}>
        <ul className="text-fg-muted list-disc space-y-1 pl-5 text-[12px]">
          <li>{i18n.t('No account, no telemetry.')}</li>
          <li>
            {i18n.t(
              'Credentials stay in your kubeconfig files and are only sent to your clusters.',
            )}
          </li>
          <li>{i18n.t('Pasted kubeconfigs are stored with owner-only permissions.')}</li>
        </ul>
      </SettingsSection>
    </SettingsPageShell>
  );
}
