import {
  Activity,
  Bug,
  Cloud,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Gauge,
  GitBranch,
  List,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  SquareTerminal,
  Tag,
  Trash2,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { CustomActionIcon } from '@/types';

/** Lucide icons behind the custom action icon names (`CUSTOM_ACTION_ICONS`). */
export const CUSTOM_ACTION_ICON: Record<CustomActionIcon, LucideIcon> = {
  terminal: SquareTerminal,
  play: Play,
  'file-text': FileText,
  search: Search,
  'external-link': ExternalLink,
  bug: Bug,
  zap: Zap,
  wrench: Wrench,
  eye: Eye,
  list: List,
  activity: Activity,
  'git-branch': GitBranch,
  cloud: Cloud,
  database: Database,
  shield: Shield,
  trash: Trash2,
  refresh: RefreshCw,
  tag: Tag,
  gauge: Gauge,
  rocket: Rocket,
};

export function customActionIcon(name: string): LucideIcon {
  return CUSTOM_ACTION_ICON[name as CustomActionIcon] ?? SquareTerminal;
}
