import { RetryUnit } from '../../shared/retry-unit';
import type { RemoteKitError } from '../../shared/errors';
import type { DocumentProgress } from './document-source';

export class DocumentProgressWriter {
  private readonly retry = new RetryUnit({ name: 'document_progress' });
  private latest?: { input: string; progress: DocumentProgress };
  private acknowledged?: string;
  private pending = false;
  private closed = false;
  constructor(
    private readonly write: (progress: DocumentProgress) => Promise<unknown>,
    private readonly changed: (error: RemoteKitError | undefined) => void,
  ) {}
  save(progress: DocumentProgress) {
    if (this.closed) return;
    const input = JSON.stringify(progress);
    this.latest = { input, progress: { ...progress } };
    void this.run();
  }
  private async run() {
    const latest = this.latest;
    if (
      this.closed ||
      this.pending ||
      !latest ||
      this.acknowledged === latest.input ||
      !this.retry.ready(latest.input)
    )
      return;
    this.pending = true;
    try {
      await this.write(latest.progress);
      if (this.closed) return;
      this.acknowledged = latest.input;
      this.retry.succeed();
      this.changed(undefined);
    } catch (cause) {
      if (this.closed) return;
      const failure = this.retry.fail(cause);
      this.changed(failure.error);
      this.retry.schedule(() => {
        void this.run();
      });
    } finally {
      this.pending = false;
      if (this.latest?.input !== latest.input) void this.run();
    }
  }
  dispose() {
    this.closed = true;
    this.retry.cancel();
  }
}
