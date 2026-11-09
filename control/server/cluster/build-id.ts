import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteKitError } from '../../shared/errors';

export function readBuildId(controlRoot: string): string {
  let contents: string;
  try {
    contents = readFileSync(resolve(controlRoot, '../build.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'dev';
    throw error;
  }
  try {
    const value = JSON.parse(contents);
    if (!value || Object.keys(value).join() !== 'buildId' || !/^[0-9a-f]{64}$/.test(value.buildId))
      throw new Error();
    return value.buildId;
  } catch {
    throw new RemoteKitError('invalid_request', '构建信息无效', { detail: 'Invalid build.json' });
  }
}
