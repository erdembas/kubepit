import * as i18n from '@/i18n';
import { AppShell } from '@/components/app/AppShell';
import { useAlertNotifications } from '@/components/alerts/useAlertNotifications';
import { useAppBootstrap } from '@/components/app/useAppBootstrap';
import { useAppShortcuts } from '@/components/app/useAppShortcuts';
import { useUiZoomShortcuts } from '@/lib/ui-zoom';

export default function App() {
  i18n.useLocale();
  useAppBootstrap();
  useAppShortcuts();
  useAlertNotifications();
  useUiZoomShortcuts();
  return <AppShell />;
}
