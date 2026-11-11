import { log } from '../log';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Same file and rotation as the node updater (endpoint/updater/logging.cpp), so
// `<node root>/logs/endpoint.log` exists whichever launcher runs the Endpoint.
const limit = 16 * 1024 * 1024;
const rotations = 4;

export class EndpointLog {
  private queue: Promise<void>;
  private size?: number;
  private failed = false;

  constructor(private readonly path: string) {
    this.queue = mkdir(dirname(path), { recursive: true }).then(() => {});
  }

  write(bytes: Buffer) {
    this.queue = this.queue
      .then(async () => {
        await this.append(bytes);
        this.failed = false;
      })
      .catch((err) => {
        if (!this.failed) log.warn('endpoint_log.write_failed', { path: this.path, err });
        this.failed = true;
      });
  }

  flush() {
    return this.queue;
  }

  private async append(bytes: Buffer) {
    this.size ??= await stat(this.path).then(
      (info) => info.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      },
    );
    while (bytes.length) {
      if (this.size >= limit) {
        await this.rotate();
        this.size = 0;
      }
      const chunk = bytes.subarray(0, limit - this.size);
      await appendFile(this.path, chunk);
      this.size += chunk.length;
      bytes = bytes.subarray(chunk.length);
    }
  }

  private async rotate() {
    for (let i = rotations; i >= 1; i--) {
      const target = `${this.path}.${i}`;
      await rm(target, { force: true });
      const source = i === 1 ? this.path : `${this.path}.${i - 1}`;
      await rename(source, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
