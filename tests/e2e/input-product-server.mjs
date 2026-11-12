import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startProductStack } from './kit/stack.mjs';

const options = JSON.parse(process.env.E2E_INPUT_STACK);
const origin = `http://127.0.0.1:${options.port}`;
const backend = `http://127.0.0.1:${options.port + 3}`;
const child = startProductStack({
  ...options,
  dev: true,
  port: options.port + 3,
  peer: { listen: `127.0.0.1:${options.port + 2}`, address: `127.0.0.1:${options.port + 2}` },
  configOverrides: { http: { listen: `127.0.0.1:${options.port + 3}`, origins: [origin, backend] } },
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.env.REMOTEKIT_VITE_CONTROL = backend;
const { createServer } = createRequire(resolve('control/package.json'))('vite');
const vite = await createServer({
  root: resolve('control'),
  cacheDir: join(options.run, 'vite-cache'),
  server: { host: '127.0.0.1', port: options.port, strictPort: true, watch: null, hmr: false },
});
await vite.listen();
writeFileSync(
  join(options.run, 'input-pids.json'),
  JSON.stringify({ wrapper: process.pid, control: child.pid }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    }
    process.exit();
  }, 12000);
  deadline.unref();
  if (child.connected) child.disconnect();
  await vite.close();
}
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
child.on('exit', (code) => {
  process.exitCode = code;
  void close();
});
