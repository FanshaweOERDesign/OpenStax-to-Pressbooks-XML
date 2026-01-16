import express from 'express';
import { JSDOM } from 'jsdom';
import { create } from 'xmlbuilder2';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import fs from 'fs';
import pLimit from 'p-limit';
import { text } from 'stream/consumers';
import he from 'he';
import css from 'css';
import { MathMLToLaTeX } from 'mathml-to-latex';
import puppeteer from 'puppeteer';

const app = express();
const PORT = 3000;

// setup static pages in public folder
app.use(express.static('public'));

const cssText = readFileSync(resolve('./default.css'), 'utf-8');
const usedClasses = new Set();
const usedIds = new Set();

// Parse CSS selectors
const ast = css.parse(cssText);
for (const rule of ast.stylesheet.rules) {
    if (rule.type === 'rule') {
        for (const selector of rule.selectors) {
            const matches = selector.match(/([.#])([\w-]+)/g);
            if (matches) {
                matches.forEach((m) => {
                    if (m.startsWith('.')) usedClasses.add(m.slice(1));
                    if (m.startsWith('#')) usedIds.add(m.slice(1));
                });
            }
        }
    }
}

const MAX_CONCURRENT_SCRAPES = 2;

// Used to limit the number of concurrent scrape requests sent to the /scrape-openstax endpoint
const scrapeLimit = pLimit(MAX_CONCURRENT_SCRAPES);

// (global subsection limiter): limits how many chapter/subsection fetch+parse tasks run at once across all scrapes
const fetchLimit = pLimit(5);

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) await browser.close().catch(() => {});
  }
}

process.on("SIGINT", async () => { await closeBrowser(); process.exit(0); });
process.on("SIGTERM", async () => { await closeBrowser(); process.exit(0); });


async function getTableOfContents(pageUrl) {

  const browser = await getBrowser();
  const page = await browser.newPage();

  
  try {
    page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

    // Wait for the button and click it
    await page.waitForSelector(".show-toc", { visible: true, timeout: 60000 });
    await page.click(".show-toc");

    // Optionally wait for content to appear
    await page.waitForSelector(".table-of-contents", { visible: true, timeout: 60000 });

    // Grab the HTML
    return await page.$eval(".table-of-contents", (el) => el.outerHTML);
    
  } finally {
    // Close page first (most important for RAM), then browser
    if (page) await page.close().catch(() => {});
    // await browser.close().catch(() => {});
  }
}

