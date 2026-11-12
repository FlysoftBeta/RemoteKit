import { resolve } from 'node:path';
import { startStack as startKitStack } from './kit/stack.mjs';
export { until } from './kit/stack.mjs';

export function startStack(options = {}) {
  const port = Number(process.env.E2E_INPUT_PORT ?? 34100);
  if (!Number.isInteger(port) || port < 34100 || port + 3 > 34199)
    throw Error('Input port allocation must stay inside 34100-34199');
  return startKitStack({ ...options, run: resolve(options.run), port, dev: true });
}
