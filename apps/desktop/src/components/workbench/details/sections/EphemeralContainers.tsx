import * as i18n from '@/i18n';
import { Bug, FolderTree, Link2, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { asArray, asString, isObject, spec, status } from '@/lib/kube/accessors';
import { containerNames, containerTone } from '@/lib/kube/pods';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { dock } from '@/store/useDockStore';
import type { KubeObject } from '@/types';
import { ephemeralContainers, openPodDebug, openPodFiles } from '../../actions/logsDebugActions';
import { Section } from '../primitives';

/**
 * Debug containers added with `kubectl debug` / Kubepit's Debug action,
 * with their state and an Attach button. The section always renders on
 * running pods so "Debug…" is one click away.
 */
export function EphemeralContainersSection({
  clusterId,
  pod,
  readOnly,
  now,
}: {
  clusterId: string;
  pod: KubeObject;
  readOnly: boolean;
  now: number;
}) {
  i18n.useLocale();
  const list = ephemeralContainers(pod);
  const running = asString(status(pod).phase) === 'Running';
  if (list.length === 0 && !running) return null;
  const ns = pod.metadata.namespace ?? 'default';
  const targets = new Map(
    asArray(spec(pod).ephemeralContainers)
      .filter(isObject)
      .map((c) => [asString(c.name), asString(c.targetContainerName)]),
  );
  return (
    <Section
      title={i18n.t('Debug containers')}
      actions={
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Bug className="h-3 w-3" />}
          disabled={readOnly || !running}
          title={readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined}
          onClick={() => openPodDebug(clusterId, pod)}
        >
          {i18n.t('Debug…')}
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="text-fg-dim text-[11.5px]">
          {i18n.t(
            'None yet. A debug container adds a shell and tools to this pod without restarting it.',
          )}
        </p>
      ) : (
        <div className="border-border bg-surface-raised/40 divide-border/60 divide-y rounded-lg border">
          {list.map((c) => {
            const target = targets.get(c.name);
            const state =
              c.state === 'running'
                ? i18n.t('Running')
                : c.state === 'unknown'
                  ? i18n.t('Starting')
                  : `${c.state === 'waiting' ? i18n.t('Waiting') : i18n.t('Terminated')}${c.reason ? `: ${c.reason}` : ''}`;
            return (
              <div key={c.name} className="flex items-center gap-2 px-3 py-2">
                <span
                  className={cn('h-2.5 w-2.5 shrink-0 rounded-[2px]', containerTone(c))}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-fg truncate text-[12.5px] font-semibold">{c.name}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[11px]',
                        c.state === 'running' ? 'text-status-running' : 'text-fg-muted',
                      )}
                    >
                      {state}
                      {c.startedAt &&
                        ` · ${i18n.t('since {age}', { age: formatAge(c.startedAt, now) })}`}
                    </span>
                  </div>
                  <div className="text-fg-dim flex min-w-0 items-center gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-mono" title={c.image}>
                      {c.image}
                    </span>
                    {target && (
                      <span className="shrink-0">
                        {i18n.t('target {container}', { container: target })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    leftIcon={<ScrollText className="h-3 w-3" />}
                    onClick={() =>
                      dock.logs(
                        clusterId,
                        ns,
                        pod.metadata.name,
                        [...containerNames(pod, true), ...list.map((e) => e.name)],
                        c.name,
                      )
                    }
                  >
                    {i18n.t('Logs')}
                  </Button>
                  {c.state === 'running' && (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        leftIcon={<FolderTree className="h-3 w-3" />}
                        onClick={() => openPodFiles(clusterId, pod, c.name)}
                      >
                        {i18n.t('Files')}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        leftIcon={<Link2 className="h-3 w-3" />}
                        onClick={() => dock.podAttach(clusterId, ns, pod.metadata.name, c.name)}
                      >
                        {i18n.t('Attach')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
