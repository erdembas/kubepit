import * as i18n from '@/i18n';
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import type { ResourceAction } from '../actions/resourceActions';

/** Icon toolbar for the details header; secondary actions live in "More". */
export function DetailsToolbar({
  actions,
  readOnly,
}: {
  actions: ResourceAction[];
  readOnly: boolean;
}) {
  i18n.useLocale();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const primary = actions.filter((a) => a.primary);
  const rest = actions.filter((a) => !a.primary);
  const lockLabel = i18n.t('Read-only cluster: changes are blocked');
  return (
    <div className="flex items-center gap-0.5">
      {primary.map((a) => {
        const Icon = a.icon;
        const blocked = a.mutating && readOnly;
        return (
          <IconButton
            key={a.id}
            label={blocked ? `${a.label} — ${lockLabel}` : a.label}
            icon={<Icon />}
            tone={a.tone === 'danger' ? 'danger' : 'default'}
            disabled={blocked}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              a.run({ x: r.left, y: r.bottom + 4 });
            }}
          />
        );
      })}
      {rest.length > 0 && (
        <IconButton
          label={i18n.t('More actions')}
          icon={<MoreHorizontal />}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        />
      )}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={rest.map((a) => {
            const Icon = a.icon;
            return {
              id: a.id,
              label: a.label,
              icon: <Icon size={12} />,
              tone: a.tone,
              disabled: a.mutating && readOnly,
              onClick: () => a.run(menu),
            };
          })}
        />
      )}
    </div>
  );
}
