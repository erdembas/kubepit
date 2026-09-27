import type { PodFsEntry } from '@/types';

/**
 * Pure helpers of the container file browser: POSIX path arithmetic (the
 * container's paths, never the local OS's), preview language / kind by
 * extension and navigation targets.
 */

/** Collapse `//`, `.` and `..`; always absolute. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  return normalizePath(`${path}/..`);
}

/** Resolve what the user typed in the path bar against the current directory. */
export function resolveInput(input: string, cwd: string): string {
  const text = input.trim();
  if (!text) return cwd;
  return normalizePath(text.startsWith('/') ? text : joinPath(cwd, text));
}

/** Breadcrumb segments: `/var/log` → [['/', '/'], ['var', '/var'], ['log', '/var/log']]. */
export function pathSegments(path: string): Array<{ name: string; path: string }> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  const segments = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    segments.push({ name: part, path: acc });
  }
  return segments;
}

export function isDirLike(entry: PodFsEntry): boolean {
  return entry.kind === 'dir' || entry.link_to_dir;
}

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const LANGUAGES: Record<string, string> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  xml: 'xml',
  svg: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  md: 'markdown',
  sql: 'sql',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  toml: 'ini',
  properties: 'ini',
  dockerfile: 'dockerfile',
  lua: 'lua',
};

/** Monaco language for a file name ('plaintext' when unknown). */
export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'nginx.conf' || lower.endsWith('.nginx')) return 'ini';
  return LANGUAGES[extension(name)] ?? 'plaintext';
}

const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/** MIME type of previewable raster images. */
export function imageMime(name: string): string | null {
  return IMAGES[extension(name)] ?? null;
}

const ARCHIVES = new Set(['tar', 'gz', 'tgz', 'zip', 'bz2', 'xz', 'zst', '7z', 'jar', 'war']);
const CODE = new Set(Object.keys(LANGUAGES));

export type FileVisual =
  'dir' | 'dir-link' | 'link' | 'image' | 'archive' | 'code' | 'text' | 'other';

export function fileVisual(entry: PodFsEntry): FileVisual {
  if (entry.kind === 'dir') return 'dir';
  if (entry.kind === 'symlink') return entry.link_to_dir ? 'dir-link' : 'link';
  if (entry.kind === 'other') return 'other';
  const ext = extension(entry.name);
  if (imageMime(entry.name)) return 'image';
  if (ARCHIVES.has(ext)) return 'archive';
  if (CODE.has(ext)) return 'code';
  return 'text';
}

/** Decode base64 file content for a browser download. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
