import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

const DROP_CONTENT_TAGS = new Set([
  'applet', 'embed', 'form', 'frame', 'frameset', 'iframe', 'math', 'meta',
  'noscript', 'object', 'script', 'style', 'svg', 'template',
]);

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'article', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'i', 'img', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section',
  'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
]);

const SHARED_ATTRIBUTES = new Set([
  'class', 'dir', 'id', 'lang', 'role', 'title',
]);

const ELEMENT_ATTRIBUTES = {
  a: new Set(['href']),
  blockquote: new Set(['cite']),
  img: new Set(['alt', 'height', 'src', 'width']),
  li: new Set(['value']),
  ol: new Set(['reversed', 'start', 'type']),
  q: new Set(['cite']),
  td: new Set(['colspan', 'headers', 'rowspan']),
  th: new Set(['abbr', 'colspan', 'headers', 'rowspan', 'scope']),
  time: new Set(['datetime']),
  details: new Set(['open']),
};

function isPublicAddress(address) {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export async function assertSafeOpenStaxUrl(value, resolveHost = lookup) {
  if (typeof value !== 'string') {
    throw new Error('URL must be a string.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid URL.');
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' ||
      (host !== 'openstax.org' && !host.endsWith('.openstax.org')) ||
      (url.port && url.port !== '443') ||
      url.username || url.password) {
    throw new Error('Only HTTPS URLs on OpenStax domains are allowed.');
  }

  const addresses = await resolveHost(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('OpenStax URL resolved to a non-public IP address.');
  }

  return url.href;
}

function sanitizeUrl(value, baseUrl, attributeName) {
  try {
    const url = new URL(value, baseUrl);
    const allowedProtocols = attributeName === 'href'
      ? new Set(['http:', 'https:', 'mailto:', 'tel:'])
      : new Set(['http:', 'https:']);
    return allowedProtocols.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sanitizeNode(element, baseUrl) {
  const tagName = element.localName.toLowerCase();
  if (DROP_CONTENT_TAGS.has(tagName)) {
    element.remove();
    return;
  }

  for (const child of [...element.children]) {
    sanitizeNode(child, baseUrl);
  }

  if (!ALLOWED_TAGS.has(tagName)) {
    const parent = element.parentNode;
    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }
    element.remove();
    return;
  }

  const allowedAttributes = ELEMENT_ATTRIBUTES[tagName] || new Set();
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (!SHARED_ATTRIBUTES.has(name) &&
        !allowedAttributes.has(name) &&
        !name.startsWith('aria-')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'href' || name === 'src' || name === 'cite') {
      const safeUrl = sanitizeUrl(attribute.value, baseUrl, name === 'cite' ? 'href' : name);
      if (safeUrl) {
        element.setAttribute(attribute.name, safeUrl);
      } else {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export function sanitizeElement(root, baseUrl) {
  sanitizeNode(root, baseUrl);
  return root;
}
