import { describe, expect, it } from 'vitest';
import { formatDataPreview } from './dataFormat';

describe('formatDataPreview', () => {
  it('indents nested objects and arrays while keeping empty containers compact', () => {
    expect(
      formatDataPreview(
        'json',
        ' \n{"auths":{"registry.test":{"auth":"token"}},"items":[1,{"ok":true},[],{}],"empty":null}\t',
      ),
    ).toBe(`{
  "auths": {
    "registry.test": {
      "auth": "token"
    }
  },
  "items": [
    1,
    {
      "ok": true
    },
    [],
    {}
  ],
  "empty": null
}`);
  });

  it('preserves large numbers, exponents, negative zero, duplicate keys and key order', () => {
    const input =
      '{"id":9007199254740993,"id":9007199254740995,"2":1.2300e+040,"1":-0,"overflow":1e400}';
    expect(formatDataPreview('json', input)).toBe(`{
  "id": 9007199254740993,
  "id": 9007199254740995,
  "2": 1.2300e+040,
  "1": -0,
  "overflow": 1e400
}`);
  });

  it('preserves escaped strings and all whitespace and structural punctuation inside strings', () => {
    const value = String.raw`"  { [ : , ] } \"quote\" \\ \n \t \u0061 \/ Türkçe  "`;
    expect(formatDataPreview('json', `{"value":${value}}`)).toBe(`{\n  "value": ${value}\n}`);
  });

  it.each(['{}', '[]', 'true', 'null', '9007199254740993', '"text"'])(
    'supports a valid root value: %s',
    (input) => {
      expect(formatDataPreview('json', ` \t${input}\r\n`)).toBe(input);
    },
  );

  it.each([
    '',
    ' \n\t',
    '{"key": 1,}',
    '{key: 1}',
    '[1, 2',
    '{"key":"unterminated}',
    '{"key":01}',
    '{"key":NaN}',
  ])('leaves invalid JSON unchanged: %s', (input) => {
    expect(formatDataPreview('json', input)).toBe(input);
  });

  it.each(['text', 'yaml', 'pem', 'javascript'] as const)(
    'leaves %s data unchanged even when it contains valid JSON',
    (format) => {
      const input = ' \n{"key": [1, 2]}\t';
      expect(formatDataPreview(format, input)).toBe(input);
    },
  );

  it('does not accumulate whitespace when formatting an existing preview', () => {
    const preview = formatDataPreview('json', '{"items":[{"enabled":false}]}');
    expect(formatDataPreview('json', preview)).toBe(preview);
  });
});
