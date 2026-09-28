import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, FilePenLine, Lock, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { accessCheck } from '@/lib/kube/access';
import { cn } from '@/lib/cn';
import { useAccess } from '@/store/useAccessStore';
import type { AccessCheck, Gvk } from '@/types';
import { deniedMessage } from '../access/gates';
import { useCluster } from '../data/hooks';
import { Notice } from './fields';
import { handOff, type WizardRequest } from './wizardStore';

/**
 * Frame of every wizard: the form on the left (or on top in narrow
 * dialogs), a live YAML preview beside it, and a footer that hands the
 * manifest to the create editor — optionally straight into its dry-run
 * review. Nothing here writes to the cluster.
 */
export function WizardShell({
  request,
  title,
  subtitle,
  yaml,
  previewYaml,
  namespace,
  blocked,
  errors,
  creates,
  secret = false,
  revealed = false,
  onReveal,
  onClose,
  children,
}: {
  request: WizardRequest;
  title: string;
  subtitle?: string;
  /** The real manifest handed to the editor. */
  yaml: string;
  /** What the preview shows (secret wizards redact values until revealed). */
  previewYaml?: string;
  /** Target namespace for the editor (null: cluster-scoped). */
  namespace: string | null;
  /** Local validation blocks the hand-off. */
  blocked: boolean;
  /** The wizard's validation result; its first message explains a blocked footer. */
  errors?: unknown;
  /** What will be created, for the permission hint. */
  creates: Array<{ gvk: Gvk; namespace: string | null }>;
  secret?: boolean;
  revealed?: boolean;
  onReveal?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  i18n.useLocale();
  const { readOnly, production } = useCluster(request.clusterId);
  const checks = useMemo<AccessCheck[]>(
    () => creates.map((c) => accessCheck('create', c.gvk, { namespace: c.namespace })),
    // The list is rebuilt each render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(creates)],
  );
  const answers = useAccess(request.clusterId, checks);
  const denied = checks.find((_, i) => answers[i]?.state === 'denied');

  const problem = blocked ? firstMessage(errors) : null;

  const send = (review: boolean) => {
    if (blocked) return;
    handOff(request, yaml, namespace, review);
  };

  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      size="xl"
      onClose={onClose}
      bodyClassName="@container/wizard flex h-[min(640px,calc(85vh-7.5rem))] min-h-0 flex-col overflow-hidden"
      footer={
        <>
          {problem ? (
            <span
              className="text-status-error mr-auto min-w-0 truncate text-[11px]"
              title={problem}
            >
              {problem}
            </span>
          ) : (
            <span className="text-fg-dim mr-auto min-w-0 truncate text-[11px]">
              {readOnly
                ? i18n.t('Read-only cluster: the review runs, applying is blocked.')
                : production
                  ? i18n.t('Production cluster: every change is reviewed before it is applied.')
                  : i18n.t('Nothing is created until you apply it in the editor.')}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={blocked}
            leftIcon={<FilePenLine className="h-3.5 w-3.5" />}
            onClick={() => send(false)}
            title={i18n.t('Open the manifest in the create editor without a review')}
          >
            {i18n.t('Open in editor')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={blocked}
            leftIcon={<ScanSearch className="h-3.5 w-3.5" />}
            onClick={() => send(true)}
            title={i18n.t('Open the manifest in the create editor and run a server-side dry run')}
          >
            {i18n.t('Review & create')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col @3xl/wizard:flex-row">
        <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-5">
            {denied && (
              <Notice tone="warning">
                <span className="inline-flex items-start gap-1.5">
                  <Lock className="mt-px h-3 w-3 shrink-0" />
                  {deniedMessage(denied)}
                </span>
              </Notice>
            )}
            {children}
          </div>
        </div>
        <YamlPreview
          yaml={previewYaml ?? yaml}
          secret={secret}
          revealed={revealed}
          onReveal={onReveal}
        />
      </div>
    </Dialog>
  );
}

/** First message in a (nested) validation result, in declaration order. */
function firstMessage(errors: unknown): string | null {
  if (typeof errors === 'string') return errors || null;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const m = firstMessage(e);
      if (m) return m;
    }
    return null;
  }
  if (errors && typeof errors === 'object') {
    for (const [key, value] of Object.entries(errors)) {
      // Warnings never block.
      if (key.endsWith('Warning')) continue;
      const m = firstMessage(value);
      if (m) return m;
    }
  }
  return null;
}

function YamlPreview({
  yaml,
  secret,
  revealed,
  onReveal,
}: {
  yaml: string;
  secret: boolean;
  revealed: boolean;
  onReveal?: () => void;
}) {
  i18n.useLocale();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* Clipboard can be unavailable; nothing to report. */
    }
  };
  return (
    <aside className="border-border bg-surface/60 flex h-[40%] min-h-32 shrink-0 flex-col border-t @3xl/wizard:h-auto @3xl/wizard:w-[44%] @3xl/wizard:border-t-0 @3xl/wizard:border-l">
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-fg-dim text-[11px] font-semibold tracking-[0.14em] uppercase">
          {i18n.t('YAML preview')}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {secret && onReveal && (
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={revealed}
              leftIcon={revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              onClick={onReveal}
            >
              {revealed ? i18n.t('Hide values') : i18n.t('Reveal values')}
            </Button>
          )}
          {(!secret || revealed) && (
            <IconButton
              size="xs"
              label={copied ? i18n.t('Copied') : i18n.t('Copy YAML')}
              icon={copied ? <Check /> : <Copy />}
              onClick={() => void copy()}
            />
          )}
        </div>
      </div>
      <pre
        className="text-fg-muted min-h-0 flex-1 overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] select-text"
        lang="en"
      >
        {yaml.split('\n').map((line, i) => (
          <YamlLine key={i} line={line} />
        ))}
      </pre>
    </aside>
  );
}

/** Light highlighting: document separators, keys, list dashes, comments. */
function YamlLine({ line }: { line: string }) {
  if (line === '---') return <div className="text-fg-dim/70">{line}</div>;
  if (/^\s*#/.test(line)) return <div className="text-fg-dim italic">{line}</div>;
  const m = /^(\s*)(- )?([^\s:'"][^:]*?|"[^"]*"|'[^']*'):( |$)(.*)$/.exec(line);
  if (!m) return <div className="whitespace-pre">{line || ' '}</div>;
  const [, indent, dash, key, space, value] = m;
  return (
    <div className="whitespace-pre">
      {indent}
      {dash && <span className="text-fg-dim">{dash}</span>}
      <span className="text-fg">{key}</span>
      <span className="text-fg-dim">:</span>
      {space}
      <span className={cn(value?.startsWith('<') && 'text-fg-dim italic')}>{value}</span>
    </div>
  );
}
