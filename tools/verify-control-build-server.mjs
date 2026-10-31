import { createRequire } from 'node:module';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../control');
const { build } = createRequire(resolve(root, 'package.json'))('esbuild');
await build({ entryPoints: [resolve(root, 'server/main.ts')], outfile: resolve(root, 'dist/server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['better-sqlite3'], sourcemap: false });
const runtime = resolve(root, 'dist/runtime');
if (!runtime.startsWith(resolve(root, 'dist') + sep)) throw new Error('Runtime destination escaped build directory');
await rm(runtime, { recursive: true, force: true });
const packages = { 'better-sqlite3': ['package.json', 'LICENSE', 'lib', 'build/Release/better_sqlite3.node'], bindings: ['package.json', 'LICENSE.md', 'bindings.js'], 'file-uri-to-path': ['package.json', 'LICENSE', 'index.js'] };
const manifest = { node: process.version, nodeModuleAbi: process.versions.modules, platform: process.platform, arch: process.arch, packages: {} };
for (const [name, files] of Object.entries(packages)) {
  const source = resolve(root, 'node_modules', name), destination = resolve(runtime, 'node_modules', name); await mkdir(destination, { recursive: true });
  for (const file of files) { await mkdir(dirname(resolve(destination, file)), { recursive: true }); await cp(resolve(source, file), resolve(destination, file), { recursive: true }); }
  manifest.packages[name] = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8')).version;
}
await writeFile(resolve(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Server bundle and minimal runtime ready (${manifest.node}, ABI ${manifest.nodeModuleAbi})`);
