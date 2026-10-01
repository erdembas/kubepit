export type ChangelogInline =
  | { type: 'text' | 'code'; text: string }
  | { type: 'strong' | 'span'; children: ChangelogInline[] }
  | { type: 'link'; href: string; children: ChangelogInline[] };
export type ChangelogBlock =
  | { type: 'heading' | 'paragraph'; children: ChangelogInline[] }
  | { type: 'list'; items: ChangelogInline[][] };
export function changelogHref(raw: string): string | null;
export function changelogInlines(source: string, depth?: number): ChangelogInline[];
export function changelogBlocks(source: string): ChangelogBlock[];
