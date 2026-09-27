import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import { ChevronDown, Laptop, Plus, TerminalSquare } from 'lucide-react';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { DockStripAction } from './DockStripAction';

interface Props {
  clusterName: string | null;
  onClusterShell: () => void;
  onLocalShell: () => void;
}

/** "+ New Terminal" with a chevron menu: cluster shell (default) or a plain local shell. */
export function NewTerminalButton({ clusterName, onClusterShell, onLocalShell }: Props) {
  i18n.useLocale();
  const chevronRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="flex items-center">
      <DockStripAction
        icon={<Plus />}
        label={i18n.t('New Terminal')}
        title={i18n.t('New shell with this cluster’s kubeconfig')}
        onClick={onClusterShell}
        className="rounded-r-none pr-1"
      />
      <div ref={chevronRef}>
        <DockStripAction
          icon={<ChevronDown />}
          title={i18n.t('More terminal options')}
          active={menuPos !== null}
          className="rounded-l-none px-1"
          onClick={() => {
            const rect = chevronRef.current?.getBoundingClientRect();
            if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
          }}
        />
      </div>
      {menuPos && (
        <FileContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          items={[
            {
              id: 'cluster-shell',
              label: clusterName
                ? i18n.t('Cluster shell ({cluster})', { cluster: clusterName })
                : i18n.t('Cluster shell'),
              icon: <TerminalSquare size={12} />,
              onClick: onClusterShell,
            },
            {
              id: 'local-shell',
              label: i18n.t('Local shell (no cluster)'),
              icon: <Laptop size={12} />,
              onClick: onLocalShell,
            },
          ]}
        />
      )}
    </div>
  );
}
