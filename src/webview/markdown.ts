/**
 * Markdown rendering for assistant messages.
 *
 * `marked` turns the incremental text into HTML, `DOMPurify` sanitizes it with a
 * strict URI policy, and anchors are decorated to open outside the webview. The
 * webview CSP forbids remote loads, so nothing here fetches anything.
 */

import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import { Marked } from 'marked';

/**
 * Only https, mailto and vscode-file URIs survive sanitization. Relative links
 * are stripped because they cannot be resolved from a webview document.
 */
export const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|vscode-file:)/i;

const PURIFY_CONFIG: Config = {
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'base',
    'link',
    'meta',
    'dialog',
  ],
  FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload', 'onclick', 'onmouseover'],
  ADD_ATTR: ['target', 'rel'],
  ALLOW_DATA_ATTR: false,
};

const marked = new Marked({ gfm: true, breaks: true });

/* Cache the last rendered documents so streaming re-renders do not re-parse
 * the whole message on every keystroke. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 64;

/**
 * Closes an unterminated fenced code block so a half-streamed document keeps its
 * layout instead of swallowing the rest of the message.
 */
export function completePartialMarkdown(source: string): string {
  const fences = source.match(/^\s*```/gm);
  if (fences && fences.length % 2 === 1) return `${source}\n\`\`\`\n`;
  return source;
}

function decorateLinks(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const links = template.content.querySelectorAll('a[href]');
  links.forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer noopener');
  });
  return template.innerHTML;
}

/** Renders markdown to sanitized HTML, safe for `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string): string {
  const cached = cache.get(source);
  if (cached !== undefined) {
    cache.delete(source);
    cache.set(source, cached);
    return cached;
  }

  const raw = marked.parse(completePartialMarkdown(source), { async: false });
  const html = decorateLinks(DOMPurify.sanitize(raw, PURIFY_CONFIG));

  cache.set(source, html);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return html;
}
