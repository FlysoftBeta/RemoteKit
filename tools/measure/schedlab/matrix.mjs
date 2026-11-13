import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argsOf, defaultMix, geometry, outputRoot, run } from './run.mjs';
import { summaryTable } from './summarize.mjs';

export function grid(options = {}) {
  const geometries = (options.geometries ?? 'F,T').split(',');
  const counts = (options.tenants ?? '1,5').split(',').map(Number);
  const mixes = options.mixes?.split(';') ?? ['scroll+video'];
  return geometries.flatMap((shape) => {
    geometry(shape);
    return counts.flatMap((count) => {
      if (!Number.isInteger(count) || count < 1) throw Error('Invalid tenant count');
      return mixes.map((mix) => {
        const workloads =
          mix === 'scroll+video'
            ? defaultMix(count).map((kind) => (kind.startsWith('U') || kind === 'static' ? 'S4' : kind))
            : mix.split(',');
        if (workloads.length !== count)
          throw Error(`Mix ${mix} has ${workloads.length} tenants, expected ${count}`);
        return { geometry: shape, tenants: count, mix: workloads.join(',') };
      });
    });
  });
}
export async function matrix(options) {
  const cases = grid(options);
  if (options['dry-run']) {
    for (const item of cases) console.log(JSON.stringify(item));
    return;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const parent = resolve(options.out ?? join(outputRoot, `${stamp}-matrix`));
  mkdirSync(parent, { recursive: true });
  const summaries = [];
  writeFileSync(join(parent, 'matrix.json'), JSON.stringify({ cases, runs: [] }, null, 2));
  for (let index = 0; index < cases.length; ++index) {
    const item = cases[index];
    const label = `${item.geometry}-n${item.tenants}-${index}`;
    const summary = await run({ ...options, ...item, label, out: join(parent, label) });
    summaries.push(summary);
    writeFileSync(
      join(parent, 'matrix.json'),
      JSON.stringify({ cases, runs: summaries.map((row) => row.label) }, null, 2),
    );
    writeFileSync(join(parent, 'matrix.md'), '# schedlab matrix\n\n' + summaryTable(summaries) + '\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  matrix(argsOf(process.argv.slice(2))).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
