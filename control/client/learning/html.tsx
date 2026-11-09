import createDOMPurify, { type WindowLike } from 'dompurify';
import { useMemo } from 'react';

export function isControlMediaUrl(value: string) {
  return /^\/api\/learning\/media\/[a-zA-Z0-9_-]+(?:\?[^#]*)?$/.test(value);
}

// Control already rewrote every remote reference; small inline images are the only other source.
const inlineImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const allowedSource = (value: string) => isControlMediaUrl(value) || inlineImage.test(value);

export function learningSanitizer(window: WindowLike) {
  const purify = createDOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'src' && !allowedSource(data.attrValue)) data.keepAttr = false;
    if (data.attrName === 'style') {
      data.attrValue = data.attrValue
        .split(';')
        .filter((declaration) =>
          /^\s*(?:(?:text-align)\s*:\s*(?:left|right|center|justify)|vertical-align\s*:\s*(?:baseline|sub|super|top|middle|bottom|text-top|text-bottom|[-\d.]+(?:px|em|ex|%))|(?:width|height|min-width|max-width)\s*:\s*(?:auto|[\d.]+(?:px|em|ex|rem|%)))\s*$/i.test(
            declaration,
          ),
        )
        .join(';');
    }
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') node.setAttribute('controls', '');
  });
  return (html: string) =>
    purify.sanitize(html, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'span',
        'div',
        'img',
        'sub',
        'sup',
        'b',
        'i',
        'u',
        'strong',
        'em',
        'table',
        'thead',
        'tbody',
        'tr',
        'td',
        'th',
        'ul',
        'ol',
        'li',
        'audio',
        'video',
        'source',
        // MathJax SVG output rendered by Control (TeX and MathML both arrive as SVG).
        'mjx-container',
        'svg',
        'g',
        'path',
        'rect',
        'text',
        'title',
      ],
      ALLOWED_ATTR: [
        'src',
        'style',
        'class',
        'colspan',
        'rowspan',
        'controls',
        'viewBox',
        'xmlns',
        'width',
        'height',
        'd',
        'transform',
        'fill',
        'stroke',
        'stroke-width',
        'x',
        'y',
        'role',
        'focusable',
        'aria-hidden',
        'display',
        'jax',
      ],
      CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: /^mjx-container$/,
        attributeNameCheck: /^(?:jax|display|class|style)$/,
        allowCustomizedBuiltInElements: false,
      },
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
}

let sanitizer: ReturnType<typeof learningSanitizer> | undefined;
export function LearningHtml({ html }: { html: string }) {
  const clean = useMemo(() => {
    sanitizer ??= learningSanitizer(window);
    return sanitizer(html);
  }, [html]);
  return <div data-selectable className="learning-html" dangerouslySetInnerHTML={{ __html: clean }} />;
}

export function stripOptionLabel(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, window.NodeFilter.SHOW_TEXT);
  let text: Node | null;
  while ((text = walker.nextNode())) {
    if (!text.textContent?.replace(/\u00a0/g, ' ').trim()) continue;
    text.textContent = text.textContent.replace(
      /^[\s\u00a0]*(?:[A-Z][.、．]|[（(][A-Z][)）])[\s\u00a0]*/i,
      '',
    );
    break;
  }
  return template.innerHTML;
}
