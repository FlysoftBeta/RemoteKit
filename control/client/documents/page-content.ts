// Adapted from FlysoftBeta/talos-ng packages/client/src/features/reader/renderer/{mount,sanitize}.ts.
import { RemoteKitError } from '../../shared/errors';

const fragment = /^#[\w.:-]+$/;
const properties = new Set(
  `position display overflow width height left top right bottom margin margin-top margin-right margin-bottom
    margin-left padding padding-top padding-right padding-bottom padding-left box-sizing color background
    background-color opacity font font-family font-size font-style font-weight font-stretch line-height
    letter-spacing word-spacing white-space text-align text-indent text-decoration text-rendering
    transform transform-origin vertical-align visibility fill fill-opacity fill-rule stroke stroke-width
    stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset
    clip-path clip-rule mask filter isolation mix-blend-mode stop-color stop-opacity --fit-x --rotation`.split(
    /\s+/,
  ),
);
const functions = new Set(
  'var calc min max clamp matrix translate translatex translatey scale scalex scaley rotate skew skewx skewy rgb rgba hsl hsla url'.split(
    ' ',
  ),
);

function decodeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char,
    );
}

export function stripCssUrls(value: string): string {
  return decodeCss(value).replace(/url\(\s*([^)]*)\)/gi, (_, body: string) => {
    const target = body.trim().replace(/^(['"])(.*)\1$/, '$2');
    return fragment.test(target) ? `url(${target})` : 'none';
  });
}

export function cleanStyle(style: string): string {
  const declarations: string[] = [];
  for (const declaration of decodeCss(style).split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!properties.has(property)) continue;
    const value = stripCssUrls(declaration.slice(colon + 1).trim());
    const calls = Array.from(value.matchAll(/([\w-]+)\s*\(/g));
    if (calls.some((call) => !functions.has(call[1].toLowerCase()))) continue;
    if (/[{}@\\]/.test(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.join(';');
}

/** v2 has plain page rules; discard all at-rules, including imports and font sources. */
export function cleanCss(css: string): string {
  const text = decodeCss(css);
  const rules: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let opening = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ';' && depth === 0) start = i + 1;
    if (char === '{') {
      if (depth === 0) opening = i;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth !== 0) continue;
      const selector = text.slice(start, opening).trim();
      const body = text.slice(opening + 1, i);
      if (selector && !selector.startsWith('@') && !/[{}]/.test(body)) {
        rules.push(`${selector}{${cleanStyle(body)}}`);
      }
      start = i + 1;
    }
  }
  return rules.join('\n');
}

const attributes = new Set(
  `id class role aria-label aria-hidden width height viewbox preserveaspectratio version xmlns xmlns:xlink
    x y x1 y1 x2 y2 dx dy d points transform transform-origin fill fill-opacity fill-rule stroke stroke-width
    stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset
    opacity clip-path clip-rule mask filter cx cy r rx ry offset stop-color stop-opacity gradientunits
    gradienttransform spreadmethod patternunits patterncontentunits patterntransform clippathunits
    maskunits maskcontentunits`.split(/\s+/),
);

/** Only converter resource slots and same-page SVG references may supply URLs. */
export function rewriteAttributes(
  tag: string,
  input: ReadonlyMap<string, string>,
  refs: ReadonlyMap<string, string>,
): Map<string, string> {
  const output = new Map<string, string>();
  const ref = input.get('data-bundle-ref');
  const image = tag === 'image';
  const url = ref && image ? refs.get(ref) : undefined;
  if (ref && (!image || !url)) throw new RemoteKitError('rejected', '页面依赖缺失');
  for (const [name, value] of input) {
    const lower = name.toLowerCase();
    if (lower === 'style') output.set(name, cleanStyle(value));
    else if (lower === 'href' || lower === 'xlink:href') {
      if (!image && fragment.test(value)) output.set(name, value);
    } else if (attributes.has(lower)) output.set(name, stripCssUrls(value));
  }
  if (url) {
    output.set('href', url);
    output.set('xlink:href', url);
  }
  return output;
}

const elements = new Set(
  `main div p span br svg g defs path rect circle ellipse line polyline polygon clippath mask pattern
    lineargradient radialgradient stop symbol use image text tspan title desc`.split(/\s+/),
);

export function sanitizePage(html: string, refs: ReadonlyMap<string, string>): HTMLElement {
  // Template contents stay inert, including image URLs, until all URLs have been rewritten.
  const template = document.createElement('template');
  template.innerHTML = html;
  const page = template.content.firstElementChild;
  if (
    template.content.childElementCount !== 1 ||
    !(page instanceof HTMLElement) ||
    page.localName !== 'main' ||
    !page.classList.contains('page')
  ) {
    throw new RemoteKitError('rejected', '页面格式错误');
  }
  for (const node of [page, ...Array.from(page.querySelectorAll('*'))]) {
    if (!elements.has(node.localName.toLowerCase())) {
      node.remove();
      continue;
    }
    const cleaned = rewriteAttributes(
      node.localName.toLowerCase(),
      new Map(Array.from(node.attributes, (attr) => [attr.name, attr.value])),
      refs,
    );
    for (const attr of Array.from(node.attributes)) node.removeAttributeNode(attr);
    for (const [name, value] of cleaned) {
      if (name === 'xlink:href') node.setAttributeNS('http://www.w3.org/1999/xlink', name, value);
      else node.setAttribute(name, value);
    }
  }
  return page;
}

export function wordFit(target: number, measured: number, scale = 1): number | undefined {
  if (!(target > 0) || !(measured > 0) || !(scale > 0)) return undefined;
  return Math.max(0.5, Math.min(2, (target * scale) / measured));
}

function fitWords(host: HTMLElement, root: ShadowRoot): void {
  const scale = host.getBoundingClientRect().width / host.offsetWidth;
  root.querySelectorAll<HTMLElement>('.word').forEach((word) => {
    const target = parseFloat(word.style.width);
    if (!(target > 0) || Array.from(word.textContent ?? '').length < 2) return;
    const transform = word.style.transform;
    word.style.transform = 'none';
    const range = document.createRange();
    range.selectNodeContents(word);
    const fit = wordFit(target, range.getBoundingClientRect().width, scale);
    if (transform) word.style.transform = transform;
    else word.style.removeProperty('transform');
    if (fit !== undefined) word.style.setProperty('--fit-x', String(fit));
  });
}

export function mountPage(
  host: HTMLElement,
  html: string,
  css: string,
  refs: ReadonlyMap<string, string>,
): () => void {
  const page = sanitizePage(html, refs);
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent =
    ':host{display:block;contain:layout paint;overflow:hidden;color:var(--black);background:var(--surface)}' +
    cleanCss(css);
  root.replaceChildren(style, page);
  let closed = false;
  fitWords(host, root);
  void document.fonts.ready.then(() => {
    if (!closed) fitWords(host, root);
  });
  return () => {
    closed = true;
    root.replaceChildren();
  };
}
