import * as i18n from '@/i18n';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { asObject, asString, decodeBase64, field } from '@/lib/kube/accessors';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { CodeBlock, CopyButton, Row, Rows, Section } from '../primitives';
import type { SectionProps } from './types';

export function ConfigMapSections({ obj }: SectionProps) {
  i18n.useLocale();
  const data = asObject(field(obj, 'data'));
  const binary = asObject(field(obj, 'binaryData'));
  const keys = Object.keys(data).sort();
  return (
    <Section title={i18n.t('Data')}>
      {!keys.length && !Object.keys(binary).length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('No data')}</p>
      ) : (
        <div className="space-y-3">
          {keys.map((k) => (
            <div key={k}>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-fg font-mono text-[11.5px] font-medium">{k}</span>
                <span className="text-fg-dim text-[10.5px]">
                  {formatBytes(new TextEncoder().encode(asString(data[k])).length)}
                </span>
              </div>
              <CodeBlock text={asString(data[k])} />
            </div>
          ))}
          {Object.keys(binary).map((k) => (
            <div key={k} className="text-fg-muted flex items-center gap-2 text-[12px]">
              <span className="text-fg font-mono text-[11.5px]">{k}</span>
              <span className="text-fg-dim">
                {i18n.t('binary, {size}', {
                  size: formatBytes(Math.floor((asString(binary[k]).length * 3) / 4)),
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function SecretValue({ name, encoded }: { name: string; encoded: string }) {
  i18n.useLocale();
  const [revealed, setRevealed] = useState(false);
  const decoded = decodeBase64(encoded);
  const multiline = decoded.includes('\n');
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-fg font-mono text-[11.5px] font-medium">{name}</span>
        <span className="text-fg-dim text-[10.5px]">
          {formatBytes(Math.floor((encoded.length * 3) / 4))}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setRevealed((x) => !x)}
            aria-label={
              revealed
                ? i18n.t('Hide value of {key}', { key: name })
                : i18n.t('Reveal value of {key}', { key: name })
            }
            title={revealed ? i18n.t('Hide') : i18n.t('Reveal')}
            className="text-fg-dim hover:text-fg hover:bg-fg/8 inline-flex h-6 w-6 items-center justify-center rounded-md transition"
          >
            {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
          <CopyButton text={decoded} label={i18n.t('Copy decoded value')} />
        </div>
      </div>
      {revealed ? (
        multiline ? (
          <CodeBlock text={decoded} />
        ) : (
          <div className="bg-fg/[0.035] border-border/60 text-fg overflow-x-auto rounded-md border px-2.5 py-1.5 font-mono text-[11px] whitespace-pre">
            {decoded}
          </div>
        )
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className={cn(
            'bg-fg/[0.035] border-border/60 text-fg-dim hover:text-fg-muted w-full rounded-md border px-2.5 py-1.5 text-left font-mono text-[11px] tracking-[0.2em]',
          )}
        >
          {'•'.repeat(Math.min(24, Math.max(8, decoded.length)))}
        </button>
      )}
    </div>
  );
}

export function SecretSections({ obj }: SectionProps) {
  i18n.useLocale();
  const data = asObject(field(obj, 'data'));
  const keys = Object.keys(data).sort();
  return (
    <>
      <Section title={i18n.t('Secret')}>
        <Rows>
          <Row label={i18n.t('Type')}>
            <span className="font-mono text-[11.5px]">
              {asString(field(obj, 'type')) || 'Opaque'}
            </span>
          </Row>
          <Row label={i18n.t('Immutable')}>
            {field(obj, 'immutable') === true ? i18n.t('Yes') : null}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Data')}>
        {keys.length ? (
          <div className="space-y-3">
            {keys.map((k) => (
              <SecretValue key={k} name={k} encoded={asString(data[k])} />
            ))}
          </div>
        ) : (
          <p className="text-fg-dim text-[12px]">{i18n.t('No data')}</p>
        )}
      </Section>
    </>
  );
}
