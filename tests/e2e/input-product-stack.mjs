import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export { until } from './kit/stack.mjs';

// Source server and source Viewer, with every listener inside the input allocation.
export function startProductStack(options) {
  if (options.port < 34100 || options.port + 3 > 34199) throw Error('Input port allocation');
  return spawn(process.execPath, [fileURLToPath(new URL('./input-product-server.mjs', import.meta.url))], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, E2E_INPUT_STACK: JSON.stringify(options) },
  });
}
