import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTableOfContents } from './toc.js';

const metadata = { title: 'Sample Book', url: 'https://openstax.org/books/sample/pages/1-introduction' };
const chapter = '<div role="row" data-type="chapter" aria-level="1"><span class="os-number">1</span><span class="os-text">First chapter</span></div>';
const page = (title, href, level = 2) => `<div role="row" data-type="page" aria-level="${level}"><a class="toc-content-link" href="${href}">${title}</a></div>`;

test('parses tree rows, resolves relative links, and preserves standalone pages', () => {
  const book = parseTableOfContents({ ...metadata, html:
    page('Preface', 'preface', 1) + chapter + page('Introduction', '1-introduction') +
    page('Section', '1-1-section') + page('Appendix', 'a-appendix', 1),
  });
  assert.equal(book.slug, 'sample');
  assert.deepEqual(book.parts.map(p => p.title), ['Preface', 'First chapter', 'Appendix']);
  assert.equal(book.parts[1].subsections.length, 2);
  assert.equal(book.parts[1].subsections[1].url, 'https://openstax.org/books/sample/pages/1-1-section');
  const ids = book.parts.flatMap(p => [p.id, ...p.subsections.map(s => s.id)]);
  assert.equal(new Set(ids).size, ids.length);
});

test('rejects empty and unexpanded TOCs', () => {
  for (const html of ['', chapter, chapter + page('Appendix', 'a-appendix', 1)]) {
    assert.throws(() => parseTableOfContents({ ...metadata, html }), /TOC is empty|unexpanded/);
  }
});

test('keeps nested review links in their chapter and answer keys in a separate part', () => {
  const group = (type, title, level) => `<div role="row" data-type="${type}" aria-level="${level}" aria-expanded="true">${title}</div>`;
  const book = parseTableOfContents({ ...metadata, html: chapter + page('Section', '1-1-section') +
    group('eoc-dropdown', 'Exercises', 2) + page('Practice Test', '1-practice-test', 3) +
    page('Appendix', 'a-appendix', 1) + group('eob-dropdown', 'Answer Key', 1) + page('Chapter 1', 'chapter-1'),
  });
  assert.deepEqual(book.parts.map(p => p.title), ['First chapter', 'Appendix', 'Answer Key']);
  assert.deepEqual(book.parts[0].subsections.map(p => p.title), ['Section', 'Practice Test']);
  assert.equal(book.parts[2].subsections[0].title, 'Chapter 1');
  assert.throws(() => parseTableOfContents({ ...metadata, html: chapter + page('Section', '1-1-section') +
    '<div role="row" data-type="eoc-dropdown" aria-expanded="false"></div>',
  }), /unexpanded groups/);
});
