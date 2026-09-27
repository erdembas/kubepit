import * as i18n from '@/i18n';
import { Download, FileQuestion, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { formatBytes } from '@/lib/format';
import type { PodFileContent } from '@/types';
import { MonacoView } from '../../common/MonacoView';
import { imageMime, languageFor } from './model';

export type PreviewState =
  | { state: 'loading'; name: string }
  | { state: 'ready'; name: string; content: PodFileContent }
  | { state: 'error'; name: string; message: string };

function shownBytes(content: PodFileContent): number {
  if (content.text !== null) return new TextEncoder().encode(content.text).length;
  return Math.floor(((content.base64?.length ?? 0) * 3) / 4);
}

/** Read-only preview of the selected file: Monaco for text, <img> for images. */
export function FilePreview({
  preview,
  onDownload,
  onClose,
}: {
  preview: PreviewState;
  onDownload: () => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  const content = preview.state === 'ready' ? preview.content : null;
  const size = content?.size ?? null;
  const mime = imageMime(preview.name);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={i18n.t('Preview')}>
      <div className="border-border/60 bg-surface flex h-8 shrink-0 items-center gap-2 border-b pr-1 pl-3">
        <span className="text-fg truncate font-mono text-[11.5px]" title={preview.name}>
          {preview.name}
        </span>
        {size !== null && (
          <span className="text-fg-dim shrink-0 text-[10.5px] tabular-nums">
            {formatBytes(size)}
          </span>
        )}
        {content?.truncated && (
          <span className="bg-tone-warning/12 text-tone-warning-fg shrink-0 rounded px-1.5 py-px text-[10px] font-medium">
            {i18n.t('first {size} only', { size: formatBytes(shownBytes(content)) })}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            size="xs"
            label={i18n.t('Download…')}
            icon={<Download />}
            onClick={onDownload}
          />
          <IconButton size="xs" label={i18n.t('Close preview')} icon={<X />} onClick={onClose} />
        </span>
      </div>
      {preview.state === 'loading' ? (
        <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[11.5px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t('Loading preview…')}
        </div>
      ) : preview.state === 'error' ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-status-error max-w-md text-center text-[11.5px] break-words">
            {preview.message}
          </p>
        </div>
      ) : content?.binary && content.base64 && mime && !content.truncated ? (
        <div className="bg-surface-muted flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img
            src={`data:${mime};base64,${content.base64}`}
            alt={preview.name}
            className="max-h-full max-w-full object-contain [image-rendering:auto]"
          />
        </div>
      ) : content?.binary ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="bg-fg/5 text-fg-dim flex h-10 w-10 items-center justify-center rounded-xl">
            <FileQuestion className="h-5 w-5" />
          </span>
          <p className="text-fg-muted max-w-sm text-[12px]">
            {i18n.t('Binary file — download it to inspect the content.')}
          </p>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            onClick={onDownload}
          >
            {i18n.t('Download…')}
          </Button>
        </div>
      ) : (
        <MonacoView value={content?.text ?? ''} language={languageFor(preview.name)} />
      )}
    </section>
  );
}
