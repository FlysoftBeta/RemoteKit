import assert from 'node:assert/strict';

export function createCdpInteraction({ cdp, page, until, sleep }) {
  const read = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture: false,
      awaitPromise: true,
    });
    assert(!exceptionDetails, exceptionDetails?.exception?.description || exceptionDetails?.text);
    return result.value;
  };
  const stablePoint = (locate, label) =>
    until(async () => {
      const first = await locate();
      if (!first) return false;
      await sleep(90);
      const settled = await locate();
      return settled && Math.abs(first.x - settled.x) < 1 && Math.abs(first.y - settled.y) < 1 && settled;
    }, label);
  const click = async (selector, name) => {
    const locate = () =>
      read(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = elements.find(candidate => candidate.getClientRects().length &&
        !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' &&
        (${JSON.stringify(name ?? null)} === null ||
          (candidate.getAttribute('aria-label') || candidate.textContent.trim()) === ${JSON.stringify(name ?? null)}));
      if (!el) return null;
      el.scrollIntoView({block:'nearest', inline:'nearest'});
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      return el.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
    })()`);
    const point = await stablePoint(locate, 'Missing stable control ' + (name ?? selector));
    await page.mouse.click(point.x, point.y);
  };
  const find = (selector, index = 0) =>
    until(
      () => read(`Boolean(document.querySelectorAll(${JSON.stringify(selector)})[${index}])`),
      'Missing element ' + selector,
    );
  const fill = async (selector, value, index = 0) => {
    const locate = () =>
      read(`(() => {
      const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!input || input.disabled || input.readOnly) return null;
      input.scrollIntoView({block:'nearest', inline:'nearest'});
      const box = input.getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      return box.width && box.height && input.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
    })()`);
    const point = await stablePoint(locate, 'Missing stable input ' + selector);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(value);
    let actual;
    await until(async () => {
      actual = await read(`document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.value`);
      return actual === value;
    }, 'Could not fill ' + selector).catch((error) => {
      throw new Error(`Expected ${JSON.stringify(value)}, actual ${JSON.stringify(actual)}`, {
        cause: error,
      });
    });
  };
  const unlock = async () => {
    await until(
      async () => {
        if (!(await read('Boolean(document.querySelector(".viewer-lock-blank"))'))) return true;
        for (const key of [
          'ArrowUp',
          'ArrowUp',
          'ArrowDown',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ArrowLeft',
          'ArrowRight',
        ]) {
          await page.keyboard.press(key);
        }
        await sleep(200);
        return !(await read('Boolean(document.querySelector(".viewer-lock-blank"))'));
      },
      'Trusted reveal sequence did not open the authentication panel',
      5000,
    );
  };
  return { read, click, find, fill, unlock };
}
