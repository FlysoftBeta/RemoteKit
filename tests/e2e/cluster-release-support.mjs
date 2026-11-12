// A release test needs its isolated release root, build.json and release directory.
// Bundle only the test harness from source, never shared product artifacts.
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, requireControl } from './cluster-test-support.mjs';
export { startControl, until } from './cluster-test-support.mjs';
export async function buildHarness(runtime) {
  const control = join(runtime, 'control');
  await mkdir(join(control, 'dist'), { recursive: true });
  await symlink(join(repository, 'control/node_modules'), join(control, 'node_modules'), 'junction');
  await symlink(join(repository, 'control/dist/client'), join(control, 'dist/client'), 'junction');
  const server = join(control, 'dist/server.mjs');
  await requireControl('esbuild').build({
    entryPoints: [join(repository, 'tests/e2e/cluster-harness.mts')],
    outfile: server,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  return server;
}
