import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const actionIds = new Set(
  JSON.parse(
    readFileSync(new URL('../../shared/changelog/action-ids.json', import.meta.url), 'utf8'),
  ),
);

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** Parse the documented bilingual format, never infer package publication from a heading. */
export function parseChangelog(markdown) {
  const sections = markdown
    .replace(/\r\n/g, '\n')
    .split(/(?=^## )/m)
    .filter((section) => section.startsWith('## '));
  const seen = new Set();
  const entries = sections.map((section) => {
    const [heading] = section.split('\n', 1);
    const match = /^## (?:\[([^\]]+)\]|([^\s]+))(?: - (\d{4}-\d{2}-\d{2}))? — (.+) \/ (.+)$/.exec(
      heading,
    );
    assert(match, `Invalid changelog heading: ${heading}`);
    const version = match[1] ?? match[2];
    const unreleased = version === 'Unreleased';
    assert(unreleased || versionPattern.test(version), `Invalid version: ${version}`);
    const id = unreleased ? 'unreleased' : version;
    assert(!seen.has(id), `Duplicate changelog version: ${version}`);
    seen.add(id);
    const date = match[3] ?? null;
    const title = { en: match[4].trim(), tr: match[5].trim() };
    assert(title.en && title.tr, `${version}: both localized titles are required`);
    assert(!unreleased || !date, 'Unreleased must not have a release date');
    if (date) {
      const parsed = new Date(`${date}T00:00:00Z`);
      assert(
        Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date,
        `Invalid release date: ${date}`,
      );
    }

    const languages = [...section.matchAll(/^### (English|Türkçe)\s*$/gm)];
    assert(
      languages.length === 2 && languages[0][1] === 'English' && languages[1][1] === 'Türkçe',
      `${version} requires English and Türkçe sections, in that order`,
    );
    const preface = section.slice(heading.length, languages[0].index).trim();
    const actionLine = /^<!-- kubepit-actions: ([a-z,-]+) -->$/.exec(preface);
    assert(!preface || actionLine, `${version}: move shared copy into each language section`);
    const actions = actionLine ? actionLine[1].split(',') : [];
    assert(
      new Set(actions).size === actions.length && actions.every((action) => actionIds.has(action)),
      `${version}: unknown or duplicate changelog action`,
    );
    if (!unreleased)
      assert(
        Buffer.byteLength(section.slice(heading.length).trim()) <= 64 * 1024,
        `${version}: combined release notes exceed the signed updater's 64 KiB limit`,
      );
    const body = {
      en: section.slice(languages[0].index + languages[0][0].length, languages[1].index).trim(),
      tr: section.slice(languages[1].index + languages[1][0].length).trim(),
    };
    for (const [locale, text] of Object.entries(body)) {
      assert(
        text.length > 0 && Buffer.byteLength(text) <= 64 * 1024,
        `${version}: ${locale} notes are missing or too large`,
      );
      assert(!/^### /m.test(text), `${version}: use #### for category headings`);
    }
    return {
      id,
      version: unreleased ? null : version,
      status: unreleased ? 'unreleased' : 'versioned',
      date,
      title,
      body,
      actions,
    };
  });
  assert(entries.length > 0, 'Changelog has no entries');
  assert(entries[0].status === 'unreleased', 'Keep exactly one Unreleased entry at the top');
  // Version ordering is editorial: do not equate an entry's order with download availability.
  return { schemaVersion: 1, entries };
}

export function generateChangelog(markdown) {
  return `${JSON.stringify(parseChangelog(markdown), null, 2)}\n`;
}
