import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractSuggestions } from './answer';

const fixtures = new URL('../../../../../crates/kubepit-core/tests/fixtures/ai/', import.meta.url);
interface Case {
  name: string;
  scripted_reply: string;
  expect_suggestions: Record<string, number>;
  secrets: string[];
}
const cases = readdirSync(fileURLToPath(fixtures))
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as Case);

describe('shared diagnosis eval fixtures', () => {
  it('covers seven diagnoses', () => {
    expect(cases).toHaveLength(7);
  });
  it.each(cases)('extracts the expected suggestions for $name', (case_) => {
    const suggestions = extractSuggestions(case_.scripted_reply);
    const counts: Record<string, number> = { manifest: 0, kubectl: 0, promql: 0, logql: 0 };
    for (const suggestion of suggestions)
      counts[suggestion.kind] = (counts[suggestion.kind] ?? 0) + 1;
    expect(counts).toEqual(case_.expect_suggestions);
    for (const secret of case_.secrets) expect(case_.scripted_reply).not.toContain(secret);
    for (const suggestion of suggestions)
      if (suggestion.kind === 'manifest' || suggestion.kind === 'kubectl')
        expect(suggestion.blocked).toBeNull();
  });
});
