import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const ts = createRequire(new URL('../../../control/package.json', import.meta.url))('typescript');
const launcher = resolve(repository, 'tests/e2e/kit/browser.mjs');
const extensions = /\.(?:[cm]?[jt]sx?|py|ps1|cmd|bat|sh|c|cc|cpp|h|hpp)$/;

export function browserLaunchViolations(source, file) {
  const errors = [];
  const ownsLauncher = resolve(repository, file) === launcher;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function fail(node, reason) {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    errors.push(`${file}:${line + 1}: ${reason}; use kit/browser.mjs launchTestBrowser`);
  }
  function insideSeededLauncher(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent)) return ownsLauncher && parent.name?.text === 'launchTestBrowser';
    }
    return false;
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)
          ? expression.argumentExpression.text
          : '';
      if (
        ['launch', 'launchServer'].includes(name) ||
        (name === 'launchPersistentContext' && !insideSeededLauncher(node))
      )
        fail(node, 'Direct browser launch');
      if (
        /^(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)$/.test(name || expression.getText(tree)) &&
        ((ownsLauncher && name.startsWith('spawn')) ||
          /(?:chrome|chromium|msedge|viewer)(?:Exe|Path)?\b|(?:chrome|msedge)\.exe/i.test(
            node.arguments[0]?.getText(tree) ?? '',
          )) &&
        !insideSeededLauncher(node)
      )
        fail(node, 'Raw browser process');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const profileFlag = '--user' + '-data-dir';
  if (!ownsLauncher && source.includes(profileFlag))
    errors.push(`${file}: raw browser profile argument; use kit/browser.mjs launchTestBrowser`);
  if (
    /\.(?:py|ps1|cmd|bat|sh|c|cc|cpp|h|hpp)$/.test(file) &&
    /(?:chrome|msedge)\.exe/i.test(source) &&
    /(?:Popen|subprocess\.(?:run|call)|Start-Process|CreateProcess|system\s*\(|&\s)/.test(source)
  )
    errors.push(`${file}: raw browser command; use kit/browser.mjs launchTestBrowser`);
  return errors;
}

export function checkBrowserLaunchPolicy() {
  for (const method of ['launch', 'launchPersistentContext', 'launchServer']) {
    assert.equal(browserLaunchViolations(`chromium .\n ${method}({})`, 'probe.mjs').length, 1);
    assert.equal(browserLaunchViolations(`chromium['${method}']({})`, 'probe.mjs').length, 1);
  }
  assert.equal(browserLaunchViolations('spawn(chrome, args)', 'probe.mjs').length, 1);
  assert.equal(browserLaunchViolations('process.spawn(viewerExe, args)', 'probe.mjs').length, 1);
  assert.equal(browserLaunchViolations('launchTestBrowser({ profile })', 'probe.mjs').length, 0);
  const launcherFile = relative(repository, launcher);
  assert.equal(browserLaunchViolations('chromium.launchPersistentContext(profile)', launcherFile).length, 1);
  assert.equal(
    browserLaunchViolations(
      'export function launchTestBrowser() { return chromium.launchPersistentContext(profile); }',
      launcherFile,
    ).length,
    0,
  );
  assert.equal(
    browserLaunchViolations('export function launchTestBrowser() { return chromium.launch(); }', launcherFile)
      .length,
    1,
  );
  assert.equal(browserLaunchViolations('childProcess.spawn(executablePath, args)', launcherFile).length, 1);
  const errors = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '__pycache__', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (extensions.test(entry.name))
        errors.push(...browserLaunchViolations(readFileSync(path, 'utf8'), relative(repository, path)));
    }
  }
  for (const directory of ['tests', 'tools']) scan(join(repository, directory));
  assert.deepEqual(errors, [], 'Browser launch policy violations:\n' + errors.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkBrowserLaunchPolicy();
  console.log('Browser launch policy checked: tests/ and tools/.');
}
