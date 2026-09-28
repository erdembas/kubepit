import * as i18n from '@/i18n';
import { useState } from 'react';
import { Lock, MoreHorizontal } from 'lucide-react';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import type { ResourceAction } from '../actions/resourceActions';
import { LockedIcon, OPEN_GATE, useActionGates } from '../access/gates';

/** Icon toolbar for the details header; secondary actions live in "More". */
export function DetailsToolbar({
  clusterId,
  actions,
  readOnly,
}: {
  clusterId: string;
  actions: ResourceAction[];
  readOnly: boolean;
}) {
  i18n.useLocale();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const gates = useActionGates(clusterId, actions, readOnly);
  const primary = actions.filter((a) => a.primary);
  const rest = actions.filter((a) => !a.primary);
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {primary.map((a) => {
        const Icon = a.icon;
        const gate = gates.get(a.id) ?? OPEN_GATE;
        return (
          <IconButton
            key={a.id}
            label={gate.blocked ? `${a.label} — ${gate.message}` : a.label}
            icon={gate.reason === 'permission' ? <LockedIcon icon={Icon} /> : <Icon />}
            tone={a.tone === 'danger' ? 'danger' : 'default'}
            disabled={gate.blocked}
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
            const gate = gates.get(a.id) ?? OPEN_GATE;
            return {
              id: a.id,
              label: a.label,
              icon: gate.reason === 'permission' ? <Lock size={12} /> : <Icon size={12} />,
              tone: a.tone,
              disabled: gate.blocked,
              title: gate.message ?? undefined,
              onClick: () => a.run(menu),
            };
          })}
        />
      )}
    </div>
  );
}
