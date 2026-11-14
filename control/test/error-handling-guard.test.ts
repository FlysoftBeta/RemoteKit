import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
export const errorHandlingAllowList: Record<string, string> = {
  'client/files/file-channel.ts#pipelined-response':
    'Observe rejection immediately; the pipeline later awaits the original response.',
  'client/files/file-channel.ts#upload-abort':
    'Observe abort immediately; the upload awaits the original rejection in its in-flight race.',
  'client/files/file-channel.ts#chunk-ack':
    'Observe acknowledgment rejection immediately; the upload window later awaits every original acknowledgment.',
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

export function errorHandlingViolations(path: string, source: string) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const exceptions = new Set<string>();
  const inspect = (node: ts.Node) => {
    let body: ts.Node | undefined;
    if (ts.isCatchClause(node)) body = node.block;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch'
    ) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
        body = callback.body;
    }
    if (body) {
      const empty = ts.isBlock(body) && body.statements.length === 0;
      let timer = false;
      const scan = (child: ts.Node) => {
        if (
          ts.isCallExpression(child) &&
          ((ts.isIdentifier(child.expression) &&
            ['setTimeout', 'setInterval'].includes(child.expression.text)) ||
            (ts.isPropertyAccessExpression(child.expression) &&
              ['setTimeout', 'setInterval'].includes(child.expression.name.text)))
        )
          timer = true;
        ts.forEachChild(child, scan);
      };
      scan(body);
      if (empty || timer) {
        const text = body.getText(tree);
        const tag = /error-guard: ([a-z-]+)/.exec(text)?.[1];
        const key = tag && `${path}#${tag}`;
        if (key && errorHandlingAllowList[key]) exceptions.add(key);
        else
          violations.push(
            `${path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${empty ? 'empty error handler' : 'retry timer outside RetryUnit'}`,
          );
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(tree);
  return { violations, exceptions };
}

test('server and Viewer error handlers use RetryUnit and settle every failure', () => {
  const violations: string[] = [];
  const exceptions = new Set<string>();
  for (const file of [...sources(join(root, 'server')), ...sources(join(root, 'client'))]) {
    const result = errorHandlingViolations(
      relative(root, file).replace(/\\/g, '/'),
      readFileSync(file, 'utf8'),
    );
    violations.push(...result.violations);
    for (const key of result.exceptions) exceptions.add(key);
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(
    [...exceptions].sort(),
    Object.keys(errorHandlingAllowList).sort(),
    'remove stale exceptions',
  );
});

test('the guard recognizes nested timers, promise handlers, and comment-only catches', () => {
  for (const source of [
    'try { run() } catch { setTimeout(run,1000) }',
    'run().catch(error => { setInterval(() => run(),1000) })',
    'try { run() } catch { /* ignored */ }',
    'run().catch(() => {})',
    'run().catch(() => window.setTimeout(run, 10))',
  ])
    assert.equal(errorHandlingViolations('fixture.ts', source).violations.length, 1);
  assert.deepEqual(
    errorHandlingViolations(
      'fixture.ts',
      'try { run() } catch (error) { unit.fail(error); unit.schedule(run); }',
    ).violations,
    [],
  );
});
