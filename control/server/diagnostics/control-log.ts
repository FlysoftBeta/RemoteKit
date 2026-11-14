import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { children, hostDays, type LogFile } from './host-logs';

export async function controlLogFiles(directory: string, days = 30) {
  const files: LogFile[] = [];
  for (const day of await hostDays(directory, days)) {
    const parts: LogFile[] = [];
    for (const entry of await children(join(directory, day))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^control(?:\.\d+)?\.jsonl$/.test(entry.name))
        continue;
      const info = await lstat(join(directory, day, entry.name));
      if (info.isSymbolicLink()) continue;
      parts.push({ path: `${day}/${entry.name}`, size: info.size, mtime: info.mtimeMs });
    }
    parts.sort(
      (a, b) =>
        Number(/control\.(\d+)\.jsonl$/.exec(b.path)?.[1] ?? 0) -
        Number(/control\.(\d+)\.jsonl$/.exec(a.path)?.[1] ?? 0),
    );
    files.push(...parts);
  }
  return files;
}
