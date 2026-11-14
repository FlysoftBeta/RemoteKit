import { localDate } from '../server/log';

export function logNode(files: Map<string, Buffer>, overrides: Map<string, number> = new Map()) {
  const reads: { path: string; offset: number; length: number }[] = [];
  return {
    nodeId: 'node',
    state: { state: 'ready' },
    reads,
    request: async (method: string, _tenant: string, params: any) => {
      if (method === 'node.logs.days') return { days: [localDate()] };
      if (method === 'node.logs.list')
        return {
          files: [...files].map(([path, bytes], index) => ({
            path,
            size: overrides.get(path) ?? bytes.length,
            mtime: Date.now() - index,
          })),
        };
      if (method === 'node.logs.read') {
        reads.push(params);
        const bytes = files.get(params.path);
        if (!bytes) throw new Error('missing file');
        return {
          path: params.path,
          offset: params.offset,
          size: bytes.length,
          data: bytes.subarray(params.offset, params.offset + params.length),
        };
      }
      throw new Error('unexpected log method: ' + method);
    },
  };
}
