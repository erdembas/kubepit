import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateChangelog, parseChangelog } from './model.mjs';
import { releaseNotesFromChangelog } from '../release/updater.mjs';

const source = `# Changelog

## [Unreleased] — Next changes / Sonraki değişiklikler

### English

#### Added

- Smart filters.

### Türkçe

#### Eklenenler

- Akıllı filtreler.

## [0.0.4] - 2026-10-01 — Search / Arama

### English

Versioned notes.

### Türkçe

Sürüm notları.
`;

test('bilingual entries preserve Markdown and separate development from version notes', () => {
  const { entries } = parseChangelog(source);
  assert.deepEqual(
    entries.map(({ id, version, status, date }) => ({ id, version, status, date })),
    [
      { id: 'unreleased', version: null, status: 'unreleased', date: null },
      { id: '0.0.4', version: '0.0.4', status: 'versioned', date: '2026-10-01' },
    ],
  );
  assert.equal(entries[0].body.en, '#### Added\n\n- Smart filters.');
  assert.equal(entries[0].body.tr, '#### Eklenenler\n\n- Akıllı filtreler.');
  assert.equal(entries[1].title.tr, 'Arama');
  assert.equal(generateChangelog(source), generateChangelog(source.replaceAll('\n', '\r\n')));
});

test('historical unbracketed headings can keep an unknown date', () => {
  const result = parseChangelog(source.replace('[0.0.4] - 2026-10-01', '0.0.4'));
  assert.equal(result.entries[1].date, null);
});

test('incomplete locales, duplicate versions and ambiguous shared prose fail validation', () => {
  assert.throws(
    () => parseChangelog(source.replace('### Türkçe', '### Turkish')),
    /requires English/,
  );
  assert.throws(() => parseChangelog(source.replace('Sürüm notları.', '')), /notes are missing/);
  assert.throws(
    () => parseChangelog(source + source.slice(source.indexOf('## [0.0.4]'))),
    /Duplicate/,
  );
  assert.throws(
    () => parseChangelog(source.replace('### English', 'Shared prose\n\n### English')),
    /move shared copy/,
  );
  assert.throws(() => parseChangelog(source.replace('#### Added', '### Added')), /use ####/);
});

test('Unreleased stays first and undated; invalid calendar dates fail validation', () => {
  assert.throws(() => parseChangelog(source.slice(source.indexOf('## [0.0.4]'))), /Unreleased/);
  assert.throws(
    () => parseChangelog(source.replace('[Unreleased] —', '[Unreleased] - 2026-10-01 —')),
    /must not have/,
  );
  assert.throws(
    () => parseChangelog(source.replace('2026-10-01', '2026-02-30')),
    /Invalid release date/,
  );
});

test('signed updater and GitHub notes never include Unreleased changes', () => {
  const notes = releaseNotesFromChangelog(source, '0.0.4');
  assert.match(notes, /Versioned notes/);
  assert.match(notes, /Sürüm notları/);
  assert.doesNotMatch(notes, /Smart filters|Akıllı filtreler|Unreleased/);
  assert.throws(() => releaseNotesFromChangelog(source, '0.0.5'), /no 0.0.5/);
});

test('versioned bilingual notes fit the signed updater limit together', () => {
  const oversized = source
    .replace('Versioned notes.', 'a'.repeat(33_000))
    .replace('Sürüm notları.', 'b'.repeat(33_000));
  assert.throws(() => parseChangelog(oversized), /combined release notes/);
});

test('both localized titles must contain visible text', () => {
  assert.throws(
    () => parseChangelog(source.replace('Search / Arama', '    /    ')),
    /both localized titles/,
  );
});

test('feature shortcuts are shared across locales and restricted to known destinations', () => {
  const marked = source.replace(
    '### English',
    '<!-- kubepit-actions: fleet-search,connection-doctor -->\n\n### English',
  );
  const entry = parseChangelog(marked).entries[0];
  assert.deepEqual(entry.actions, ['fleet-search', 'connection-doctor']);
  assert.doesNotMatch(entry.body.en, /kubepit-actions/);
  assert.doesNotMatch(entry.body.tr, /kubepit-actions/);
  assert.throws(
    () => parseChangelog(marked.replace('fleet-search,connection-doctor', 'connect-cluster')),
    /unknown or duplicate/,
  );
  assert.throws(
    () =>
      parseChangelog(marked.replace('fleet-search,connection-doctor', 'fleet-search,fleet-search')),
    /unknown or duplicate/,
  );
});

test('versioned GitHub and updater notes omit app-only shortcut metadata', () => {
  const marked = source.replace(
    '## [0.0.4] - 2026-10-01 — Search / Arama\n',
    '## [0.0.4] - 2026-10-01 — Search / Arama\n\n<!-- kubepit-actions: fleet-search -->\n',
  );
  const notes = releaseNotesFromChangelog(marked, '0.0.4');
  assert.match(notes, /Versioned notes/);
  assert.match(notes, /Sürüm notları/);
  assert.doesNotMatch(notes, /kubepit-actions|Smart filters/);
});

test('checked-in shared bundle exactly matches the canonical changelog', async () => {
  const root = new URL('../../', import.meta.url);
  const markdown = await readFile(new URL('CHANGELOG.md', root), 'utf8');
  const bundle = await readFile(new URL('shared/changelog/generated.json', root), 'utf8');
  assert.equal(bundle, generateChangelog(markdown));
});
