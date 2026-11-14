import { after } from 'node:test';
import { JSDOM } from 'jsdom';

let browser: JSDOM | undefined;

export function matrixDom() {
  // React and MUI cache document resources; all cases share one browser lifetime.
  return (browser ??= new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  }));
}

after(() => browser?.window.close());
