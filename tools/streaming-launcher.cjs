const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const [mode, ...args] = process.argv.splice(2);
if (!['combined', 'control'].includes(mode) || args.length) {
  throw new Error('Use run.cmd or run-control.cmd without arguments.');
}

const root = __dirname;
const directory = path.join(root, 'config');
const configPath = path.join(directory, 'control.json');
const localRoot = path.join(root, 'data', 'local');
const managedExecutable = /^\.\.\/data\/local\/runtime\/[a-f0-9]{64}\/bin\/endpoint_service\.exe$/;
const firstStart = !existsSync(configPath);
const config = firstStart
  ? {
      http: {
        host: '127.0.0.1',
        port: 3001,
        origins: [
          'http://127.0.0.1:3001',
          'http://localhost:3001',
          'http://127.0.0.1:5173',
          'http://localhost:5173',
        ],
      },
      database: '../data/control.db',
      diagnostics: '../data/diagnostics',
      cluster: { keyFile: 'cluster.key' },
      nodes: {},
    }
  : JSON.parse(readFileSync(configPath, 'utf8'));

const launches = Object.values(config.nodes ?? {}).filter(node => node?.launch);
if (mode === 'control' && launches.length) {
  throw new Error('Remove local launch entries from config/control.json or use run.cmd.');
}
if (mode === 'combined' && !firstStart && !launches.length) {
  throw new Error('Configure a local launch entry in config/control.json or use run-control.cmd.');
}

let changed = firstStart;
if (mode === 'combined') {
  const local = config.nodes?.local?.launch;
  if (firstStart || managedExecutable.test(local?.executable)) {
    const { buildId } = JSON.parse(readFileSync(path.join(root, 'build.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error('Invalid bundled build identity.');
    execFileSync(
      path.join(root, 'bin', 'remotekit_node.exe'),
      ['install', '--root=' + localRoot, '--package=' + root],
      { stdio: 'inherit', windowsHide: true },
    );
    const executable = '../data/local/runtime/' + buildId + '/bin/endpoint_service.exe';
    changed ||= local?.executable !== executable;
    if (firstStart) config.nodes.local = { launch: { executable, root: '../data/node' } };
    else local.executable = executable;
  }
}

if (changed) {
  mkdirSync(directory, { recursive: true });
  const contents = JSON.stringify(config, null, 2) + '\n';
  if (firstStart) {
    writeFileSync(configPath, contents, { flag: 'wx', mode: 0o600 });
  } else {
    const temporary = configPath + '.' + process.pid + '.tmp';
    try {
      writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, configPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

process.env.REMOTEKIT_CONTROL_CONFIG = configPath;
import(pathToFileURL(path.join(root, 'control', 'dist', 'server.mjs')).href).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
