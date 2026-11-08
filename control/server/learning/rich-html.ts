import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { MathML } from 'mathjax-full/js/input/mathml.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import type { LiteElement, LiteNode } from 'mathjax-full/js/adaptors/lite/Element.js';
import { translate } from 'mathjax-full/js/util/Entities.js';
import 'mathjax-full/js/util/entities/all.js';
import type { LearningProvider } from '../../shared/learning';
import type { MediaProxy } from './media-proxy';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages.filter((name) => !['require', 'autoload'].includes(name)) }),
  OutputJax: new SVG({ fontCache: 'none' }),
});
const mathml = mathjax.document('', { InputJax: new MathML(), OutputJax: new SVG({ fontCache: 'none' }) });
const formulas = new Map<string, string>();
function formula(source: string, mathML = false, display = false): string {
  const key = JSON.stringify([source, mathML, display]);
  let svg = formulas.get(key);
  if (svg !== undefined) {
    formulas.delete(key);
    formulas.set(key, svg);
    return svg;
  }
  svg = adaptor.outerHTML((mathML ? mathml : tex).convert(source, { display }));
  formulas.set(key, svg);
  while (formulas.size > 2000) formulas.delete(formulas.keys().next().value!);
  return svg;
}

export function richHtml(
  html: string,
  tenant: string,
  provider: LearningProvider,
  media: MediaProxy,
): string {
  const body = adaptor.body(adaptor.parse(html, 'text/html'));
  const proxy = (raw: string) => {
    const value = translate(raw).trim();
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) && value.length <= 32768)
      return value;
    if (value.startsWith('#')) return value;
    if (/^(?:https?:)?\/\//i.test(value)) {
      try {
        return media.url(tenant, value.startsWith('//') ? 'https:' + value : value, provider);
      } catch {
        return '';
      }
    }
    return '';
  };
  const replace = (node: LiteNode, html: string) => {
    const parsed = adaptor.body(adaptor.parse(html, 'text/html'));
    for (const child of [...adaptor.childNodes(parsed)]) {
      adaptor.remove(child);
      adaptor.insert(child, node);
    }
    adaptor.remove(node);
  };
  const render = (node: LiteNode) => {
    const kind = adaptor.kind(node).toLowerCase();
    if (kind === '#text') {
      const text = adaptor.value(node);
      const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
      let match: RegExpExecArray | null;
      let cursor = 0;
      let html = '';
      const escape = (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      while ((match = pattern.exec(text))) {
        html +=
          escape(text.slice(cursor, match.index)) +
          formula(match[1] ?? match[2] ?? match[3], false, match[1] === undefined);
        cursor = match.index + match[0].length;
      }
      if (cursor) replace(node, html + escape(text.slice(cursor)));
      return;
    }
    if (kind === '#comment') return;
    const element = node as LiteElement;
    if (['script', 'style', 'iframe', 'object', 'embed', 'base', 'link', 'meta'].includes(kind)) {
      adaptor.remove(node);
      return;
    }
    if (kind === 'math') {
      replace(node, formula(adaptor.outerHTML(element), true));
      return;
    }
    if (adaptor.hasAttribute(element, 'data-latex')) {
      replace(node, formula(String(adaptor.getAttribute(element, 'data-latex'))));
      return;
    }
    for (const child of [...adaptor.childNodes(element)]) render(child);
  };
  for (const child of [...adaptor.childNodes(body)]) render(child);
  const rewrite = (element: LiteElement) => {
    for (const { name, value } of adaptor.allAttributes(element)) {
      if (['src', 'href', 'poster', 'xlink:href'].includes(name.toLowerCase())) {
        const url = proxy(value);
        if (url) adaptor.setAttribute(element, name, url);
        else adaptor.removeAttribute(element, name);
      } else if (/^on/i.test(name) || ['srcset', 'srcdoc'].includes(name.toLowerCase()))
        adaptor.removeAttribute(element, name);
      else if (name.toLowerCase() === 'style') {
        const style = value.replace(
          /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
          (_match, double: string, single: string, bare: string) =>
            `url("${proxy(double ?? single ?? bare)}")`,
        );
        if (/expression\s*\(|javascript:|@import|\\/i.test(style)) adaptor.removeAttribute(element, name);
        else adaptor.setAttribute(element, name, style);
      }
    }
    for (const child of adaptor.childNodes(element))
      if (!adaptor.kind(child).startsWith('#')) rewrite(child as LiteElement);
  };
  rewrite(body);
  return adaptor.innerHTML(body);
}
