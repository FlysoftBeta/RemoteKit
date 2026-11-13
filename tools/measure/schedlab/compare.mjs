import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function runs(directory) {
  if (existsSync(join(directory, 'summary.json')))
    return [{ directory, summary: JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')) }];
  return readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(directory, item.name, 'summary.json')))
    .flatMap((item) => runs(join(directory, item.name)));
}
export function compare(directories) {
  if (directories.length < 2) throw Error('Pass at least two run or matrix directories');
  const groups = directories.map((directory) => runs(resolve(directory)));
  const metrics = {
    'L50 ms': (a) => a.latencyMs.p50,
    'L95 ms': (a) => a.latencyMs.p95,
    'L99 ms': (a) => a.latencyMs.p99,
    'Lmax ms': (a) => a.latencyMs.max,
    'Scroll start p95 ms': (a) => a.scrollStartMs.p95,
    'Scroll FPS': (a) => a.scrollFps,
    'Video FPS': (a) => a.videoFps,
    'Update p95 ms': (a) => a.updateContentMs.p95,
    'Gaps/min': (a) => a.arrivalGapsPerMinute,
    'Spikes/min': (a) => a.latencySpikesPerMinute,
    'Normal grants': (a) => a.admission.normal.grants,
    'Normal wait p95 ms': (a) => a.admission.normal.waitMs.p95,
    'Interactive grants': (a) => a.admission.interactive.grants,
    'Interactive wait p95 ms': (a) => a.admission.interactive.waitMs.p95,
    'GPU encode %': (a) => a.gpu.VideoEncode.mean,
  };
  const key = (summary) =>
    JSON.stringify(summary.case && [summary.case.geometry, summary.case.count, summary.case.mix]);
  const lines = ['| Run | Case | Metric | Value | Delta | Delta % |', '|---|---|---|---:|---:|---:|'];
  const n = (value) => (Number.isFinite(value) ? value.toFixed(2) : '-');
  for (let i = 0; i < groups.length; ++i) {
    for (const { summary } of groups[i]) {
      const baseline =
        groups[0].find((row) => key(row.summary) === key(summary))?.summary ??
        (groups[0].length === 1 ? groups[0][0].summary : null);
      for (const [name, metric] of Object.entries(metrics)) {
        const value = metric(summary.aggregate),
          before = baseline ? metric(baseline.aggregate) : null;
        const delta = Number.isFinite(value) && Number.isFinite(before) ? value - before : null;
        lines.push(
          `| ${basename(directories[i])} | ${summary.label} | ${name} | ${n(value)} | ${n(delta)} | ${n(delta !== null && before ? (delta / before) * 100 : null)} |`,
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(compare(process.argv.slice(2)));
}