const buildPressbooksXML = (book) => {
    const channelItems = [];

    const taxonomy = {
        'wp:term': {
            'wp:term_id': 1,
            'wp:term_taxonomy': 'chapter-type',
            'wp:term_slug': 'standard',
            'wp:term_name': 'Standard'
        }
    };

    book.forEach(part => {
        console.log(`Processing part: ${part.title}`);
        // Part
        channelItems.push({
            item: {
                title: { '#cdata': part.title },
                link: `https://example.pressbooks.pub/${book.slug}/part/${part.slug}/`,
                pubDate: new Date().toUTCString(),
                'dc:creator': 'admin',
                guid: {
                    '@isPermaLink': 'false',
                    '#': `https://example.pressbooks.pub/${book.slug}/?p=${part.id}`
                },
                description: '',
                'content:encoded': { '#cdata': '' },
                'excerpt:encoded': { '#cdata': '' },
                'wp:post_id': part.id,
                'wp:post_date': '2025-06-30 00:00:00',
                'wp:post_date_gmt': '2025-06-30 00:00:00',
                'wp:post_name': part.slug,
                'wp:status': 'publish',
                'wp:post_parent': 0,
                'wp:menu_order': part.order,
                'wp:post_type': 'part',
                'wp:is_sticky': 0
            }
        });

        // Chapters in part
        part.subsections.forEach(chapter => {
            console.log(`Processing chapter: ${chapter.title}`);
            channelItems.push({
                item: {
                    title: { '#cdata': chapter.title },
                    link: `https://example.pressbooks.pub/${book.slug}/chapter/${chapter.slug}/`,
                    pubDate: new Date().toUTCString(),
                    'dc:creator': 'admin',
                    guid: {
                        '@isPermaLink': 'false',
                        '#': `https://example.pressbooks.pub/${book.slug}/?p=${chapter.id}`
                    },
                    description: '',
                    'content:encoded': { '#cdata': he.decode(chapter.content) },
                    'excerpt:encoded': { '#cdata': '' },
                    'wp:post_id': chapter.id,
                    'wp:post_date': '2025-06-30 00:00:00',
                    'wp:post_date_gmt': '2025-06-30 00:00:00',
                    'wp:post_name': chapter.slug,
                    'wp:status': 'web-only',
                    'wp:post_parent': part.id,
                    'wp:menu_order': chapter.order,
                    'wp:post_type': 'chapter',
                    'wp:is_sticky': 0,
                    category: {
                        '@domain': 'chapter-type',
                        '@nicename': 'standard',
                        '#': 'Standard'
                    }
                }
            });
        });
    });

    const xmlObj = {
        rss: {
            '@version': '2.0',
            '@xmlns:excerpt': 'http://wordpress.org/export/1.2/excerpt/',
            '@xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
            '@xmlns:dc': 'http://purl.org/dc/elements/1.1/',
            '@xmlns:wp': 'http://wordpress.org/export/1.2/',
            channel: {
                title: book.title,
                link: `https://example.pressbooks.pub/${book.slug}`,
                description: `Imported version of ${book.title}`,
                language: 'en-US',
                'wp:wxr_version': '1.2',
                'wp:base_site_url': 'https://example.pressbooks.pub/',
                'wp:base_blog_url': `https://example.pressbooks.pub/${book.slug}`,
                ...taxonomy,
                item: channelItems.map(i => i.item)
            }
        }
    };

    const doc = create(xmlObj);
    return doc.end({ prettyPrint: true });
};

