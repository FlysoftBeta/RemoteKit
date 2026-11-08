import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const control = fileURLToPath(new URL('../../../control/', import.meta.url));
const { createServer } = createRequire(resolve(control, 'package.json'))('vite');
const server = await createServer({
  root: control,
  cacheDir: resolve(process.argv[3]),
  server: { host: '127.0.0.1', port: Number(process.argv[2]), strictPort: true },
});
await server.listen();
