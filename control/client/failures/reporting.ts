import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { ClientErrorReport } from '../../shared/viewer-error';

export class ViewerErrorReports {
  private pending: ClientErrorReport[] = [];
  private sender?: (report: ClientErrorReport) => void;
  private readonly reported = new WeakSet<Error>();

  identify(error: RemoteKitError, context: Record<string, unknown>) {
    if (error.errorId && !error.errorId.startsWith('v-')) return error;
    if (!error.errorId) {
      const bytes = new Uint8Array(5);
      globalThis.crypto.getRandomValues(bytes);
      error.errorId = 'v-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    if (!this.reported.has(error)) {
      this.reported.add(error);
      const source = error.cause instanceof Error ? error.cause : error;
      this.pending.push({
        errorId: error.errorId,
        context,
        error: {
          name: source.name,
          message: source.message,
          code: error.code,
          reason: error.reason,
          stack: source.stack,
        },
      });
      if (this.pending.length > 50) this.pending.shift();
      this.flush();
    }
    return error;
  }

  connect(sender?: (report: ClientErrorReport) => void) {
    this.sender = sender;
    this.flush();
  }

  private flush() {
    while (this.sender && this.pending.length) {
      try {
        this.sender(this.pending[0]);
        this.pending.shift();
      } catch {
        this.sender = undefined;
      }
    }
  }

  get queued() {
    return this.pending.length;
  }
}

export const viewerErrors = new ViewerErrorReports();

export function failureError(error: unknown): RemoteKitError {
  return toRemoteKitError(error);
}
