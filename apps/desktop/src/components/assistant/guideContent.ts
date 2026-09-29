import type { LucideIcon } from 'lucide-react';
import { Activity, FileCode2, Search, Stethoscope, Terminal, Wrench } from 'lucide-react';
import * as i18n from '@/i18n/core';

export interface AiCapability {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  entry: string;
  example: string;
}

/** Resolve copy at render time so the guide follows the interface language. */
export function aiCapabilities(): AiCapability[] {
  return [
    {
      id: 'diagnose',
      icon: Stethoscope,
      title: i18n.t('Understand failing workloads'),
      description: i18n.t(
        'Bring together workload status, events, current and previous logs, and available health findings to investigate a problem.',
      ),
      entry: i18n.t('Pod or workload menu → Explain with assistant'),
      example: i18n.t('Why is this Pod restarting, and what should I check first?'),
    },
    {
      id: 'fix',
      icon: Wrench,
      title: i18n.t('Turn a diagnosis into a fix'),
      description: i18n.t(
        'Ask for a targeted YAML change after a diagnosis. Review the proposed manifest and its dry-run result before applying it.',
      ),
      entry: i18n.t('Assistant diagnosis → Suggest a fix'),
      example: i18n.t('Suggest the smallest change that fixes this readiness probe.'),
    },
    {
      id: 'kubectl',
      icon: Terminal,
      title: i18n.t('Write kubectl in plain language'),
      description: i18n.t(
        'Describe what you want to inspect and get a command you can review and copy. Commands are never run automatically.',
      ),
      entry: i18n.t('Assistant mode menu → kubectl'),
      example: i18n.t('List Pods that are not running across all namespaces.'),
    },
    {
      id: 'promql',
      icon: Activity,
      title: i18n.t('Build and explain PromQL'),
      description: i18n.t(
        'Describe a metric question or ask what an existing query does. Open a suggested query in the PromQL tab to inspect and run it.',
      ),
      entry: i18n.t('PromQL tab → Ask assistant or Explain query'),
      example: i18n.t('Show the CPU usage rate for each Pod over the last five minutes.'),
    },
    {
      id: 'logql',
      icon: Search,
      title: i18n.t('Find the right logs with LogQL'),
      description: i18n.t(
        'Turn a log search into a Loki query, or explain filters and parsers in an existing query. Open suggestions in the Loki tab.',
      ),
      entry: i18n.t('Loki tab → Ask assistant or Explain query'),
      example: i18n.t('Find error logs for the checkout namespace in the last hour.'),
    },
    {
      id: 'yaml',
      icon: FileCode2,
      title: i18n.t('Draft and improve Kubernetes YAML'),
      description: i18n.t(
        'Generate a manifest, complete a draft, or ask for help with validation issues using the cluster schema. Review suggestions before inserting them into the editor.',
      ),
      entry: i18n.t('New manifest editor → Generate, Complete YAML or Validate YAML'),
      example: i18n.t(
        'Create a Deployment with two replicas, resource limits and a readiness probe.',
      ),
    },
  ];
}
