import { describe, expect, it } from 'vitest';
import { placeholdersIn, restorePlaceholders, unrestorableMarkers } from './placeholders';

describe('redaction placeholders', () => {
  it('restores IP and host placeholders and reports unknown ones', () => {
    expect(
      restorePlaceholders('host: __HOST_1__ ip: __IP_2__', { __HOST_1__: 'db.acme.internal' }),
    ).toEqual({ text: 'host: db.acme.internal ip: __IP_2__', missing: ['__IP_2__'] });
  });

  it('restores every occurrence and reports each missing one once', () => {
    expect(
      restorePlaceholders('__IP_1__ __IP_1__ __IP_3__ __IP_3__ __IP_10__', {
        __IP_1__: '10.0.0.7',
        __IP_10__: '10.0.0.9',
      }),
    ).toEqual({ text: '10.0.0.7 10.0.0.7 __IP_3__ __IP_3__ 10.0.0.9', missing: ['__IP_3__'] });
  });

  it('never restores secret or token markers', () => {
    expect(unrestorableMarkers('a: __SECRET__\nb: __TOKEN__\nc: __SECRET__')).toEqual([
      '__SECRET__',
      '__TOKEN__',
    ]);
    expect(unrestorableMarkers('host: __HOST_1__')).toEqual([]);
    expect(unrestorableMarkers('a: __SECRET_1__ b: __token__ c: __Token_12__')).toEqual([
      '__SECRET_1__',
      '__token__',
      '__Token_12__',
    ]);
    expect(restorePlaceholders('p: __SECRET__', { __SECRET__: 'hunter2' })).toEqual({
      text: 'p: __SECRET__',
      missing: [],
    });
  });

  it('lists the IP and host placeholders of a text in order', () => {
    expect(placeholdersIn('__HOST_2__ __IP_1__ __HOST_2__ __SECRET__')).toEqual([
      '__HOST_2__',
      '__IP_1__',
    ]);
  });
});
