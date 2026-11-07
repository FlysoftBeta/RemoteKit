const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const [mode, ...args] = process.argv.splice(2);
if (!['combined', 'control'].includes(mode) || args.length) {
  throw new Error('Use run.cmd or run-control.cmd without arguments.');
}

const root = __dirname;
const directory = path.join(root, 'config');
const configPath = path.join(directory, 'control.json');
const firstStart = !existsSync(configPath);
if (firstStart) {
  const config = {
    http: {
      listen: '127.0.0.1:3001',
      origins: ['http://127.0.0.1:3001', 'http://localhost:3001'],
    },
    storage: { database: '../data/control.db', diagnostics: '../data/diagnostics' },
    cluster: { keyFile: 'cluster.key' },
    nodes: mode === 'combined' ? { local: { local: { root: '../data/node' } } } : {},
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

const locals = Object.values(JSON.parse(readFileSync(configPath, 'utf8')).nodes ?? {}).filter(
  node => node?.local,
);
if (mode === 'control' && locals.length) {
  throw new Error('Remove local node entries from config/control.json or use run.cmd.');
}
if (mode === 'combined') {
  if (!locals.length) {
    throw new Error('Configure a local node in config/control.json or use run-control.cmd.');
  }
  // Control runs data/local/runtime/<its buildId>, so the bundled runtime must be installed first.
  execFileSync(
    path.join(root, 'bin', 'remotekit_node.exe'),
    ['install', '--root=' + path.join(root, 'data', 'local'), '--package=' + root],
    { stdio: 'inherit', windowsHide: true },
  );
}

process.env.REMOTEKIT_CONTROL_CONFIG = configPath;
import(pathToFileURL(path.join(root, 'control', 'dist', 'server.mjs')).href).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
