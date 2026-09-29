import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen, KeyRound, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { setSidebarMode, sidebarModeOf, type SidebarMode } from '@/components/sidebar/sidebarMode';
import { ipc, isTauri } from '@/lib/ipc';
import { modChord } from '@/lib/platform';
import { rebaseDraft } from '@/lib/settingsSync';
import { useAppStore } from '@/store/useAppStore';
import type { Settings } from '@/types';
import { SettingsPageShell, SettingsSection } from './SettingsView';
import { UpdatesSection } from './UpdatesSection';

/**
 * Local draft of backend settings with an explicit Save, like RunHQ's settings pages.
 * `saveBlocked` returns why the draft cannot be saved yet (shown in the
 * footer, Save disabled), or null; the fields themselves show the details.
 */
export function useSettingsDraft(
  options: { saveBlocked?: (draft: Settings) => string | null } = {},
) {
  const settings = useAppStore((s) => s.settings);
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  // The settings the draft started from. When they change (another window
  // saved), an unchanged draft follows them and a dirty one keeps its edits.
  const base = useRef(settings);
  useEffect(() => {
    const previous = base.current;
    base.current = settings;
    setDraft((d) => rebaseDraft(d, previous, settings));
  }, [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const blocked = draft && options.saveBlocked ? options.saveBlocked(draft) : null;
  const save = async () => {
    if (!draft || blocked) return;
    setSaving(true);
    try {
      const saved = await ipc.settingsSet(draft);
      // The backend normalizes (trims paths, sorts lists): start over from it.
      setDraft(saved);
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
      {blocked ? (
        <span
          role="alert"
          className="text-status-error min-w-0 truncate text-[11.5px]"
          title={blocked}
        >
          {blocked}
        </span>
      ) : (
        <span className="text-fg-dim text-[11.5px]">{i18n.t('You have unsaved changes.')}</span>
      )}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDraft(settings)}>
        {i18n.t('Discard')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={saving || !!blocked}
        title={blocked ?? undefined}
        onClick={() => void save()}
      >
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
      <SidebarModeSection />
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
          <SettingsSection title={i18n.t('Change timeline')}>
            <Switch
              checked={draft.change_journal}
              onChange={(v) => update('change_journal', v)}
              label={i18n.t('Record what changes in connected clusters')}
              description={i18n.t(
                'Watches workloads, config, network, RBAC, namespaces and nodes while a cluster is connected and keeps the last 24 hours in memory only. Secret values are never stored. Clusters can opt out from their Changes view.',
              )}
            />
            {draft.change_journal && draft.change_journal_disabled.length > 0 && (
              <p className="text-fg-dim mt-2 text-[11.5px]">
                {i18n.plural(
                  '{count} cluster opted out.',
                  '{count} clusters opted out.',
                  draft.change_journal_disabled.length,
                )}{' '}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => update('change_journal_disabled', [])}
                >
                  {i18n.t('Record every cluster')}
                </button>
              </p>
            )}
          </SettingsSection>
        </>
      ) : (
        <Unavailable />
      )}
    </SettingsPageShell>
  );
}

/** Layout preference of this machine: applies immediately, outside the settings draft. */
function SidebarModeSection() {
  i18n.useLocale();
  const mode = useAppStore((s) => sidebarModeOf(s.sidebarPinned, s.sidebarHoverExpand));
  const options: Array<{ value: SidebarMode; label: string }> = [
    { value: 'expanded', label: i18n.t('Always expanded') },
    { value: 'hover', label: i18n.t('Compact, expands on hover') },
    { value: 'compact', label: i18n.t('Compact') },
  ];
  return (
    <SettingsSection
      title={i18n.t('Sidebar')}
      description={i18n.t(
        'How the left explorer behaves. {shortcut} pins it open or collapses it.',
        {
          shortcut: modChord('B'),
        },
      )}
    >
      <select
        aria-label={i18n.t('Sidebar')}
        value={mode}
        onChange={(event) => setSidebarMode(event.target.value as SidebarMode)}
        className="border-border bg-surface-raised text-fg rounded-app-sm border px-3 py-2 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </SettingsSection>
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
      <CredentialStorageSection />
    </SettingsPageShell>
  );
}

/**
 * Connectivity: keep imported kubeconfigs in the OS credential store. Applies
 * immediately (it migrates every managed kubeconfig), outside the draft.
 */
function CredentialStorageSection() {
  i18n.useLocale();
  const enabled = useAppStore((s) => s.settings?.keychain_kubeconfigs ?? false);
  const platform = useAppStore((s) => s.appInfo?.platform);
  const managed = useAppStore((s) => s.clusters.filter((c) => c.managed).length);
  const [busy, setBusy] = useState(false);
  const storeName =
    platform === 'macos'
      ? i18n.t('macOS Keychain')
      : platform === 'windows'
        ? i18n.t('Windows Credential Manager')
        : i18n.t('Secret Service (GNOME Keyring, KWallet)');
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const saved = await ipc.kubeconfigStorageSet(next);
      useAppStore.getState().setSettings(saved);
      useAppStore
        .getState()
        .pushToast(
          'success',
          next
            ? i18n.t('Imported kubeconfigs are now kept in the {store}.', { store: storeName })
            : i18n.t('Imported kubeconfigs are now kept as files.'),
        );
    } catch (e) {
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title={i18n.t('Credential storage')}
      description={i18n.t(
        'Where copied and pasted kubeconfigs are kept. Your original files are never moved or modified.',
      )}
    >
      <Switch
        checked={enabled}
        disabled={busy}
        onChange={(next) => void toggle(next)}
        label={
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="text-fg-dim h-3.5 w-3.5" />
            {i18n.t('Keep imported kubeconfigs in the {store}', { store: storeName })}
            {busy && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
          </span>
        }
        description={i18n.t(
          'Instead of files under ~/.kubepit/kubeconfigs. Existing ones move now, one at a time; if the store is locked or unavailable nothing changes. The single-context file for kubectl, helm and terminals then only exists while the cluster is connected.',
        )}
      />
      <p className="text-fg-dim mt-2 text-[11px]">
        {i18n.plural(
          '{count} imported kubeconfig is affected.',
          '{count} imported kubeconfigs are affected.',
          managed,
        )}
      </p>
    </SettingsSection>
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
          <li>{i18n.t('Credentials are stored locally and sent only to your clusters.')}</li>
          <li>
            {i18n.t(
              'Imported kubeconfigs use your chosen local storage: protected files or the OS credential store.',
            )}
          </li>
        </ul>
      </SettingsSection>
    </SettingsPageShell>
  );
}
