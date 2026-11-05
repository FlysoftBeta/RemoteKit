// Packaged next to run.cmd. Keep arguments as data, including spaces and quotes.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = __dirname;
process.env.REMOTEKIT_ENDPOINT = path.join(root, 'bin', 'endpoint_service.exe');
process.env.REMOTEKIT_ENDPOINT_ARGS = JSON.stringify([
  `--browser=${path.join(root, 'bin', 'remotekit_browser.exe')}`,
  `--data-path=${path.join(root, 'data', 'endpoint')}`,
  ...process.argv.slice(2),
]);
process.env.REMOTEKIT_CONTROL_DB = path.join(root, 'data', 'control.db');

import(pathToFileURL(path.join(root, 'control', 'dist', 'server.mjs')).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
