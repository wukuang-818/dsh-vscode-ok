/**
 * Markdown rendering for assistant messages.
 *
 * `marked` turns the incremental text into HTML, `DOMPurify` sanitizes it with a
 * strict URI policy, and the result is decorated lightly: anchors open outside
 * the webview and fenced code blocks get a Copilot-style header strip with a
 * language label and a copy button. The decoration runs after sanitization and
 * only ever adds static markup or text, so `dangerouslySetInnerHTML` stays safe.
 *
 * The webview CSP forbids remote loads, so nothing here fetches anything.
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

/* Cache the rendered documents (sanitized + decorated) keyed by the exact
 * source string, so an unchanged message never re-parses and streaming
 * re-renders only pay for the message that is actually growing. The map is an
 * LRU: a hit is re-inserted, and the oldest entry leaves past the limit. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 200;

/**
 * Closes an unterminated fenced code block so a half-streamed document keeps its
 * layout instead of swallowing the rest of the message.
 */
export function completePartialMarkdown(source: string): string {
  const fences = source.match(/^\s*```/gm);
  if (fences && fences.length % 2 === 1) return `${source}\n\`\`\`\n`;
  return source;
}

const COPY_ICON =
  '<svg class="code-icon code-icon-copy" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="9" rx="1.2"/><path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8"/></svg>';

const CHECK_ICON =
  '<svg class="code-icon code-icon-check" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 8.4 6.4 12 13.2 4"/></svg>';

function decorateLinks(root: DocumentFragment): void {
  root.querySelectorAll('a[href]').forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer noopener');
  });
}

/**
 * Wraps each fenced code block in a `.code-block` shell. The copy button is
 * static markup; the delegated click handler in the message component reads the
 * code text and posts the existing `copy` message.
 */
function decorateCodeBlocks(root: DocumentFragment): void {
  const blocks = Array.from(root.querySelectorAll('pre > code'));
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('code-block')) continue;

    const languageMatch = /(?:^|\s)language-([\w+#.-]+)/i.exec(code.className);
    const language = languageMatch?.[1]?.toLowerCase() ?? 'code';

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';

    const head = document.createElement('div');
    head.className = 'code-head';

    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = language;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.setAttribute('aria-label', 'Copy code');
    button.setAttribute('title', 'Copy code');
    button.innerHTML = `${COPY_ICON}${CHECK_ICON}`;

    head.append(label, button);
    pre.replaceWith(wrapper);
    wrapper.append(head, pre);
  }
}

/**
 * Wraps tables in a scroll container so a wide table scrolls inside the message
 * instead of widening the webview.
 */
function decorateTables(root: DocumentFragment): void {
  const tables = Array.from(root.querySelectorAll('table'));
  for (const table of tables) {
    if (table.parentElement?.classList.contains('table-scroll')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
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
  const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG);

  const template = document.createElement('template');
  template.innerHTML = sanitized;
  decorateLinks(template.content);
  decorateCodeBlocks(template.content);
  decorateTables(template.content);
  const html = template.innerHTML;

  cache.set(source, html);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return html;
}
