import { createServer } from 'node:http';
import { startStack } from './kit/stack.mjs';
import { cliOptions, launch } from './kit/viewer.mjs';

const options = cliOptions();
options.port ??= '34000';
const stack = await startStack({
  scenario: 'drive',
  browser: options['browser-path'],
  run: options.out,
});
let viewer;
let server;
let closing;
function close() {
  return (closing ??= (async () => {
    server?.closeAllConnections();
    server?.close();
    await viewer?.close();
    await stack.stop();
  })());
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
try {
  viewer = await launch({ ...options, stack });
  const { page, pointer } = viewer;
  await viewer.openStart();
  await viewer.tile('浏览器').click({ timeout: 120000 });
  await viewer.until(() => viewer.state.workspace.windows.length === 1, 'browser');
  const commands = {
    shot: async (q) => {
      await viewer.shot(q.get('name') ?? 'shot');
      return 'ok';
    },
    click: async (q) => {
      await pointer.move(Number(q.get('x')), Number(q.get('y')));
      await pointer.down();
      await pointer.up();
      return 'ok';
    },
    type: async (q) => {
      await page.keyboard.type(q.get('text'), { delay: 30 });
      return 'ok';
    },
    key: async (q) => {
      await page.keyboard.press(q.get('k'));
      return 'ok';
    },
    address: async (q) => {
      await viewer.navigate(q.get('text'));
      return 'ok';
    },
    wait: async (q) => {
      await page.waitForTimeout(Number(q.get('ms')));
      return 'ok';
    },
    start: async () => {
      await viewer.openStart();
      await viewer.shot('start');
      return 'ok';
    },
    esc: async () => {
      await page.keyboard.press('Escape');
      return 'ok';
    },
    tabs: async () => {
      await viewer.refresh();
      return viewer.state.workspace.tabs;
    },
    tiles: async () =>
      page
        .locator('[data-tile-key]')
        .evaluateAll((tiles) => tiles.map((tile) => ({ key: tile.dataset.tileKey, text: tile.textContent }))),
    lock: async () => {
      await viewer.lock();
      return 'ok';
    },
    unlock: async () => {
      await viewer.unlock();
      return 'ok';
    },
    quit: async () => {
      setTimeout(() => void close(), 100);
      return 'bye';
    },
  };
  let queue = Promise.resolve();
  server = createServer((request, response) => {
    queue = queue.then(async () => {
      const url = new URL(request.url, 'http://driver');
      const commandName = url.pathname.slice(1);
      const command = commands[commandName];
      if (!command) {
        response.writeHead(404).end('Unknown command');
        return;
      }
      let result;
      let failure;
      await viewer.step('command-' + commandName, async () => {
        try {
          result = await command(url.searchParams);
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      if (failure) response.writeHead(500).end(String(failure));
      else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(result) + '\n');
      }
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port), '127.0.0.1', done);
  });
  console.log(
    JSON.stringify(
      {
        driver: `http://127.0.0.1:${options.port}`,
        run: stack.run,
        viewer: stack.origin,
        fixture: stack.fixture,
        logs: { ...stack.logs, browser: stack.logs.browser() },
      },
      null,
      2,
    ),
  );
  await new Promise((done) => server.once('close', done));
} finally {
  await close();
}
