import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import { FileCode2, Plus } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { openWizardEntry, wizardsForKind } from './catalog';

/**
 * The resource page's "+" button. Kinds with wizards get a menu (YAML
 * template first, then the wizards); every other kind opens the template
 * directly, as before.
 */
export function CreateButton({
  clusterId,
  kindKey,
  namespace,
  label,
  disabled,
  onTemplate,
}: {
  clusterId: string;
  kindKey: string;
  /** Namespace the wizards start in. */
  namespace: string;
  /** Tooltip (includes why it is disabled). */
  label: string;
  disabled: boolean;
  onTemplate: () => void;
}) {
  i18n.useLocale();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wizards = wizardsForKind(kindKey);
  if (!wizards.length)
    return <IconButton label={label} icon={<Plus />} disabled={disabled} onClick={onTemplate} />;

  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.right - 260, y: r.bottom + 4 });
  };
  const items: FileContextMenuEntry[] = [
    {
      id: 'template',
      label: i18n.t('From a YAML template'),
      icon: <FileCode2 size={12} />,
      onClick: onTemplate,
    },
    { id: 'sep', separator: true },
    ...wizards.map((w) => {
      const Icon = w.icon;
      return {
        id: w.id,
        label: w.label(),
        icon: <Icon size={12} />,
        title: w.command,
        onClick: () => openWizardEntry(w, clusterId, namespace),
      };
    }),
  ];
  return (
    <>
      <IconButton
        ref={button}
        label={label}
        icon={<Plus />}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={open}
      />
      {menu && (
        <FileContextMenu
          x={Math.max(8, menu.x)}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
