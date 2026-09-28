import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { FileUp, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { formatBytes } from '@/lib/format';
import { parseEnvFile } from '@/lib/kube/wizards/configmap';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import {
  buildSecret,
  DOCKER_HUB,
  SECRET_FLAVORS,
  secretBlocked,
  secretDefaults,
  validateSecret,
  valueSize,
  valueText,
  type SecretEntry,
  type SecretFlavor,
  type SecretInput,
  type SecretValue,
} from '@/lib/kube/wizards/secret';
import { checkTlsPair } from '@/lib/kube/wizards/tls';
import { certificateExpiry } from '@/lib/kube/x509';
import { useAppStore } from '@/store/useAppStore';
import type { LocalFile } from '@/types';
import { GVK } from './data';
import {
  FieldError,
  FieldGrid,
  FileChip,
  KeyValueRows,
  LoadFileButton,
  NamespaceSelect,
  ExpiryLine,
  Notice,
  RevealToggle,
  Section,
  SecretField,
  SecretTextarea,
} from './fields';
import { localFileText } from './files';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

function flavorLabel(flavor: SecretFlavor): string {
  switch (flavor) {
    case 'generic':
      return i18n.t('Generic');
    case 'docker-registry':
      return i18n.t('Registry');
    case 'tls':
      return 'TLS';
    case 'basic-auth':
      return i18n.t('Basic auth');
    case 'ssh-auth':
      return i18n.t('SSH key');
  }
}

/** `kubectl create secret generic | docker-registry | tls | basic-auth | ssh-auth`. */
export function SecretWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'secret' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [input, setInput] = useState<SecretInput>(() =>
    secretDefaults(request.flavor, request.namespace),
  );
  const [revealPreview, setRevealPreview] = useState(false);
  const patch = (p: Partial<SecretInput>) => setInput((s) => ({ ...s, ...p }));
  const errors = useMemo(() => validateSecret(input), [input]);
  const blocked = secretBlocked(errors);
  const yaml = useMemo(() => manifestYaml([buildSecret(input)]), [input]);
  const preview = useMemo(
    () => (revealPreview ? yaml : manifestYaml([buildSecret(input, { redact: true })])),
    [input, revealPreview, yaml],
  );

  return (
    <WizardShell
      request={request}
      title={i18n.t('Create Secret')}
      subtitle={`kubectl create secret ${input.flavor}`}
      yaml={yaml}
      previewYaml={preview}
      namespace={input.namespace}
      blocked={blocked}
      errors={errors}
      creates={[{ gvk: GVK.secret, namespace: input.namespace }]}
      secret
      revealed={revealPreview}
      onReveal={() => setRevealPreview((v) => !v)}
      onClose={onClose}
    >
      <div className="-mx-1 overflow-x-auto px-1">
        <Tabs
          tabs={SECRET_FLAVORS.map((f) => ({ key: f, label: flavorLabel(f) }))}
          value={input.flavor}
          onChange={(flavor) => patch({ flavor })}
        />
      </div>
      <FieldGrid>
        <Field label={i18n.t('Name')} error={input.name ? errors.name : null}>
          <Input
            mono
            autoFocus
            value={input.name}
            placeholder={placeholderName(input.flavor)}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            onChange={(namespace) => patch({ namespace })}
          />
        </Field>
      </FieldGrid>

      {input.flavor === 'generic' && (
        <GenericFields input={input} errors={errors.entries} onChange={patch} />
      )}
      {input.flavor === 'docker-registry' && (
        <RegistryFields input={input} errors={errors.fields} onChange={patch} />
      )}
      {input.flavor === 'tls' && (
        <TlsFields input={input} errors={errors.fields} onChange={patch} />
      )}
      {input.flavor === 'basic-auth' && (
        <BasicFields input={input} errors={errors.fields} onChange={patch} />
      )}
      {input.flavor === 'ssh-auth' && (
        <SshFields input={input} errors={errors.fields} onChange={patch} />
      )}
      {errors.general && <Notice tone="error">{errors.general}</Notice>}

      <Section title={i18n.t('Options')}>
        <KeyValueRows
          rows={input.labels}
          onChange={(labels) => patch({ labels })}
          keyPlaceholder={i18n.t('Label key')}
          valuePlaceholder={i18n.t('Value')}
          addLabel={i18n.t('Add label')}
        />
        <FieldError>{errors.labels}</FieldError>
        <Switch
          checked={input.immutable}
          onChange={(immutable) => patch({ immutable })}
          label={i18n.t('Immutable')}
          description={i18n.t('Values cannot be changed later; replace the Secret instead.')}
        />
      </Section>
    </WizardShell>
  );
}

