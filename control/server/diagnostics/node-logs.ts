import type { NodeLink } from '../cluster/node-link';
import { array, integer, number, object, string } from '../persistence/codec';
import type { LogFile } from './host-logs';

export const logReadBytes = 524288;
const date = string({ pattern: /^\d{4}-\d{2}-\d{2}$/ });
const path = string({ pattern: /^(?:\d{4}-\d{2}-\d{2}\/[^/\\:]+|crashes\/(?:[^/\\:]+\/)+[^/\\:]+)$/ });
const count = integer({ min: 0 });
const daysResult = object({ days: array(date) });
const listResult = object({
  files: array(object({ path, size: count, mtime: number({ min: 0, max: Number.MAX_SAFE_INTEGER }) })),
});
type Client = Pick<NodeLink, 'request'>;
export async function nodeLogDays(node: Client, timeoutMs?: number): Promise<string[]> {
  return daysResult.read(await node.request('node.logs.days', '', {}, timeoutMs), 'node.logs.days').days;
}
export async function nodeLogList(node: Client, date: string, timeoutMs?: number): Promise<LogFile[]> {
  return listResult.read(await node.request('node.logs.list', '', { date }, timeoutMs), 'node.logs.list')
    .files;
}
export async function nodeLogRead(
  node: Client,
  path: string,
  offset: number,
  length: number,
  timeoutMs?: number,
) {
  if (!Number.isSafeInteger(length) || length < 0 || length > logReadBytes)
    throw new Error('invalid log length');
  const result = await node.request('node.logs.read', '', { path, offset, length }, timeoutMs);
  const { data, ...header } = result;
  object({ path: string(), offset: count, size: count }).read(header, 'node.logs.read');
  if (
    !Buffer.isBuffer(data) ||
    header.path !== path ||
    header.offset !== offset ||
    data.length !== Math.min(length, Math.max(0, header.size - offset))
  )
    throw new Error('invalid log read reply');
  return { path, offset, size: header.size as number, data: data as Buffer };
}
