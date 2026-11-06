const path = require('node:path');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

if (process.argv.length > 2) throw new Error('run.cmd does not accept arguments; edit config/control.json');
const root = __dirname;
const directory = path.join(root, 'config');
const configPath = path.join(directory, 'control.json');
mkdirSync(directory, { recursive: true });
if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
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
        nodeDefaults: {
          encoder: 'auto',
          fps: 60,
          bitrate: 36000000,
          maxBitrate: 48000000,
          asyncDepth: null,
          gop: null,
          targetUsage: null,
          qsvLowPower: 'auto',
          bufferMs: null,
          rateControl: null,
          idleIdrMs: 150,
          maxEncodeWidth: 4096,
          maxEncodeHeight: 4096,
          dataPath: 'data',
          browser: null,
          browserTraceDir: null,
          maxSessions: 3,
        },
        nodes: { local: { launch: { executable: '../bin/endpoint_service.exe', root: '../data/node' } } },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
}
process.env.REMOTEKIT_CONTROL_CONFIG = configPath;
import(pathToFileURL(path.join(root, 'control', 'dist', 'server.mjs')).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
