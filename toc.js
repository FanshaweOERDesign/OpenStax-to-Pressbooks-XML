import { JSDOM } from 'jsdom';

export function parseTableOfContents({ html, title, url }) {
  const dom = new JSDOM(html, { url });
  try {
    const parts = [];
    let currentPart;
    let nextId = 100;
    for (const row of dom.window.document.querySelectorAll('[role="row"][data-type]')) {
      if (row.getAttribute('aria-expanded') === 'false') {
        throw new Error('TOC contains unexpanded groups; cannot export this book.');
      }
      if (row.getAttribute('data-type') === 'chapter' ||
          (row.getAttribute('aria-level') === '1' && row.hasAttribute('aria-expanded'))) {
        currentPart = {
          id: nextId++, number: row.querySelector('.os-number')?.textContent.trim() || '',
          title: row.querySelector('.os-text')?.textContent.trim() || row.getAttribute('aria-label') || row.textContent.trim(),
          slug: `part-${parts.length + 1}`, order: parts.length, subsections: [],
        };
        parts.push(currentPart);
      } else {
        const link = row.querySelector('a.toc-content-link[href]');
        if (!link) continue;
        // Standalone pages (preface, appendices) must not join the previous chapter.
        if (row.getAttribute('aria-level') === '1' || !currentPart) {
          currentPart = {
            id: nextId++, number: '', title: link.textContent.trim(),
            slug: `part-${parts.length + 1}`, order: parts.length, subsections: [],
          };
          parts.push(currentPart);
        }
        currentPart.subsections.push({
          id: nextId++, title: link.textContent.trim(), url: link.href,
          slug: new URL(link.href).pathname.split('/').filter(Boolean).pop(),
          order: currentPart.subsections.length,
        });
      }
    }
    if (!parts.length || parts.some(part => !part.subsections.length)) {
      throw new Error('TOC is empty or contains unexpanded chapters; cannot export this book.');
    }
    const slug = new URL(url).pathname.match(/\/books\/([^/]+)/)?.[1];
    if (!title || !slug) throw new Error('Missing OpenStax book title or slug.');
    return { parts, title, slug };
  } finally {
    dom.window.close();
  }
}
