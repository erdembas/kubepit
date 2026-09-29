export interface SearchableOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  group?: string;
  groupId?: string;
  color?: string;
  keywords?: string;
  disabled?: boolean;
}

export function filterSelectOptions<T extends SearchableOption>(options: T[], query: string): T[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    const text =
      `${option.label} ${option.description ?? ''} ${option.group ?? ''} ${option.keywords ?? ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Real matches retain keyboard priority; a custom value is an explicit final choice. */
export function searchableSelectOptions(
  options: SearchableOption[],
  query: string,
  createOption?: (query: string) => SearchableOption | null,
): SearchableOption[] {
  const matches = filterSelectOptions(options, query);
  if (!createOption) return matches;
  // A model's actual name/ID wins over a reference in another row's metadata
  // (for example the automatic choice displaying that model as its default).
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const direct = (option: SearchableOption) => {
    const text = `${option.value} ${option.label}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  };
  matches.sort((a, b) => Number(direct(b)) - Number(direct(a)));
  const exact = matches.findIndex((option) => option.value === query.trim());
  if (exact > 0) matches.unshift(...matches.splice(exact, 1));
  const custom = createOption(query);
  if (custom && !options.some((option) => option.value === custom.value)) matches.push(custom);
  return matches;
}
