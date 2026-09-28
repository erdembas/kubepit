import * as i18n from '@/i18n';
import { type ReactNode } from 'react';
import {
  Bell,
  FileCode2,
  History,
  Info,
  Settings as SettingsIcon,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAppStore, type SettingsCategory } from '@/store/useAppStore';
import {
  AboutCategory,
  GeneralCategory,
  KubeconfigCategory,
  TerminalCategory,
  ToolsCategory,
} from './categories';
import { HistoryCategory } from './HistoryCategory';
import { NotificationsCategory } from './NotificationsCategory';

interface CategoryDef {
  id: SettingsCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  group: 'workspace' | 'system';
}

const CATEGORIES: ReadonlyArray<CategoryDef> = [
  {
    id: 'general',
    get label() {
      return i18n.t('General');
    },
    get description() {
      return i18n.t('Language, safety confirmations and log defaults.');
    },
    icon: SettingsIcon,
    group: 'workspace',
  },
  {
    id: 'kubeconfig',
    get label() {
      return i18n.t('Kubeconfig');
    },
    get description() {
      return i18n.t('Where Kubepit looks for kubeconfig files.');
    },
    icon: FileCode2,
    group: 'workspace',
  },
  {
    id: 'terminal',
    get label() {
      return i18n.t('Terminal & Shells');
    },
    get description() {
      return i18n.t('Shell, font size and node shell image.');
    },
    icon: SquareTerminal,
    group: 'workspace',
  },
  {
    id: 'notifications',
    get label() {
      return i18n.t('Notifications');
    },
    get description() {
      return i18n.t('Alerts from connected clusters, desktop notifications and filters.');
    },
    icon: Bell,
    group: 'workspace',
  },
  {
    id: 'history',
    get label() {
      return i18n.t('History');
    },
    get description() {
      return i18n.t(
        'Audit log of your actions, persistent events and changes, retention and storage.',
      );
    },
    icon: History,
    group: 'workspace',
  },
  {
    id: 'tools',
    get label() {
      return i18n.t('Tools');
    },
    get description() {
      return i18n.t('kubectl and helm binaries used for shells and Helm actions.');
    },
    icon: Wrench,
    group: 'system',
  },
  {
    id: 'about',
    get label() {
      return i18n.t('About & Updates');
    },
    get description() {
      return i18n.t('Version, updates, data folder and privacy.');
    },
    icon: Info,
    group: 'system',
  },
];

/** VS Code-style settings page rendered as a main tab (RunHQ layout). */
export function SettingsView() {
  i18n.useLocale();
  const active = useAppStore((s) => s.settingsCategory);
  const openSettings = useAppStore((s) => s.openSettings);
  const current = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0]!;

  return (
    <div className="bg-surface flex h-full min-h-0 w-full flex-col overflow-hidden">
      <header className="border-border bg-surface flex shrink-0 items-center border-b px-5 py-3">
        <div className="min-w-0">
          <span className="text-fg-dim inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wider uppercase">
            {i18n.rich('{icon}Settings', {
              icon: <SettingsIcon className="text-accent h-3 w-3" />,
            })}
          </span>
          <h1 className="text-fg text-[14px] leading-tight font-semibold tracking-tight">
            {current.label}
          </h1>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="bg-surface-raised/30 border-border flex w-[240px] shrink-0 flex-col border-r">
          <div className="text-fg-dim/80 px-3 pt-3 pb-2 text-[10px] font-semibold tracking-wider uppercase">
            {i18n.t('Categories')}
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-2">
            {CATEGORIES.map((cat, idx) => {
              const prev = CATEGORIES[idx - 1];
              const Icon = cat.icon;
              const isActive = active === cat.id;
              return (
                <div key={cat.id}>
                  {prev && prev.group !== cat.group && (
                    <div className="border-border/40 my-2 border-t" />
                  )}
                  <button
                    type="button"
                    onClick={() => openSettings(cat.id)}
                    title={cat.description}
                    className={cn(
                      'group rounded-app-sm relative flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] font-medium transition',
                      isActive
                        ? 'bg-accent/15 text-fg'
                        : 'text-fg-dim hover:bg-surface-overlay/60 hover:text-fg',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'absolute top-1 bottom-1 left-0 w-[2px] rounded-r-full transition',
                        isActive ? 'bg-accent' : 'bg-transparent',
                      )}
                    />
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        isActive ? 'text-accent' : 'text-fg-dim/80 group-hover:text-fg',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{cat.label}</span>
                  </button>
                </div>
              );
            })}
          </nav>
        </aside>
        <section className="bg-surface flex min-w-0 flex-1 flex-col">
          {active === 'general' && <GeneralCategory description={current.description} />}
          {active === 'kubeconfig' && <KubeconfigCategory description={current.description} />}
          {active === 'terminal' && <TerminalCategory description={current.description} />}
          {active === 'notifications' && (
            <NotificationsCategory description={current.description} />
          )}
          {active === 'history' && <HistoryCategory description={current.description} />}
          {active === 'tools' && <ToolsCategory description={current.description} />}
          {active === 'about' && <AboutCategory description={current.description} />}
        </section>
      </div>
    </div>
  );
}

export function SettingsPageShell({
  description,
  footer,
  children,
}: {
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  i18n.useLocale();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-6 py-5">
          {description && (
            <p className="text-fg-dim mb-5 text-[12px] leading-relaxed">{description}</p>
          )}
          {children}
        </div>
      </div>
      {footer && (
        <div className="border-border bg-surface-raised shrink-0 border-t">
          <div className="mx-auto flex w-full max-w-[860px] items-center gap-3 px-6 py-2.5">
            {footer}
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  trailing,
  children,
}: {
  title?: string;
  description?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  i18n.useLocale();
  return (
    <section className="mb-6">
      {(title || trailing) && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          {title && (
            <h3 className="text-fg text-[12px] font-semibold tracking-wide uppercase">{title}</h3>
          )}
          {trailing && <div className="shrink-0">{trailing}</div>}
        </div>
      )}
      {description && <p className="text-fg-dim mb-3 text-[11px] leading-snug">{description}</p>}
      {children}
    </section>
  );
}
