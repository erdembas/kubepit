import * as i18n from '@/i18n/core';

/**
 * Client-side check of a per-cluster proxy URL, mirroring
 * `kubepit-core/src/proxy.rs` (the backend validates again on save).
 * Returns a translated problem, or null when the value is fine or empty.
 */
export function proxyUrlProblem(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/\s/.test(url)) return i18n.t('A proxy URL cannot contain spaces.');
  const match = url.match(/^([A-Za-z0-9+.-]+):\/\/(.*)$/);
  if (!match) return i18n.t('Start with http://, https://, socks5:// or socks5h://.');
  const scheme = match[1]!.toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(scheme))
    return i18n.t('Unsupported scheme {scheme}: use http, https, socks5 or socks5h.', {
      scheme: match[1]!,
    });
  const rest = match[2]!;
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? '' : rest.slice(end);
  if (tail && tail !== '/') return i18n.t('A proxy URL has no path, query or fragment.');
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  let host = hostPort;
  let port: string | null = null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) return i18n.t('The proxy host is not valid.');
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after) {
      if (!after.startsWith(':')) return i18n.t('The proxy host is not valid.');
      port = after.slice(1);
    }
  } else if (hostPort.includes(':')) {
    host = hostPort.slice(0, hostPort.lastIndexOf(':'));
    port = hostPort.slice(hostPort.lastIndexOf(':') + 1);
  }
  if (!host) return i18n.t('The proxy URL needs a host.');
  if (port !== null) {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) return i18n.t('The proxy port is not valid.');
  }
  return null;
}
