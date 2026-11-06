import { mkdirSync, writeFileSync } from 'node:fs';
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
  nodeDefaults = {},
  configOverrides = {},
}) {
  mkdirSync(run, { recursive: true });
  const configPath = join(run, 'control.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      http: { host: '127.0.0.1', port, origins: [`http://127.0.0.1:${port}`] },
      database: join(run, 'control.db'),
      diagnostics: join(run, 'diagnostics'),
      nodeDefaults: {
        browser: resolve(browser),
        dataPath: join(run, 'endpoint'),
        peer: { listen: `127.0.0.1:${port + 2}`, advertise: `127.0.0.1:${port + 2}` },
        ...nodeDefaults,
      },
      nodes: { local: { launch: { executable: resolve(endpoint), root: join(run, 'node') } } },
      ...configOverrides,
    }),
  );
  return spawn(process.execPath, [server], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      REMOTEKIT_CONTROL_CONFIG: configPath,
    },
  });
}

export async function registerViewer({ click, fill, username, password }) {
  await fill('input[autocomplete="username"]', username);
  await fill('input[autocomplete="new-password"]', password);
  await click('button[type="submit"]', '创建并登录');
}
