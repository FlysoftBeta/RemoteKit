import { open } from 'node:fs/promises';
import { log, logFiles } from '../log';

export async function controlLogTail(directory: string, budget = 4 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let total = 0;
  for (const path of logFiles(directory).slice(0, 2)) {
    const file = await open(path, 'r').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      log.warn('diagnostics.control_log_failed', { path, err });
      throw err;
    });
    if (!file) continue;
    try {
      const { size } = await file.stat();
      total += size;
      const length = Math.min(size, budget - bytes);
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await file.read(chunk, read, length - read, size - length + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      chunks.unshift(chunk.subarray(0, read));
      bytes += read;
    } finally {
      await file.close();
    }
  }
  return { data: Buffer.concat(chunks), dropped: total - bytes };
}
