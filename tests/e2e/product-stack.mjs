import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function startProductStack({
  run,
  port,
  endpoint,
  browser,
  server = join(root, 'control/dist/server.mjs'),
  endpointArgs = [],
  environment = {},
}) {
  return spawn(process.execPath, [server], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORT: String(port),
      REMOTEKIT_CONTROL_HOST: '127.0.0.1',
      REMOTEKIT_CONTROL_ORIGINS: `http://127.0.0.1:${port}`,
      REMOTEKIT_CONTROL_DB: join(run, 'control.db'),
      REMOTEKIT_ENDPOINT: resolve(endpoint),
      REMOTEKIT_ENDPOINT_ARGS: JSON.stringify([
        '--browser=' + resolve(browser),
        '--data-path=' + join(run, 'endpoint'),
        ...endpointArgs,
      ]),
      ...environment,
    },
  });
}

export async function registerViewer({ click, fill, username, password }) {
  await click('button', '创建账户');
  await fill('input[autocomplete="username"]', username);
  await fill('input[autocomplete="new-password"]', password);
  await click('button[type="submit"]', '创建账户');
}
