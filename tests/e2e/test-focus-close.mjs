import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteInputReady, runScenario } from './kit/viewer.mjs';

await runScenario('focus-close', async (v, stack) => {
  const { page } = v;
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const transport = hook.memoizedState;
          if (!transport?.presentation || !transport?.input || !transport?.rtc) continue;
          const input = transport.input;
          const trace = (window.focusCloseTrace = { wire: [], local: [], editing: [], input });
          const createView = transport.editing.createView.bind(transport.editing);
          transport.editing.createView = (...args) => {
            const view = createView(...args);
            const sendEdit = view.sendEdit;
            view.sendEdit = (event) => {
              trace.editing.push({
                event,
                owner: view.editorOwner,
                remoteOwner: view.remoteOwner,
                target: view.editableTarget,
                currentTarget: view.currentEditTarget(),
                matches: view.editing.matches(view.editorOwner),
                pointer: view.pointerFocus,
                remoteEditable: view.remoteEditable,
                current: transport.editing.mobileEditing.current,
                ready: view.editableReady,
                frameReady: view.frameReady,
              });
              return sendEdit(event);
            };
            return view;
          };
          for (const type of ['keydown', 'beforeinput', 'input'])
            document.addEventListener(
              type,
              (event) => {
                if (event.target.matches?.('.remote-input'))
                  trace.local.push({ type, key: event.key, data: event.data, value: event.target.value });
              },
              true,
            );
          const record = (direction, message) => {
            if (!['focus', 'input', 'input.result', 'input.editable'].includes(message.type)) return;
            trace.wire.push({ direction, message: JSON.parse(JSON.stringify(message)) });
          };
          transport.endpoint.messages.subscribe((message) => record('in', message));
          const observed = new WeakSet();
          const observe = () => {
            const channel = transport.endpoint.channel;
            if (!channel || observed.has(channel)) return;
            observed.add(channel);
            const send = channel.send.bind(channel);
            channel.send = (data) => {
              if (typeof data === 'string') {
                try {
                  record('out', JSON.parse(data));
                } catch {}
              }
              return send(data);
            };
          };
          transport.endpoint.events.subscribe(observe);
          observe();
          return;
        }
      }
    }
    throw Error('Input transport diagnostics unavailable');
  });
  const saveProtocol = async () =>
    writeFileSync(
      join(v.out, 'focus-close-protocol.json'),
      JSON.stringify(
        {
          ...(await page.evaluate(() => ({
            wire: window.focusCloseTrace.wire,
            local: window.focusCloseTrace.local,
            editing: window.focusCloseTrace.editing,
            inputTrace: window.focusCloseTrace.input.inputTrace,
            state: window.__remotekitTest.state(),
          }))),
          fixtureEvents: await events(),
        },
        null,
        2,
      ),
    );
  const events = async () => (await fetch(stack.fixture + '/events')).json();
  let documentId, tabId;
  const latest = async () => (await events()).findLast((event) => event.documentId === documentId);
  const values = async (expected) => {
    try {
      return await v.until(async () => {
        const event = await latest();
        return event && JSON.stringify(event.values) === JSON.stringify(expected) && event;
      }, 'single input has exact remote values');
    } finally {
      await saveProtocol();
    }
  };
  const focus = async (index) => {
    await page.waitForFunction(remoteInputReady);
    const sample = await latest();
    const canvas = await page.locator('canvas[data-video-input]').first().boundingBox();
    assert(canvas);
    const field = sample.geometry[index];
    await page.mouse.click(
      canvas.x + ((field.x + field.width / 2) * canvas.width) / sample.width,
      canvas.y + ((field.y + field.height / 2) * canvas.height) / sample.height,
    );
    await page.waitForFunction(() => document.activeElement?.matches('.remote-input'));
  };
  await v.step('focus-switch-and-single-input', async () => {
    await v.openStart();
    await v.tile('浏览器').click();
    await v.navigate(stack.fixture + '/focus-close/');
    const ready = await v.until(
      async () => (await events()).find((event) => event.type === 'ready'),
      'fixture ready',
    );
    documentId = ready.documentId;
    await v.until(() => v.state.workspace.tabs.some((tab) => tab.title === 'Focus close'), 'fixture title');
    tabId = v.state.workspace.tabs.find((tab) => tab.title === 'Focus close').id;
    await focus(0);
    await page.keyboard.type('first-once');
    await values(['first-once', '']);
    await focus(1);
    await page.keyboard.type('second-once');
    await values(['first-once', 'second-once']);
    await page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first().click();
    await focus(0);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await values(['first-once!', 'second-once']);
    await v.assertNoBrowserRestart();
  });
  if (!documentId || !tabId || process.exitCode) return;
  await v.step('beforeunload-cancel-keeps-page-usable', async () => {
    const cursor = (await events()).length;
    await page.getByRole('button', { name: '关闭 Focus close', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '离开此页面？', exact: true });
    await dialog.waitFor();
    await v.until(
      async () =>
        (await events())
          .slice(cursor)
          .some((event) => event.type === 'beforeunload' && event.documentId === documentId),
      'new beforeunload event',
    );
    await dialog.getByRole('button', { name: '保留页面', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await v.refresh();
    assert(v.state.workspace.tabs.some((tab) => tab.id === tabId));
    await focus(1);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await values(['first-once!', 'second-once!']);
    await v.assertNoBrowserRestart();
  });
  if (process.exitCode) return;
  await v.step('beforeunload-confirm-closes-page', async () => {
    await page.getByRole('button', { name: '关闭 Focus close', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '离开此页面？', exact: true });
    await dialog.getByRole('button', { name: '离开', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await v.until(() => !v.state.workspace.tabs.some((tab) => tab.id === tabId), 'confirmed page close');
    await v.assertNoBrowserRestart();
  });
});
