import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = 'cleanup-tracked.jsonl';
const registeredRuns = new Set();
let currentRun;
export const currentCleanupRun = () => currentRun;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function cleanupRoot(run) {
  run = resolve(run);
  const root = process.env.E2E_RUN && resolve(process.env.E2E_RUN);
  return root && (root === run || inside(root, run)) ? root : run;
}

function inside(root, path) {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}

function checkedPath(run, path) {
  run = resolve(run);
  path = resolve(path);
  if (!inside(run, path)) throw Error('Cleanup path must be below its run: ' + path);
  // Validate every existing ancestor; a junction must never redirect deletion outside the run.
  const physicalRun = realpathSync(run);
  for (let parent = path; parent !== run; parent = dirname(parent)) {
    if (existsSync(parent)) {
      const physical = realpathSync(parent);
      if (physical !== physicalRun && !inside(physicalRun, physical))
        throw Error('Cleanup path escapes through a link: ' + path);
    }
  }
  return path;
}

function allRecords(run) {
  const manifest = join(run, manifestName);
  return existsSync(manifest)
    ? readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

function records(run) {
  const entries = allRecords(run);
  return entries.slice(entries.findLastIndex((entry) => entry.type === 'run') + 1);
}

function runIdentity(run) {
  return allRecords(run).findLast((entry) => entry.type === 'run')?.id;
}

function record(run, value) {
  appendFileSync(join(run, manifestName), JSON.stringify(value) + '\n');
}

export function registerCleanup(run) {
  run = cleanupRoot(run);
  currentRun = run;
  mkdirSync(run, { recursive: true });
  if (!registeredRuns.has(run)) {
    registeredRuns.add(run);
    const id = process.env.E2E_CLEANUP_ID ?? randomUUID();
    if (runIdentity(run) !== id) record(run, { type: 'run', id });
    process.once('beforeExit', async () => {
      try {
        await cleanupRun(run, { runId: id });
      } catch (error) {
        console.error('Cleanup failed:', run, error);
        process.exitCode = 1;
      }
    });
    process.once('exit', () => {
      if (process.env.E2E_RUN || process.env.E2E_KEEP_PROFILES === '1') return;
      if (runIdentity(run) !== id) return;
      if (records(run).some((entry) => entry.type === 'directory' && existsSync(join(run, entry.path))))
        watchDetachedBrowser(run, { pid: process.pid });
    });
  }
  return run;
}

export function createTrackedDirectory(run, path, kind) {
  run = registerCleanup(run);
  path = checkedPath(run, path);
  const name = relative(run, path);
  const tracked = records(run).some((entry) => entry.type === 'directory' && entry.path === name);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    if (!tracked) record(run, { type: 'directory', path: name, kind });
    return true;
  }
  return tracked;
}

export function trackNodeData(run, root) {
  createTrackedDirectory(run, join(root, 'data'), 'session-data');
}

export function trackCleanupProcess(run, child) {
  if (!child.pid) return;
  const markExited = trackCleanupPid(run, child.pid);
  child.once('exit', markExited);
}

export function trackCleanupPid(run, pid) {
  run = registerCleanup(run);
  const id = `${pid}-${Date.now()}`;
  record(run, { type: 'owner', id, pid });
  return () => record(run, { type: 'exited', id });
}

export function watchDetachedBrowser(run, child) {
  if (!child.pid) return;
  const watcher = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), resolve(run), String(child.pid), runIdentity(run)],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  watcher.unref();
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function measureTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { bytes: 0, children: [] };
  if (!stat.isDirectory()) return { bytes: stat.size, children: [] };
  const children = readdirSync(path).map((name) => ({ name, ...measureTree(join(path, name)) }));
  return { bytes: children.reduce((total, entry) => total + entry.bytes, 0), children, directory: true };
}