function placeholderName(flavor: SecretFlavor): string {
  switch (flavor) {
    case 'docker-registry':
      return 'registry-credentials';
    case 'tls':
      return 'app-tls';
    case 'basic-auth':
      return 'basic-auth';
    case 'ssh-auth':
      return 'git-ssh-key';
    default:
      return 'app-secrets';
  }
}

type FieldsProps = {
  input: SecretInput;
  onChange: (patch: Partial<SecretInput>) => void;
};

function GenericFields({
  input,
  errors,
  onChange,
}: FieldsProps & { errors: Array<string | null> }) {
  i18n.useLocale();
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const pushToast = useAppStore((s) => s.pushToast);
  const entries = input.entries;
  const set = (index: number, next: Partial<SecretEntry>) =>
    onChange({ entries: entries.map((e, i) => (i === index ? { ...e, ...next } : e)) });
  const withoutEmpty = () =>
    entries.filter((e) => e.key.trim() || e.value.kind === 'file' || e.value.text);
  const addFiles = (files: LocalFile[]) =>
    onChange({
      entries: [
        ...withoutEmpty(),
        ...files.map((file) => ({ key: file.name, value: { kind: 'file', file } as SecretValue })),
      ],
    });
  const importEnv = (files: LocalFile[]) => {
    const file = files[0];
    const text = file ? localFileText(file) : null;
    if (!file || text === null) {
      pushToast('error', i18n.t('The .env file is not UTF-8 text.'));
      return;
    }
    const parsed = parseEnvFile(text);
    const keys = new Set(parsed.entries.map((e) => e.key));
    onChange({
      entries: [
        ...withoutEmpty().filter((e) => !keys.has(e.key.trim())),
        ...parsed.entries.map((e) => ({
          key: e.key,
          value: { kind: 'text', text: e.value } as SecretValue,
        })),
      ],
    });
    pushToast(
      parsed.invalid.length ? 'info' : 'success',
      parsed.invalid.length
        ? i18n.plural(
            'Imported {count} key; skipped lines {lines}',
            'Imported {count} keys; skipped lines {lines}',
            parsed.entries.length,
            { lines: parsed.invalid.join(', ') },
          )
        : i18n.plural('Imported {count} key', 'Imported {count} keys', parsed.entries.length),
    );
  };

  return (
    <Section
      title={i18n.t('Data')}
      hint={i18n.t('Type values as plain text; they are base64-encoded for you.')}
      action={
        <>
          <LoadFileButton purpose="any" multiple onFiles={addFiles} />
          <LoadFileButton purpose="env" onFiles={importEnv} label={i18n.t('Import .env…')} />
        </>
      }
    >
      <div className="space-y-2.5">
        {entries.map((entry, index) => (
          <div key={index} className="border-border/70 space-y-1.5 rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5">
              <Input
                mono
                lang="en"
                value={entry.key}
                placeholder={i18n.t('Key')}
                aria-label={i18n.t('Key')}
                onChange={(e) => set(index, { key: e.target.value })}
                className="min-w-0 flex-1"
              />
              {entry.value.kind === 'text' && (
                <RevealToggle
                  size="sm"
                  revealed={!!revealed[index]}
                  onToggle={() => setRevealed((r) => ({ ...r, [index]: !r[index] }))}
                />
              )}
              <LoadFileButton
                purpose="any"
                label={i18n.t('File…')}
                onFiles={([file]) => file && set(index, { value: { kind: 'file', file } })}
              />
              <IconButton
                label={i18n.t('Remove key')}
                icon={<X />}
                onClick={() => onChange({ entries: entries.filter((_, i) => i !== index) })}
              />
            </div>
            {entry.value.kind === 'file' ? (
              <FileChip
                file={entry.value.file}
                onClear={() => set(index, { value: { kind: 'text', text: '' } })}
              />
            ) : (
              <SecretTextarea
                rows={2}
                value={entry.value.text}
                revealed={!!revealed[index]}
                placeholder={i18n.t('Value')}
                ariaLabel={i18n.t('Value of {key}', { key: entry.key || '…' })}
                onChange={(text) => set(index, { value: { kind: 'text', text } })}
              />
            )}
            <div className="flex items-center justify-between gap-2">
              <FieldError>{entry.key || entries.length > 1 ? errors[index] : null}</FieldError>
              <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
                {formatBytes(valueSize(entry.value))}
              </span>
            </div>
          </div>
        ))}
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Plus className="h-3 w-3" />}
          onClick={() =>
            onChange({ entries: [...entries, { key: '', value: { kind: 'text', text: '' } }] })
          }
        >
          {i18n.t('Add key')}
        </Button>
      </div>
    </Section>
  );
}

