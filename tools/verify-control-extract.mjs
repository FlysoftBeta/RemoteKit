import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [metricsPath, runId, outputPath] = process.argv.slice(2);
if (!metricsPath || !runId || !outputPath)
  throw new Error('Usage: node verify-control-extract.mjs metrics.jsonl runId output-directory');
await mkdir(outputPath, { recursive: true });
for await (const line of createInterface({ input: createReadStream(metricsPath), crlfDelay: Infinity })) {
  if (!line.includes(runId)) continue;
  const record = JSON.parse(line),
    report = record.metrics;
  if (report?.runId !== runId) continue;
  const stage = String(report.stage).replace(/[^a-z0-9_-]/gi, '_');
  await writeFile(resolve(outputPath, stage + '.json'), JSON.stringify(record, null, 2));
  if (report.sourceJpeg)
    await writeFile(
      resolve(outputPath, stage + '-source.jpg'),
      Buffer.from(report.sourceJpeg.split(',')[1], 'base64'),
    );
  for (const [index, sample] of (report.changeStopSamples ?? []).entries())
    if (sample.textRoiPng)
      await writeFile(
        resolve(outputPath, `${stage}-roi-${index}.png`),
        Buffer.from(sample.textRoiPng.split(',')[1], 'base64'),
      );
  console.log(
    JSON.stringify({
      stage,
      stimulus: report.stimulus,
      ctrlL: report.ctrlL,
      decoded: report.video?.decodedFrames,
      samples: report.changeStopSamples?.length,
    }),
  );
}
