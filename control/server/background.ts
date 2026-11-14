import { RetryUnit } from '../shared/retry-unit';
import { log, identifyError } from './log';
import { endpointError } from '../shared/errors';

export class BackgroundJob {
  readonly retry: RetryUnit;
  private pending?: Promise<void>;
  private closed = false;

  constructor(
    private readonly event: string,
    private readonly fields: Record<string, unknown>,
  ) {
    this.retry = new RetryUnit({
      failed: (error) =>
        log.warn(`${this.event}_failed`, {
          ...this.fields,
          code: error.code,
          errorId: error.errorId,
          err: error,
        }),
      recovered: () => log.info(`${this.event}_recovered`, this.fields),
    });
  }

  run(work: () => Promise<unknown>, input = ''): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!this.retry.ready(input)) return Promise.resolve();
    this.pending = this.retry
      .execute(input, async () => {
        try {
          return await work();
        } catch (cause) {
          throw identifyError(endpointError(cause));
        }
      })
      .then(() => {
        if (!this.closed)
          this.retry.schedule(() => {
            void this.run(work, input);
          });
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async close() {
    this.closed = true;
    this.retry.close();
    await this.pending;
  }
}