function RegistryFields({
  input,
  errors,
  onChange,
}: FieldsProps & { errors: Record<string, string | null> }) {
  i18n.useLocale();
  const [revealed, setRevealed] = useState(false);
  const r = input.registry;
  const set = (p: Partial<SecretInput['registry']>) => onChange({ registry: { ...r, ...p } });
  return (
    <Section
      // The Turkish text keeps the English term, so it keeps English casing too.
      title={<span lang="en">{i18n.t('Registry')}</span>}
      hint={i18n.t('Pods reference this Secret in imagePullSecrets to pull private images.')}
    >
      <Field label={i18n.t('Server')} error={errors.server}>
        <Input
          mono
          lang="en"
          value={r.server}
          placeholder={DOCKER_HUB}
          list="kp-registry-servers"
          onChange={(e) => set({ server: e.target.value })}
        />
        <datalist id="kp-registry-servers">
          {[DOCKER_HUB, 'ghcr.io', 'quay.io', 'registry.gitlab.com', 'public.ecr.aws'].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
      <FieldGrid>
        <Field label={i18n.t('Username')} error={r.username ? null : errors.username}>
          <Input
            mono
            value={r.username}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ username: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('E-mail (optional)')} error={errors.email}>
          <Input
            mono
            value={r.email}
            autoComplete="off"
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
      </FieldGrid>
      <Field label={i18n.t('Password or access token')} error={r.password ? null : errors.password}>
        <div className="flex items-center gap-1.5">
          <SecretField
            value={r.password}
            revealed={revealed}
            ariaLabel={i18n.t('Password or access token')}
            onChange={(password) => set({ password })}
          />
          <RevealToggle size="sm" revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
        </div>
      </Field>
    </Section>
  );
}

/** PEM input: typed/pasted text or a loaded file, optionally masked. */
function PemInput({
  label,
  dataKey,
  optional = false,
  value,
  onChange,
  purpose,
  masked,
  error,
  placeholder,
}: {
  label: string;
  /** Data key, shown untranslated (with English casing). */
  dataKey: string;
  optional?: boolean;
  value: SecretValue;
  onChange: (value: SecretValue) => void;
  purpose: 'cert' | 'key' | 'ssh-key' | 'known-hosts';
  masked: boolean;
  error: string | null;
  placeholder: string;
}) {
  i18n.useLocale();
  const [revealed, setRevealed] = useState(false);
  const empty = value.kind === 'text' && !value.text;
  return (
    <Section
      title={
        optional
          ? i18n.rich('{label} ({key}, optional)', { label, key: <span lang="en">{dataKey}</span> })
          : i18n.rich('{label} ({key})', { label, key: <span lang="en">{dataKey}</span> })
      }
      action={
        <>
          {masked && value.kind === 'text' && (
            <RevealToggle revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
          )}
          <LoadFileButton
            purpose={purpose}
            onFiles={([file]) => file && onChange({ kind: 'file', file })}
          />
        </>
      }
    >
      {value.kind === 'file' ? (
        <FileChip file={value.file} onClear={() => onChange({ kind: 'text', text: '' })} />
      ) : masked ? (
        <SecretTextarea
          rows={4}
          value={value.text}
          revealed={revealed}
          placeholder={placeholder}
          ariaLabel={label}
          onChange={(text) => onChange({ kind: 'text', text })}
        />
      ) : (
        <Textarea
          mono
          rows={4}
          value={value.text}
          placeholder={placeholder}
          aria-label={label}
          spellCheck={false}
          onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
        />
      )}
      {!empty && <FieldError>{error}</FieldError>}
    </Section>
  );
}

