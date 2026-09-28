import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangesHeader } from './ChangesHeader';

describe('ChangesHeader', () => {
  const html = renderToStaticMarkup(
    <ChangesHeader
      count={3}
      recording={<i />}
      ranges={<b />}
      search={<input />}
      refresh={<button />}
    />,
  );
  it('is a container that wraps instead of overflowing', () => {
    expect(html).toMatch(/class="[^"]*@container[^"]*"/);
    expect(html).toMatch(/class="[^"]*\bmin-h-12\b[^"]*\bflex-wrap\b[^"]*"/);
    // A fixed `h-12` class; `min-h-12` must not count (`\b` matches after `-`).
    expect(html).not.toMatch(/(?<![\w-])h-12\b/);
  });
  it('lets the search field fill the row below the @lg breakpoint', () => {
    expect(html).toMatch(/class="[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*@lg:w-56[^"]*"/);
  });
});