async function scrapeOpenStax(pageUrl) {

    function nextSiblingWithClass(el, className) {
        let sibling = el.nextElementSibling;
        while (sibling) {
            if (sibling.classList.contains(className)) {
                return sibling;
            }
            sibling = sibling.nextElementSibling;
        }
        return null; // Not found
    }
    // Scrape the OpenStax Table of Contents
    const tableOfContentsRaw = await getTableOfContents(pageUrl);

    const parser = new JSDOM(tableOfContentsRaw);
    let currPartId = 100;
    const chapters = Array.from(parser.window.document.querySelectorAll('.table-of-contents > .os-number')).map(el => {
        const number = el.textContent.trim();
        const id = currPartId;
        const partSlug = number.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        const partOrder = currPartId - 100;
        let currChapterId = currPartId + 1;
        let currChapterOrder = 0;

        const title = nextSiblingWithClass(el, 'os-text')?.textContent.trim();
        const subsections = Array.from(nextSiblingWithClass(el, 'no-bullets').querySelectorAll('li')).map(subEl => {
            const id = currChapterId++;
            const subTitle = subEl.textContent.trim();
            const url = subEl.querySelector('a')?.href || '';
            const slug = url.split('/').pop().replace(/[^a-z0-9]+/gi, '-').toLowerCase();
            const order = currChapterOrder++;
            return { title: subTitle, url, id, slug, order };

        });
        currPartId += 100;
        return { id, number, title, subsections, slug: partSlug, order: partOrder };
    });

    // Scrape the OpenStax HTML content for each subsection
    const fetchWithTimeout = async (url, timeoutMs = 2000) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            return response;
        } catch (error) {
            clearTimeout(timeout);
            throw error;
        }
    };

    const chaptersWithHtml = await Promise.all(
        chapters.map(async (chapter) => {
            const subsectionPromises = chapter.subsections.map((subsection) =>
                fetchLimit(async () => {
                    try {
                        const response = await fetchWithTimeout(subsection.url, 10000);
                        if (!response.ok) {
                            throw new Error(`Failed to fetch ${subsection.url}`);
                        }

                        const html = await response.text();
                        const dom = new JSDOM(html);

                        const figures = dom.window.document.querySelectorAll('.os-figure');
                        figures.forEach((figure) => {
                            const img = figure.querySelector('img');
                            if (img) {
                                const dataSrc = img.getAttribute('data-lazy-src') || img.getAttribute('src');
                                if (dataSrc && !dataSrc.startsWith('http')) {
                                    img.setAttribute('src', `https://openstax.org${dataSrc}`);
                                }
                            }
                            figure.classList.add('wp-caption', 'aligncenter');

                            const caption = figure.querySelector('.os-caption-container');
                            if (caption) {

                                const figcaption = dom.window.document.createElement('figcaption');
                                figcaption.classList.add('wp-caption-text');
                                figcaption.innerHTML = caption.innerHTML.replaceAll(/\n/g, '').trim();
                                figure.appendChild(figcaption);
                                figure.removeChild(caption);
                            }
                        });

                        const learningObjectives = dom.window.document.querySelector('.learning-objectives');
                        if (learningObjectives) {
                            learningObjectives.classList.add('textbox', 'textbox--learning-objectives');
                            const header = learningObjectives.querySelector('h2');
                            if (header) {
                                // Remove the original header and create a new structured header
                                learningObjectives.removeChild(header);
                            }
                            const headerElement = dom.window.document.createElement('header');
                            headerElement.innerHTML = '<h2 class="textbox__title">Learning Objectives</h2>';
                            headerElement.classList.add('textbox__header');

                            const textboxContent = dom.window.document.createElement('div');
                            textboxContent.classList.add('textbox__content');
                            textboxContent.innerHTML = learningObjectives.innerHTML;
                            learningObjectives.innerHTML = '';
                            learningObjectives.appendChild(headerElement);
                            learningObjectives.appendChild(textboxContent);
                        }

                        const checkYourUnderstanding = dom.window.document.querySelectorAll('[data-element-type="check-understanding"]');

                        checkYourUnderstanding.forEach((el) => {
                            // similar to learning objectives, add classes and structure
                            el.classList.add('textbox', 'textbox--exercises');
                            const header = el.querySelector('header');
                            if (header) {
                                el.removeChild(header);
                            }
                            const headerElement = dom.window.document.createElement('header');
                            headerElement.innerHTML = '<h2 class="textbox__title">Check Your Understanding</h2>';
                            headerElement.classList.add('textbox__header');
                            const details = el.querySelector('details');
                            if (details) {
                                const summary = details.querySelector('summary');
                                if (summary) {
                                    summary.innerHTML = 'Click for Solution';
                                } else {
                                    const summaryElement = dom.window.document.createElement('summary');
                                    summaryElement.innerHTML = 'Click for Solution';
                                    details.insertBefore(summaryElement, details.firstChild);
                                }
                            }
                            const textboxContent = dom.window.document.createElement('div');
                            textboxContent.classList.add('textbox__content');
                            textboxContent.innerHTML = el.innerHTML;
                            el.innerHTML = '';
                            el.appendChild(headerElement);
                            el.appendChild(textboxContent);
                        });

                        const notes = dom.window.document.querySelectorAll('[data-type="note"]');
                        notes.forEach((note) => {
                            note.classList.add('textbox', 'textbox--examples');
                            const header = note.querySelector('header');
                            if (header) {
                                note.removeChild(header);
                            }
                            const headerElement = dom.window.document.createElement('header');
                            headerElement.innerHTML = `<h2 class="textbox__title">${header.textContent}</h2>`;
                            headerElement.classList.add('textbox__header');

                            const textboxContent = dom.window.document.createElement('div');
                            textboxContent.classList.add('textbox__content');
                            textboxContent.innerHTML = note.innerHTML;
                            note.innerHTML = '';
                            note.appendChild(headerElement);
                            note.appendChild(textboxContent);
                        });

                        const mainContent = dom.window.document.querySelector('main.page-content');

                        // Create attribution
                        const attrHr = dom.window.document.createElement('hr');
                        mainContent.appendChild(attrHr);
                        const originalPageURL = dom.window.document.createElement('a');
                        originalPageURL.href = subsection.url;
                        originalPageURL.textContent = subsection.title;
                        const originalBookURL = dom.window.document.createElement('a');
                        originalBookURL.href = 'https://openstax.org/books/college-physics-2e/';
                        originalBookURL.textContent = 'College Physics 2e';
                        const attributionDiv = dom.window.document.createElement('div');
                        const licenseLink = dom.window.document.createElement('a');
                        licenseLink.href = 'https://creativecommons.org/licenses/by/4.0/';
                        licenseLink.textContent = 'Creative Commons Attribution 4.0 International License';
                        attributionDiv.innerHTML = '"' + originalPageURL.outerHTML + '" from ' + originalBookURL.outerHTML + ' by OpenStax is licensed under a ' + licenseLink.outerHTML + '.';
                        mainContent.appendChild(attributionDiv);

                        [...mainContent.querySelectorAll('*')].forEach((el) => {
                            el.removeAttribute('tabindex');

                            // Remove data-* attributes
                            for (const attr of [...el.attributes]) {
                                if (attr.name.startsWith('data-')) {
                                    el.removeAttribute(attr.name);
                                }
                            }

                            // Clean class
                            if (el.hasAttribute('class')) {
                                const filtered = el.className
                                    .split(/\s+/)
                                    .filter((cls) => usedClasses.has(cls));

                                if (filtered.length) {
                                    el.className = filtered.join(' ');
                                } else {
                                    el.removeAttribute('class');
                                }
                            }

                            // Clean id
                            if (el.hasAttribute('id') && !usedIds.has(el.id)) {
                                el.removeAttribute('id');
                            }
                        });

                        const mathElements = mainContent.querySelectorAll('math');

                        mathElements.forEach(mathEl => {

                            const mathClone = mathEl.cloneNode(true);

                            // Remove annotation-xml nodes to prevent duplication
                            mathClone.querySelectorAll('annotation-xml').forEach(node => node.remove());

                            const latex = MathMLToLaTeX.convert(he.decode(mathClone.outerHTML));

                            const wrapper = dom.window.document.createElement('span');
                            wrapper.textContent = `[latex]${latex}[/latex]`;
                            mathEl.replaceWith(wrapper);
                        });

                        // Serialize the modified main content back to HTML
                        const serializer = new dom.window.XMLSerializer();
                        const html2 = serializer.serializeToString(mainContent).replace(/^\s*(&nbsp;|\s)+|(&nbsp;|\s)+\s*$/g, '');

                        return { ...subsection, content: html2 };
                    } catch (error) {
                        console.error(`Error fetching ${subsection.url}:`, error);
                        return { ...subsection, content: '' };
                    }
                })
            );

            chapter.subsections = await Promise.all(subsectionPromises);
            return chapter;
        })
    );

    const xml = buildPressbooksXML(chaptersWithHtml);

    return xml;
}

app.get('/scrape-openstax', async (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl) {
        return res.status(400).send('Missing url query parameter');
    }

    // Limit Number of Scrapes that run at once.
    if(scrapeLimit.activeCount >= MAX_CONCURRENT_SCRAPES) {
        return res.status(429).json({
            queued: true,
            message: 'The server is currently busy processing a few other OpenStax books. Please retry in ~30 seconds.',
            retryAfterSeconds: 30
        });
    }
    
    try {
        
        const xml = await scrapeLimit(() => scrapeOpenStax(pageUrl));
        res.json({ xml });

    } catch (error) {
        console.error('Error scraping OpenStax:', error);
        res.status(500).send('Error scraping OpenStax');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
