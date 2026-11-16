import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { assertSafeOpenStaxUrl, isOpenStaxUrl, sanitizeElement } from './security.js';

const publicResolver = async () => [{ address: '8.8.8.8', family: 4 }];

test('allows HTTPS OpenStax domains and rejects non-OpenStax destinations', async () => {
  assert.equal(isOpenStaxUrl('https://openstax.org/books/sample'), true);
  assert.equal(isOpenStaxUrl('https://assets.openstax.org/book.js'), true);
  assert.equal(isOpenStaxUrl('https://fonts.googleapis.com/css'), false);
  assert.equal(
    await assertSafeOpenStaxUrl('https://openstax.org/books/sample', publicResolver),
    'https://openstax.org/books/sample'
  );
  await assertSafeOpenStaxUrl('https://assets.openstax.org/book.js', publicResolver);
  await assert.rejects(
    assertSafeOpenStaxUrl('https://openstax.org.evil.example/', publicResolver),
    /Only HTTPS URLs on OpenStax domains/
  );
  await assert.rejects(
    assertSafeOpenStaxUrl('http://openstax.org/', publicResolver),
    /Only HTTPS URLs on OpenStax domains/
  );
});

test('rejects private, loopback, and link-local DNS results', async () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(
      assertSafeOpenStaxUrl('https://openstax.org/', async () => [{ address }]),
      /non-public IP/
    );
  }
});

test('removes active HTML and unsafe attributes while preserving safe content', () => {
  const dom = new JSDOM(
    '<main><p onclick="alert(1)">Text</p><p>&lt;script&gt;alert(2)&lt;/script&gt;</p>' +
    '<script>alert(3)</script><img src="https://images.example.com/x.png" onerror="alert(4)">' +
    '<a href="javascript:alert(5)">link</a>' +
    '<strong>kept</strong></main>',
    { url: 'https://openstax.org/books/sample/pages/1' }
  );
  const content = sanitizeElement(dom.window.document.querySelector('main'), 'https://openstax.org/books/sample/pages/1');
  assert.equal(content.querySelector('script'), null);
  assert.equal(content.querySelector('p').hasAttribute('onclick'), false);
  assert.equal(content.querySelector('img').hasAttribute('onerror'), false);
  assert.equal(content.querySelector('img').getAttribute('src'), 'https://images.example.com/x.png');
  assert.equal(content.querySelector('a').hasAttribute('href'), false);
  assert.equal(content.querySelector('strong').textContent, 'kept');
  const exportedDom = new JSDOM(`<body>${content.outerHTML}</body>`);
  assert.equal(exportedDom.window.document.querySelector('script'), null);
  assert.equal(exportedDom.window.document.querySelectorAll('p')[1].textContent, '<script>alert(2)</script>');
  exportedDom.window.close();
  dom.window.close();
});
