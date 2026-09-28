import * as i18n from '@/i18n';
import { memo } from 'react';
import { cn } from '@/lib/cn';
import type { FieldOp } from '@/lib/logs/filter';
import type { JsonLine, JsonTokenKind } from '@/lib/logs/jsonLines';

/** Pixel height of one detail line (the table sizes expanded rows from it). */
export const JSON_LINE_HEIGHT = 16;

const TOKEN: Record<JsonTokenKind, string> = {
  string: 'text-status-running',
  number: 'text-tone-info',
  boolean: 'text-cat-backend',
  null: 'text-fg-dim',
  punct: 'text-fg-dim',
};

/**
 * Pretty JSON of a record, one line per `JsonLine`. Leaf values of object
 * fields are buttons: click adds `path=value`, Alt/Option-click
 * `path!=value`.
 */
export const JsonView = memo(function JsonView({
  lines,
  onPick,
}: {
  lines: JsonLine[];
  onPick: (key: string, op: FieldOp, value: string) => void;
}) {
  i18n.useLocale();
  return (
    <div className="font-mono text-[11px]" style={{ lineHeight: `${JSON_LINE_HEIGHT}px` }}>
      {lines.map((line, i) => (
        <div
          key={i}
          className="whitespace-pre"
          style={{ paddingLeft: line.depth * 14, height: JSON_LINE_HEIGHT }}
        >
          {line.key !== null && (
            <>
              <span className="text-fg-muted">{JSON.stringify(line.key)}</span>
              <span className="text-fg-dim">: </span>
            </>
          )}
          {line.path && line.value !== null ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPick(line.path!, e.altKey ? '!=' : '=', line.value!);
              }}
              title={i18n.t('Filter by {filter} (Alt: exclude)', {
                filter: `${line.path}=${line.value.length > 40 ? `${line.value.slice(0, 39)}…` : line.value}`,
              })}
              className={cn('hover:bg-accent/15 rounded-sm text-left', TOKEN[line.kind])}
            >
              {line.text}
            </button>
          ) : (
            <span className={TOKEN[line.kind]}>{line.text}</span>
          )}
          {line.comma && <span className="text-fg-dim">,</span>}
        </div>
      ))}
    </div>
  );
});
