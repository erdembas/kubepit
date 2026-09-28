import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditorBar } from './EditorChrome';

describe('EditorBar', () => {
  it('scrolls sideways in a fixed-height row by default', () => {
    const html = renderToStaticMarkup(<EditorBar>x</EditorBar>);
    expect(html).toMatch(/class="[^"]*(?<![\w-])h-9\b[^"]*"/);
    expect(html).toMatch(/\boverflow-x-auto\b/);
    expect(html).not.toMatch(/\bflex-wrap\b/);
  });

  it('wraps as a size container instead of overflowing with `wrap`', () => {
    const html = renderToStaticMarkup(<EditorBar wrap>x</EditorBar>);
    expect(html).toMatch(/class="[^"]*@container[^"]*"/);
    expect(html).toMatch(/\bmin-h-9\b/);
    expect(html).toMatch(/\bflex-wrap\b/);
    // Neither a fixed height nor a scroller: rows grow with their content.
    expect(html).not.toMatch(/(?<![\w-])h-9\b/);
    expect(html).not.toMatch(/\boverflow-x-auto\b/);
  });
});
