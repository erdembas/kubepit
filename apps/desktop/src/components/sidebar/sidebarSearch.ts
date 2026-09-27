import type { ClusterDef, Section } from '@/types';

export function matchesWorkspaceSearch(query: string, ...parts: string[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = parts.join(' ').toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Everything a user might type to find a cluster: name, context, tags, env, section, notes. */
export function clusterSearchText(
  cluster: ClusterDef,
  sections: Section[],
  assigned?: string,
  server?: string | null,
): string {
  return [
    cluster.name,
    cluster.context,
    cluster.environment ?? '',
    ...cluster.tags.map((tag) => `#${tag} ${tag}`),
    cluster.default_namespace ?? '',
    cluster.notes,
    server ?? '',
    sections.find((section) => section.id === assigned)?.name ?? '',
  ].join(' ');
}
