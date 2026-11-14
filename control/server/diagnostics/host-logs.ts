import { open, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { localDate } from '../log';

export const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export interface LogFile {
  path: string;
  size: number;
  mtime: number;
}
export function retentionBound(days: number, now = new Date()) {
  const bound = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  bound.setDate(bound.getDate() - days);
  return bound;
}
export async function children(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}
export async function hostDays(directory: string, days = 365, now = new Date()) {
  const bound = localDate(retentionBound(days, now));
  return (await children(directory))
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && datePattern.test(entry.name) && entry.name >= bound,
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
}
async function walk(directory: string, relative: string, recursive: boolean): Promise<LogFile[]> {
  const files: LogFile[] = [];
  for (const entry of await children(join(directory, relative))) {
    if (entry.isSymbolicLink()) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
    else if (info.isDirectory() && recursive) files.push(...(await walk(directory, path, true)));
  }
  return files;
}
export async function hostFiles(directory: string, date: string, days = 365) {
  const files: LogFile[] = [];
  for (const day of await hostDays(directory, days)) {
    if (day > date) continue;
    files.push(
      ...(await walk(directory, day, false)).filter(
        (file) => day === date || localDate(new Date(file.mtime)) === date,
      ),
    );
  }
  files.push(
    ...(await walk(directory, 'crashes', true)).filter((file) => localDate(new Date(file.mtime)) === date),
  );
  return files.sort(
    (a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path, undefined, { numeric: true }),
  );
}
export async function readHostFile(directory: string, path: string, offset: number, length: number) {
  if (
    !/^(?:\d{4}-\d{2}-\d{2}\/[^/]+|crashes\/(?:[^/]+\/)+[^/]+)$/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.' || part.includes('\\') || part.includes(':'))
  )
    throw new Error('invalid log path');
  let current = resolve(directory);
  for (const part of path.split('/')) {
    current = join(current, part);
    if (!(current + sep).startsWith(resolve(directory) + sep) || (await lstat(current)).isSymbolicLink())
      throw new Error('invalid log path');
  }
  const file = await open(current, 'r');
  try {
    const { size } = await file.stat();
    const data = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await file.read(data, count, data.length - count, offset + count);
      if (!bytesRead) throw new Error('incomplete log file');
      count += bytesRead;
    }
    return { path, offset, size, data };
  } finally {
    await file.close();
  }
}
export async function pruneHostLogs(directory: string, days: number, now = new Date()) {
  const bound = retentionBound(days, now);
  for (const entry of await children(directory)) {
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      datePattern.test(entry.name) &&
      entry.name < localDate(bound)
    ) {
      const target = resolve(directory, entry.name);
      if (!target.startsWith(resolve(directory) + sep)) throw new Error('invalid retention path');
      await rm(target, { recursive: true, force: true });
    }
  }
  for (const file of await walk(directory, 'crashes', true))
    if (file.mtime < bound.getTime()) await rm(join(directory, file.path));
}
