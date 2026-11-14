import assert from 'node:assert/strict';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { createViewerContext, instrumentViewer, launchBrowser } from './kit/viewer.mjs';
import { cleanupRun } from './kit/cleanup.mjs';

const stack = await startStack({
  scenario: 'session-fencing',
  endpoint: process.env.REMOTEKIT_ENDPOINT ?? resolve('build/endpoint/endpoint/endpoint_service.exe'),
});
let browser;
const save = (name, value) => writeFileSync(join(stack.run, `${name}.json`), JSON.stringify(value, null, 2));
async function connect(name) {
  const context = await createViewerContext(browser, { viewport: { width: 1000, height: 760 } });
  const reply = await context.request.post(`${stack.origin}/api/auth/login`, {
    headers: { Origin: stack.origin },
    data: { username: stack.username, password: stack.password },
  });
  assert(reply.ok(), await reply.text());
  const viewer = await instrumentViewer(context, stack.run, name);
  await viewer.page.goto(stack.origin, { timeout: 90000 });
  await viewer.page.bringToFront();
  try {
    await viewer.ready(90000);
  } catch (error) {
    save(
      `${name}-failed`,
      await viewer.page.evaluate(() => ({ auth: window.clusterQA?.auth, state: window.clusterQA?.state })),
    );
    throw error;
  }
  await viewer.service();
  return viewer;
}
try {
  await until(async () => (await stack.call('inspect')).nodes[0]?.state === 'ready', 'local node ready');
  browser = await launchBrowser({ channel: 'msedge', headless: true });
  let viewer = await connect('initial');
  await viewer.call('auth.settings', {
    currentPassword: stack.password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  await until(async () => (await viewer.state()).browser.state === 'available', 'Session running');
  await viewer.page.close();
  await until(async () => !(await stack.call('inspect')).runtimes[0]?.viewer, 'Viewer detached');
  await stack.advance(600001);
  const stopped = await until(
    async () => {
      const snapshot = await stack.call('inspect');
      const placement = snapshot.placements[0];
      return placement?.run_state === 'stopped' && placement.data_state === 'clean' && snapshot;
    },
    'clean commit',
    90000,
  );
  save('stopped', stopped);
  const placement = stopped.placements[0];
  const directory = join(stack.run, 'node/data/sessions', placement.session_id);
  await stack.call('pausePublications');
  viewer = await connect('reconnected');
  const connected = await stack.call('inspect');
  const service = connected.services.find((entry) => entry.tenant === placement.tenant);
  assert(service);
  writeFileSync(join(directory, 'uncommitted-marker'), 'must never return');
  await stack.call('fenceClean', { tenant: placement.tenant, stageDirty: true });
  const fenced = await stack.call('inspect');
  save('fenced', fenced);
  assert.equal(
    fenced.services.find((entry) => entry.tenant === placement.tenant)?.connectionId,
    service.connectionId,
  );
  await viewer.service();
  assert(existsSync(join(directory, 'uncommitted-marker')));
  assert(!existsSync(`${directory}.copy.json`));
  renameSync(directory, `${directory}.renamed`);
  renameSync(`${directory}.renamed`, directory);
  await stack.call('resumePublications');
  await until(async () => (await viewer.state()).browser.state === 'available', 'Session reopened');
  save('reopened', await stack.call('inspect'));
  assert(!existsSync(join(directory, 'uncommitted-marker')));
  assert.match(stack.readLog('endpoint'), /"mode":"cold"/);
  console.log('Session fenced, directory released, checkpoint restored, Viewer reconnected');
} finally {
  await browser?.close();
  await stack.stop();
  await cleanupRun(stack.run);
}
