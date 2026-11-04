/**
 * Prepare only:
 * node tools/ud710-av-experiment.mjs prepare <playwright> <viewer> <endpoint> <browser> <output> [port]
 * Run the prepared, hash-pinned pair serially:
 * node tools/ud710-av-experiment.mjs run <output>/plan.json
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, open, readFile, readdir, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function tree(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tree(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function invoke(args, env = {}) {
  const child = spawn(process.execPath, args, {cwd:root, windowsHide:true, stdio:'inherit', env:{...process.env, ...env}});
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(Error('Experiment command failed: ' + code)));
  });
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'prepare') {
  const [playwright, viewer, endpoint, browser, output, port = '33991'] = args;
  assert([playwright, viewer, endpoint, browser, output].every(Boolean), 'Expected five paths and optional port');
  const listenPort = Number(port);
  assert(Number.isInteger(listenPort) && listenPort >= 1024 && listenPort < 65535);
  const paths = {playwright:resolve(playwright), viewer:resolve(viewer), endpoint:resolve(endpoint), browser:resolve(browser)};
  const outputRoot = resolve(output);
  const inputs = [...new Set([
    ...Object.values(paths), join(dirname(paths.browser), 'remotekit_sdk.dll'),
    ...await tree(join(root, 'control/dist')),
    ...['test-diagnostic-collection.mjs', 'ud710-av-scenario.mjs', 'ud710-marker.mjs',
      'ud710-lag-scenario.mjs', 'analyze-ud710-lag.mjs', 'ud710-av-experiment.mjs'].map(name => join(root, 'tools', name)),
  ])];
  const files = [];
  for (const path of inputs) files.push({path, sha256:await hash(path)});
  const plan = {schema:1, createdAt:new Date().toISOString(), root, paths, outputRoot, port:listenPort,
    order:['on', 'off'], stimulusSeconds:[30, 22, 5, 13], files,
    scope:'One serial screening pair; fixed VBR, viewport, relay and checked marker. No production/UD710 or physical scanout acceptance.'};
  // Refuse to overwrite an existing experiment or its evidence.
  await mkdir(outputRoot);
  await writeFile(join(outputRoot, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', {flag:'wx'});
  console.log('Prepared only; no browser or benchmark started.');
  console.log(join(outputRoot, 'plan.json'));
} else if (mode === 'run') {
  assert.equal(args.length, 1, 'Expected a prepared plan.json');
  const plan = JSON.parse(await readFile(resolve(args[0]), 'utf8'));
  assert.equal(plan.schema, 1);
  assert.equal(resolve(plan.root), resolve(root), 'Prepared workspace changed');
  assert.deepEqual(plan.order, ['on', 'off']);
  await mkdir(join(root, 'develop/tmp'), {recursive:true});
  const lockPath = join(root, 'develop/tmp/ud710-benchmark.lock');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(String(process.pid));
    for (const audio of plan.order) {
      for (const file of plan.files) assert.equal(await hash(file.path), file.sha256, 'Changed experiment input: ' + file.path);
      const output = join(plan.outputRoot, 'audio-' + audio);
      await invoke([join(root, 'tools/test-diagnostic-collection.mjs'), plan.paths.playwright,
        plan.paths.viewer, plan.paths.endpoint, plan.paths.browser, output, String(plan.port),
        join(root, 'tools/ud710-av-scenario.mjs')], {
        REMOTEKIT_QA_HEADLESS:'1', REMOTEKIT_QA_UD710_AUDIO:audio, REMOTEKIT_QA_UD710_RATE_CONTROL:'vbr',
        REMOTEKIT_QA_DIAGNOSTICS_RESTART:'0',
      });
      await invoke([join(root, 'tools/analyze-ud710-lag.mjs'), output]);
    }
    const comparisons = {};
    for (const audio of plan.order) comparisons[audio] = JSON.parse(await readFile(join(plan.outputRoot, 'audio-' + audio, 'comparison.json'), 'utf8'));
    assert.deepEqual(comparisons.on.atlas, comparisons.off.atlas, 'Video geometry changed between groups');
    assert.deepEqual(comparisons.on.settings, comparisons.off.settings, 'Product settings changed between groups');
    await writeFile(join(plan.outputRoot, 'paired-results.json'), JSON.stringify({
      scope:plan.scope, order:plan.order, results:comparisons,
      warning:'Compare source cadence, send load and RTT as well as latency. A single ordered pair does not establish a universal causal effect.',
    }, null, 2) + '\n', {flag:'wx'});
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
} else throw Error('Use prepare <paths...> or run <plan.json>');
