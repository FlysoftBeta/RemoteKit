// Source-Control startup contract, using the shared read-only endpoint/browser.
import { startStack } from './kit/stack.mjs';
const stack = await startStack({
  scenario: 'shell-smoke',
  port: Number(process.argv[2] ?? 34060),
  seed: false,
  run: process.argv[3] ?? 'develop/tmp/e2e-shell/smoke-' + Date.now(),
});
try {
  process.argv = [process.execPath, process.argv[1], process.cwd(), stack.origin];
  await import('./smoke-streaming-product.mjs');
} finally {
  await stack.stop();
}
