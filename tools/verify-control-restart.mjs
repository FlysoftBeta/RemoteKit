import { open, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const endpoint = resolve(argument('--endpoint')),
  metrics = resolve(argument('--metrics')),
  output = argument('--output'),
  timeoutMs = Number(argument('--timeout') ?? 180) * 1000;
if (!endpoint.toLowerCase().endsWith('endpoint_service.exe'))
  throw new Error('Only a copied endpoint_service.exe can be targeted');
let position = await stat(metrics)
    .then((info) => info.size)
    .catch(() => 0),
  partial = '',
  decoder = new StringDecoder('utf8');
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const size = await stat(metrics)
    .then((info) => info.size)
    .catch(() => 0);
  if (size < position) {
    position = 0;
    partial = '';
    decoder = new StringDecoder('utf8');
  }
  if (size > position) {
    const file = await open(metrics, 'r');
    const bytes = Buffer.alloc(size - position);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    await file.close();
    position += bytesRead;
    partial += decoder.write(bytes.subarray(0, bytesRead));
    let end;
    while ((end = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, end);
      partial = partial.slice(end + 1);
      if (!line.includes('restart-ready')) continue;
      const record = JSON.parse(line);
      if (
        record.metrics?.kind !== 'ui-functional-stage' ||
        record.metrics.stage !== 'restart-ready' ||
        !record.metrics.runId?.startsWith('ui-functional-')
      )
        continue;
      const script =
        'Get-CimInstance Win32_Process -Filter "name=\'endpoint_service.exe\'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $env:REMOTEKIT_TEST_ENDPOINT } | Select-Object ProcessId | ConvertTo-Json -Compress';
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, env: { ...process.env, REMOTEKIT_TEST_ENDPOINT: endpoint } },
      );
      const found = JSON.parse(stdout || '[]'),
        matches = Array.isArray(found) ? found : [found];
      if (matches.length !== 1) throw new Error(`Expected one copied endpoint, found ${matches.length}`);
      const pid = matches[0].ProcessId;
      process.kill(pid);
      const result = {
        killedPid: pid,
        path: endpoint,
        runId: record.metrics.runId,
        at: new Date().toISOString(),
      };
      if (output) await writeFile(output, JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      process.exit(0);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error('Timed out waiting for this UI experiment restart-ready stage');