function sizeEntries(tree, prefix = '') {
  return tree.children
    .filter((entry) => entry.directory)
    .map((entry) => ({ path: prefix + entry.name, bytes: entry.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
}

function profileSizes(tree, path = '') {
  const profiles = [];
  if (
    tree.children.some((entry) => entry.name === 'Local State') ||
    /^profile-\d+$/.test(path.split(sep).at(-1))
  ) {
    profiles.push({
      path,
      bytes: tree.bytes,
      top: sizeEntries(tree),
      defaultTop: sizeEntries(
        tree.children.find((entry) => entry.name === 'Default') ?? { children: [] },
        'Default/',
      ),
    });
  } else {
    for (const child of tree.children) profiles.push(...profileSizes(child, join(path, child.name)));
  }
  return profiles;
}

function preserveArtifacts(run, path, preserved) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const source = join(path, entry.name);
    if (
      /^(crashpad|crash reports|crashes|control\.db)$/i.test(entry.name) ||
      /\.(dmp|mdmp|log|jsonl)$/i.test(entry.name)
    ) {
      const target = join(run, 'preserved', relative(run, source));
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      preserved.push(relative(run, target));
    } else if (entry.isDirectory()) preserveArtifacts(run, source, preserved);
  }
}

export async function cleanupRun(
  run,
  {
    keepProfiles = process.env.E2E_KEEP_PROFILES === '1',
    timeout = 10000,
    retryDelay = 250,
    remove = rm,
    isAlive = processAlive,
    runId,
  } = {},
) {
  run = cleanupRoot(run);
  const reportPath = join(run, 'cleanup.json');
  if (runId && runIdentity(run) !== runId) return;
  const previous = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, 'utf8'))
    : { directories: [] };
  const entries = records(run);
  const identity = runIdentity(run);
  const exited = new Set(entries.filter((entry) => entry.type === 'exited').map((entry) => entry.id));
  const owners = entries.filter((entry) => entry.type === 'owner' && !exited.has(entry.id));
  const deadline = Date.now() + timeout;
  let live;
  do {
    live = owners.filter((owner) => owner.pid !== process.pid && isAlive(owner.pid));
    if (!live.length || Date.now() >= deadline || keepProfiles) break;
    await pause(Math.min(retryDelay, Math.max(0, deadline - Date.now())));
  } while (true);
  const directories = [];
  for (const entry of entries.filter((value) => value.type === 'directory')) {
    const path = checkedPath(run, join(run, entry.path));
    const prior =
      previous.runId === identity
        ? previous.directories.find((value) => value.path === entry.path)
        : undefined;
    if (!existsSync(path)) {
      if (prior) directories.push(prior);
      continue;
    }
    const value = { path: entry.path, kind: entry.kind };
    directories.push(value);
    if (live.length && !keepProfiles) {
      Object.assign(value, {
        status: 'retained',
        error: 'Owning processes still running',
        pids: live.map((owner) => owner.pid),
      });
      continue;
    }
    try {
      if (prior?.status === 'retained' && prior.bytes !== undefined) {
        Object.assign(value, prior);
      } else {
        const tree = measureTree(path);
        value.bytes = tree.bytes;
        value.top = sizeEntries(tree);
        value.defaultTop = sizeEntries(
          tree.children.find((child) => child.name === 'Default') ?? { children: [] },
          'Default/',
        );
        if (entry.kind === 'session-data') value.profiles = profileSizes(tree);
      }
      if (keepProfiles) {
        value.status = 'kept';
        continue;
      }
      value.preserved ??= [];
      preserveArtifacts(run, path, value.preserved);
      const removeDeadline = Date.now() + timeout;
      for (;;) {
        try {
          await remove(path, { recursive: true, force: true, maxRetries: 0 });
          value.status = 'deleted';
          delete value.error;
          delete value.pids;
          break;
        } catch (error) {
          if (Date.now() >= removeDeadline) throw error;
          await pause(Math.min(retryDelay, Math.max(0, removeDeadline - Date.now())));
        }
      }
    } catch (error) {
      value.status = 'retained';
      value.error = String(error);
    }
  }
  const report = {
    runId: identity,
    keepProfiles,
    bytes: directories.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    directories,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

export function cleanupMarkdown(results) {
  const totals = new Map();
  const lines = ['\n| Scenario | Profile / Session bytes | Cleanup |', '|---|---:|---|'];
  for (const result of results) {
    const cleanup = result.cleanup;
    if (!cleanup) continue;
    const retained = cleanup.directories.filter((entry) => entry.status === 'retained');
    lines.push(
      `| ${result.scenario} (${result.browser}) | ${cleanup.bytes} | ${cleanup.keepProfiles ? 'kept (--keep-profiles)' : retained.length ? retained.map((entry) => `${entry.path}: ${entry.error}`).join('; ') : 'deleted'} |`,
    );
    for (const directory of cleanup.directories) {
      for (const view of [
        { ...directory, kind: directory.kind },
        ...(directory.profiles ?? []).map((profile) => ({ ...profile, kind: 'session-profile' })),
      ]) {
        for (const entry of [...(view.top ?? []), ...(view.defaultTop ?? [])]) {
          const key = view.kind + '/' + entry.path;
          totals.set(key, (totals.get(key) ?? 0) + entry.bytes);
        }
      }
    }
  }
  lines.push(
    '\nImmediate children and Default/ children are separate views of the same bytes.',
    '\n| Directory (aggregated across scenarios) | Bytes |',
    '|---|---:|',
  );
  for (const [path, bytes] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 25))
    lines.push(`| ${path} | ${bytes} |`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [run, pid, runId] = process.argv.slice(2);
  while (processAlive(Number(pid))) await pause(1000);
  await cleanupRun(run, { runId });
}
