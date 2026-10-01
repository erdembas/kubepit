import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changelogBlocks,
  changelogHref,
  changelogInlines,
} from '../../apps/website/src/lib/changelogMarkdown.mjs';

test('changelog prose keeps headings, wrapped paragraphs, lists and inline formatting', () => {
  const blocks = changelogBlocks(
    '#### Added\n\nA **reviewed** change\nwith `kubectl`.\n\n- First item\n  continued safely\n- [Docs](docs/README.tr.md)\n',
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list'],
  );
  assert.deepEqual(blocks[2].items[0], [{ type: 'text', text: 'First item continued safely' }]);
  assert.equal(
    blocks[1].children.find((node) => node.type === 'strong').children[0].text,
    'reviewed',
  );
  assert.equal(blocks[1].children.find((node) => node.type === 'code').text, 'kubectl');
  assert.equal(
    blocks[2].items[1][0].href,
    'https://github.com/erdembas/kubepit/blob/main/docs/README.tr.md',
  );
});

test('changelog link handling blocks executable, credentialed and malformed destinations', () => {
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,hi',
    'vbscript:run',
    '//evil.test',
    'https://user:password@example.test',
    'https:\\evil.test',
    'https://a.test\n/',
  ]) {
    assert.equal(changelogHref(href), null, href);
  }
  assert.equal(changelogHref('https://kubernetes.io/docs/'), 'https://kubernetes.io/docs/');
  assert.equal(changelogHref('#unreleased'), '#unreleased');
  const nodes = changelogInlines('[unsafe](javascript:alert) <img src=x onerror=alert(1)>');
  assert.equal(nodes[0].type, 'span');
  assert.equal(nodes[1].type, 'text');
  assert.match(nodes[1].text, /<img/);
});

test('Markdown source HTML stays plain text and unsupported syntax stays readable', () => {
  const source = '<script>alert(1)</script>\n\n**Security note:** Keep migration warnings.';
  const blocks = changelogBlocks(source);
  assert.equal(blocks[0].children[0].text, '<script>alert(1)</script>');
  assert.equal(blocks[1].children[0].type, 'strong');
});
