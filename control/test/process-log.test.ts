import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ProcessLog } from '../server/diagnostics/process-log';

test('process log tees writes and keeps only the newest bytes within capacity', () => {
  const log = new ProcessLog(16);
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  const passed: Buffer[] = [];
  (stream as unknown as PassThrough).on('data', (chunk: Buffer) => passed.push(chunk));
  log.install([stream]);
  stream.write('0123456789');
  stream.write(Buffer.from('abcdef'));
  assert.deepEqual(log.snapshot(), { data: Buffer.from('0123456789abcdef'), dropped: 0 });
  stream.write('XYZ');
  assert.deepEqual(log.snapshot(), { data: Buffer.from('3456789abcdefXYZ'), dropped: 3 });
  log.append(Buffer.from('z'.repeat(20)));
  assert.deepEqual(log.snapshot(), { data: Buffer.from('z'.repeat(16)), dropped: 23 });
  assert.equal(Buffer.concat(passed).toString(), '0123456789abcdefXYZ');
});
