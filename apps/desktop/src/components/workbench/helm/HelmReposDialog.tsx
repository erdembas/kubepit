import * as i18n from '@/i18n';
import { useState } from 'react';
import { CircleCheck, Loader2, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Field, Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { HelmRepo, HelmRepoUpdateResult } from '@/types';
import { refreshPolledPrefix, usePolled } from '../data/polled';
import { errorText } from '../util';
import { ChartAvatar } from './ChartBits';
import { CHART_KEYS } from './charts';

/** Well-known public repositories offered as one-click presets. */
const PRESETS: HelmRepo[] = [
  { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' },
  { name: 'prometheus-community', url: 'https://prometheus-community.github.io/helm-charts' },
  { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx' },
  { name: 'jetstack', url: 'https://charts.jetstack.io' },
  { name: 'grafana', url: 'https://grafana.github.io/helm-charts' },
  { name: 'argo', url: 'https://argoproj.github.io/argo-helm' },
  { name: 'traefik', url: 'https://traefik.github.io/charts' },
  { name: 'hashicorp', url: 'https://helm.releases.hashicorp.com' },
  { name: 'kedacore', url: 'https://kedacore.github.io/charts' },
  { name: 'external-secrets', url: 'https://charts.external-secrets.io' },
];

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** Invalidate everything derived from the repositories (catalog, versions, details). */
export function refreshCharts() {
  refreshPolledPrefix('helm-charts|');
}

/**
 * Manage the helm repositories of this machine (the same list `helm repo
 * list` shows): add with optional basic auth, remove, update.
 */
export function HelmReposDialog({
  initial,
  onClose,
}: {
  /** Prefill the add form (e.g. from an Artifact Hub result). */
  initial?: HelmRepo | null;
  onClose: () => void;
}) {
  i18n.useLocale();
  const repos = usePolled(CHART_KEYS.repos, () => ipc.helmRepoList(), null);
  const [adding, setAdding] = useState(!!initial);
  const [updating, setUpdating] = useState(false);
  const [updates, setUpdates] = useState<Record<string, HelmRepoUpdateResult>>({});
  const [updateError, setUpdateError] = useState<string | null>(null);
  const list = repos.data ?? [];

  const updateAll = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      const results = await ipc.helmRepoUpdate([]);
      setUpdates(Object.fromEntries(results.map((r) => [r.name, r])));
      const failed = results.filter((r) => !r.ok).length;
      useAppStore
        .getState()
        .pushToast(
          failed ? 'error' : 'success',
          failed
            ? i18n.plural(
                '{count} repository could not be updated',
                '{count} repositories could not be updated',
                failed,
              )
            : i18n.t('Repositories are up to date'),
        );
    } catch (e) {
      setUpdateError(errorText(e));
    } finally {
      setUpdating(false);
      refreshCharts();
    }
  };

  const remove = (repo: HelmRepo) =>
    useAppStore.getState().requestConfirm({
      title: i18n.t('Remove repository'),
      message: i18n.t(
        'Remove the Helm repository "{name}"? Its charts can no longer be installed or upgraded from Kubepit or the helm CLI until it is added again.',
        { name: repo.name },
      ),
      confirmLabel: i18n.t('Remove'),
      tone: 'danger',
      onConfirm: async () => {
        try {
          await ipc.helmRepoRemove(repo.name);
          useAppStore
            .getState()
            .pushToast('success', i18n.t('Removed repository {name}', { name: repo.name }));
        } catch (e) {
          useAppStore.getState().pushToast('error', errorText(e));
        }
        refreshCharts();
      },
    });

  return (
    <Dialog
      title={i18n.t('Chart repositories')}
      subtitle={i18n.t('Shared with the helm CLI on this machine')}
      size="lg"
      onClose={() => {
        if (!useAppStore.getState().confirm) onClose();
      }}
      footer={
        <Button size="sm" variant="secondary" onClick={onClose}>
          {i18n.t('Close')}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
            {i18n.plural('{count} repository', '{count} repositories', list.length)}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={updating || !list.length}
              leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', updating && 'animate-spin')} />}
              onClick={() => void updateAll()}
            >
              {updating ? i18n.t('Updating…') : i18n.t('Update all')}
            </Button>
            {!adding && (
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setAdding(true)}
              >
                {i18n.t('Add repository')}
              </Button>
            )}
          </div>
        </div>
        {updateError && (
          <p className="bg-status-error/8 text-status-error rounded-md px-3 py-2 font-mono text-[11px] break-words whitespace-pre-wrap">
            {updateError}
          </p>
        )}
        {adding && (
          <AddRepoForm
            key={initial?.url ?? 'new'}
            initial={initial ?? null}
            existing={list}
            onDone={() => {
              setAdding(false);
              refreshCharts();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {repos.error && !repos.data ? (
          <p className="text-status-error text-[12px] break-words">{repos.error}</p>
        ) : !repos.data ? (
          <div className="text-fg-muted flex items-center gap-2 py-6 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Loading…')}
          </div>
        ) : !list.length ? (
          <p className="text-fg-dim border-border/60 rounded-lg border border-dashed px-4 py-6 text-center text-[12px]">
            {i18n.t('No repositories yet. Add one to browse and install its charts.')}
          </p>
        ) : (
          <ul className="border-border/60 divide-border/40 divide-y overflow-hidden rounded-lg border">
            {list.map((repo) => {
              const status = updates[repo.name];
              return (
                <li
                  key={repo.name}
                  className="hover:bg-fg/[0.03] flex items-start gap-2.5 px-3 py-2"
                >
                  <ChartAvatar name={repo.name} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-fg truncate text-[12.5px] font-medium">
                        {repo.name}
                      </span>
                      {status?.ok && (
                        <span className="text-status-running flex items-center gap-1 text-[11px]">
                          <CircleCheck className="h-3 w-3" />
                          {i18n.t('Updated')}
                        </span>
                      )}
                    </div>
                    <p className="text-fg-dim truncate font-mono text-[11px]" title={repo.url}>
                      {repo.url}
                    </p>
                    {status && !status.ok && (
                      <p className="text-status-error mt-1 flex items-start gap-1 text-[11px] break-words">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="font-mono">{status.error}</span>
                      </p>
                    )}
                  </div>
                  <IconButton
                    label={i18n.t('Remove repository {name}', { name: repo.name })}
                    icon={<Trash2 />}
                    tone="danger"
                    onClick={() => remove(repo)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function AddRepoForm({
  initial,
  existing,
  onDone,
  onCancel,
}: {
  initial: HelmRepo | null;
  existing: HelmRepo[];
  onDone: () => void;
  onCancel: () => void;
}) {
  i18n.useLocale();
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [auth, setAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [passCredentials, setPassCredentials] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const clash = existing.find((r) => r.name === trimmed);
  const nameError = !trimmed
    ? null
    : !REPO_NAME.test(trimmed)
      ? i18n.t('Use letters, digits, "-", "_" and "." (no "/").')
      : clash && !force
        ? i18n.t(
            'A repository with this name exists. Turn on "Replace if it exists" to overwrite it.',
          )
        : null;
  const urlError =
    !url.trim() || /^https?:\/\/\S+$/.test(url.trim())
      ? null
      : url.trim().startsWith('oci://')
        ? i18n.t(
            'OCI registries are not repositories: install their charts with an oci:// reference.',
          )
        : i18n.t('Use an http:// or https:// address.');
  const valid =
    !!trimmed && !!url.trim() && !nameError && !urlError && (!auth || !!username.trim());
  const presets = PRESETS.filter(
    (p) => !existing.some((r) => r.url === p.url || r.name === p.name),
  );

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.helmRepoAdd(trimmed, url.trim(), {
        username: auth ? username.trim() : null,
        password: auth ? password : null,
        insecure_skip_tls_verify: insecure,
        pass_credentials: passCredentials,
        force_update: force,
      });
      useAppStore
        .getState()
        .pushToast('success', i18n.t('Added repository {name}', { name: trimmed }));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="border-border/70 bg-fg/[0.02] space-y-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
        <Field label={i18n.t('Name')} error={nameError}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="bitnami"
            spellCheck={false}
          />
        </Field>
        <Field label={i18n.t('URL')} error={urlError}>
          <Input
            mono
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://charts.bitnami.com/bitnami"
            spellCheck={false}
          />
        </Field>
      </div>
      {!initial && presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-fg-dim mr-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
            {i18n.t('Popular')}
          </span>
          {presets.map((p) => (
            <button
              key={p.name}
              type="button"
              title={p.url}
              onClick={() => {
                setName(p.name);
                setUrl(p.url);
              }}
              className={cn(
                'bg-fg/5 text-fg-muted ring-border/60 hover:text-fg hover:ring-border-strong rounded-md px-1.5 py-0.5 font-mono text-[10.5px] ring-1 transition',
                url === p.url && 'text-accent ring-accent/40',
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
        <Switch
          checked={auth}
          onChange={setAuth}
          label={i18n.t('Requires authentication')}
          description={i18n.t('Basic auth; the password is passed to helm on stdin.')}
        />
        <Switch
          checked={force}
          onChange={setForce}
          label={i18n.t('Replace if it exists')}
          description={i18n.t('Overwrite a repository with the same name.')}
        />
        <Switch
          checked={insecure}
          onChange={setInsecure}
          label={i18n.t('Skip TLS verification')}
          description={i18n.t('Accept self-signed certificates. Insecure.')}
        />
        <Switch
          checked={passCredentials}
          onChange={setPassCredentials}
          label={i18n.t('Pass credentials to all domains')}
          description={i18n.t('Send the credentials to chart downloads on other hosts too.')}
        />
      </div>
      {auth && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={i18n.t('Username')}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={i18n.t('Password')}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
      )}
      {error && (
        <p className="bg-status-error/8 text-status-error rounded-md px-3 py-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {i18n.t('Cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!valid || busy}
          leftIcon={
            busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )
          }
        >
          {busy ? i18n.t('Adding…') : i18n.t('Add')}
        </Button>
      </div>
    </form>
  );
}
