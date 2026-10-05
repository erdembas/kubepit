/**
 * Cluster DNS suffixes for Service DNS names, read from the CoreDNS
 * Corefile (`kube-system/coredns` ConfigMap). Pure parsing only; fetching
 * and fallback wiring live in the components.
 */

/**
 * Cluster domains the CoreDNS `kubernetes` plugin serves, in file order.
 * A Corefile may declare several zones —
 *
 *     kubernetes cluster.local etraforsformation.cluster.local in-addr.arpa ip6.arpa {
 *
 * — and service DNS names exist under every non-reverse zone
 * (`name.namespace.svc.<domain>`). Reverse zones (`.arpa`) are skipped.
 * Returns [] when the file has no `kubernetes` plugin.
 */
export function parseCorefileClusterDomains(corefile: string): string[] {
  const domains: string[] = [];
  for (const line of corefile.split('\n')) {
    const trimmed = line.trim();
    // The plugin directive starts a line (indentation nests it in a server
    // block); `import` or commented lines never carry the zones.
    if (!/^kubernetes\b/.test(trimmed) || trimmed.startsWith('#')) continue;
    const rest = trimmed.slice('kubernetes'.length).trim();
    if (rest.startsWith('{')) {
      // Bare `kubernetes {` serves the default zone.
      domains.push('cluster.local');
      continue;
    }
    for (const token of rest.split(/\s+/)) {
      if (token === '{' || token === '') break;
      const domain = token.replace(/\.$/, '').toLowerCase();
      if (domain.endsWith('.arpa')) continue;
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  return domains;
}

/**
 * Suffixes to build Service DNS names with: every zone the cluster's
 * Corefile serves, or the standard `cluster.local` when the Corefile is
 * unreadable (missing, forbidden, no `kubernetes` plugin).
 */
export function clusterDnsSuffixes(corefile: string | null | undefined): string[] {
  const parsed = corefile ? parseCorefileClusterDomains(corefile) : [];
  return parsed.length ? parsed : ['cluster.local'];
}

/** `name.namespace.svc.<suffix>` for every suffix. */
export function serviceDnsNames(
  name: string,
  namespace: string,
  suffixes: string[],
): string[] {
  return suffixes.map((suffix) => `${name}.${namespace}.svc.${suffix}`);
}