function TlsFields({
  input,
  errors,
  onChange,
}: FieldsProps & { errors: Record<string, string | null> }) {
  i18n.useLocale();
  const check = useMemo(
    () => checkTlsPair(valueText(input.tls.cert), valueText(input.tls.key)),
    [input.tls],
  );
  const leaf = check.certs[0];
  const expiry = leaf ? certificateExpiry(leaf) : null;
  return (
    <>
      <PemInput
        label={i18n.t('Certificate')}
        dataKey="tls.crt"
        value={input.tls.cert}
        onChange={(cert) => onChange({ tls: { ...input.tls, cert } })}
        purpose="cert"
        masked={false}
        error={errors.cert ?? null}
        placeholder="-----BEGIN CERTIFICATE-----"
      />
      <PemInput
        label={i18n.t('Private key')}
        dataKey="tls.key"
        value={input.tls.key}
        onChange={(key) => onChange({ tls: { ...input.tls, key } })}
        purpose="key"
        masked
        error={errors.key ?? null}
        placeholder="-----BEGIN PRIVATE KEY-----"
      />
      {leaf && (
        <div className="border-border/70 space-y-1 rounded-lg border px-3 py-2 text-[12px]">
          <div className="flex min-w-0 items-center gap-2">
            <FileUp className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <span className="text-fg min-w-0 truncate font-mono" lang="en">
              {leaf.subject.cn || leaf.subject.dn}
            </span>
            <span className="text-fg-dim ml-auto shrink-0 text-[11px]">{leaf.keyAlgorithm}</span>
          </div>
          {leaf.sans.length > 0 && (
            <p className="text-fg-muted font-mono text-[11px] break-all">{leaf.sans.join(', ')}</p>
          )}
          <p className="text-fg-dim flex flex-wrap gap-x-3 text-[11px]">
            <span>
              {i18n.t('Issued by {issuer}', { issuer: leaf.issuer.cn || leaf.issuer.dn })}
            </span>
            {check.certs.length > 1 && (
              <span>
                {i18n.plural(
                  '{count} certificate in the chain',
                  '{count} certificates in the chain',
                  check.certs.length,
                )}
              </span>
            )}
          </p>
          {expiry && (
            <ExpiryLine notAfter={leaf.notAfter} state={expiry.state} days={expiry.daysLeft} />
          )}
        </div>
      )}
      {check.match === 'match' && (
        <Notice tone="success">{i18n.t('The private key belongs to the certificate.')}</Notice>
      )}
      {check.match === 'unknown' && (
        <Notice>
          {i18n.t(
            'Both parse, but this key type cannot be matched locally; the API server does not check it either.',
          )}
        </Notice>
      )}
    </>
  );
}

function BasicFields({
  input,
  errors,
  onChange,
}: FieldsProps & { errors: Record<string, string | null> }) {
  i18n.useLocale();
  const [revealed, setRevealed] = useState(false);
  const b = input.basic;
  return (
    <Section title={i18n.t('Credentials')}>
      <FieldGrid>
        <Field label={i18n.t('Username')} error={errors.username}>
          <Input
            mono
            value={b.username}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange({ basic: { ...b, username: e.target.value } })}
          />
        </Field>
        <Field label={i18n.t('Password')}>
          <div className="flex items-center gap-1.5">
            <SecretField
              value={b.password}
              revealed={revealed}
              ariaLabel={i18n.t('Password')}
              onChange={(password) => onChange({ basic: { ...b, password } })}
            />
            <RevealToggle size="sm" revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
          </div>
        </Field>
      </FieldGrid>
    </Section>
  );
}

function SshFields({
  input,
  errors,
  onChange,
}: FieldsProps & { errors: Record<string, string | null> }) {
  i18n.useLocale();
  return (
    <>
      <PemInput
        label={i18n.t('Private key')}
        dataKey="ssh-privatekey"
        value={input.ssh.privateKey}
        onChange={(privateKey) => onChange({ ssh: { ...input.ssh, privateKey } })}
        purpose="ssh-key"
        masked
        error={errors.privateKey ?? null}
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
      />
      <PemInput
        label={i18n.t('Known hosts')}
        dataKey="known_hosts"
        optional
        value={input.ssh.knownHosts}
        onChange={(knownHosts) => onChange({ ssh: { ...input.ssh, knownHosts } })}
        purpose="known-hosts"
        masked={false}
        error={null}
        placeholder="github.com ssh-ed25519 AAAA…"
      />
    </>
  );
}
