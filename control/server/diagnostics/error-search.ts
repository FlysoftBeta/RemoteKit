import { createReadStream } from 'node:fs';
import limits from '../../../protocol/limits.json';
import { createInterface } from 'node:readline';
import { isErrorId, RemoteKitError, toRemoteKitError, wireError } from '../../shared/errors';
import type { NodeRegistry } from '../cluster/node-link';
import { log, logFiles, reportError } from '../log';

export async function findError(
  errorId: unknown,
  directory: string | undefined,
  nodes: Pick<NodeRegistry, 'all'>,
) {
  if (!isErrorId(errorId)) throw new RemoteKitError('invalid_request', '无效的错误 ID');
  const records: { source: string; line: string }[] = [];
  const failures: import('../../shared/admin').ErrorSearchResult['failures'] = [];
  if (!errorId.startsWith('e-')) {
    if (!directory) throw new RemoteKitError('unavailable', '日志目录未配置');
    for (const path of logFiles(directory)) {
      const input = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes(errorId)) continue;
          try {
            if (JSON.parse(line).errorId === errorId) records.push({ source: 'control', line });
          } catch {
            continue;
          }
          if (records.length === limits.logSearchLines) return { records, failures };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('diagnostics.search_failed', { path, errorId, err });
          throw err;
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
  } else {
    await Promise.all(
      nodes
        .all()
        .filter((node) => node.state.state === 'ready')
        .map(async (node) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            const result = (await Promise.race([
              node.request('node.logs.search', '', { errorId }, 5000),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new RemoteKitError('unavailable', '节点日志查询超时')), 5000);
              }),
            ])) as { lines: string[] };
            if (!Array.isArray(result?.lines) || result.lines.some((line) => typeof line !== 'string'))
              throw new RemoteKitError('internal', '节点日志查询结果无效');
            records.push(
              ...result.lines.slice(0, limits.logSearchLines).map((line) => ({ source: node.nodeId, line })),
            );
          } catch (err) {
            failures.push({
              nodeId: node.nodeId,
              error: wireError(
                reportError(toRemoteKitError(err), 'diagnostics.node_search_failed', {
                  nodeId: node.nodeId,
                  searchedErrorId: errorId,
                }),
              ),
            });
            log.warn('diagnostics.node_search_failed', { nodeId: node.nodeId, errorId, err });
          } finally {
            clearTimeout(timer);
          }
        }),
    );
  }
  return { records, failures };
}
