import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const application = new URL('../server/application.ts', import.meta.url).href;
const source = `
  import { EventEmitter } from 'node:events';
  import { constants, fstatSync } from 'node:fs';
  import { startApplication } from ${JSON.stringify(application)};
  const stat = fstatSync(0);
  const piped = stat.isFIFO() || (process.platform === 'win32' && (stat.mode & constants.S_IFMT) === constants.S_IFIFO);
  console.log(JSON.stringify({isFIFO: stat.isFIFO(), piped}));
  const nodes = Object.assign(new EventEmitter(), {
    start() { console.log('started'); },
    async stop() { console.log('nodes stopped'); },
  });
  const control = {
    rtc: {}, reconciler: {}, objects: {},
    sessionImporter: {start() {}}, learning: {start() {}},
    async close() { console.log('control closed'); },
  };
  const server = {
    listen(port, host, ready) { setImmediate(ready); },
    address() { return {port: 0}; },
    async shutdown() { console.log('server stopped'); },
  };
  startApplication({host: 'localhost', port: 0},
    {db: {close() { console.log('database closed'); }}}, nodes, control, server);
`;

for (const stdin of ['pipe', 'ignore'] as const) {
  test(`application handles ${stdin} stdin lifetime`, { timeout: 15000 }, async (t) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: new URL('../', import.meta.url),
      stdio: stdin === 'pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = '';
    let errors = '';
    child.stdout!.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 10000;
    while (!output.includes('started')) {
      assert.equal(child.exitCode, null, errors);
      assert.ok(Date.now() < deadline, errors || output);
      await sleep(20);
    }
    const stat = JSON.parse(output.split('\n')[0]);
    assert.equal(stat.piped, stdin === 'pipe');
    if (process.platform === 'win32') assert.equal(stat.isFIFO, false);
    if (stdin === 'pipe') child.stdin!.end();
    else {
      await sleep(100);
      assert.equal(output.includes('server stopped'), false);
      child.disconnect();
    }
    const [code] = await exited;
    assert.equal(code, 0, errors);
    assert.deepEqual(output.trim().split(/\r?\n/).slice(-4), [
      'server stopped',
      'control closed',
      'nodes stopped',
      'database closed',
    ]);
  });
}
