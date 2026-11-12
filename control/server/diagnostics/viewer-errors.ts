import { isClientErrorReport } from '../../shared/viewer-error';
import { log } from '../log';

export class ViewerErrors {
  private readonly seen = new Set<string>();

  receive(value: unknown, tenant: string, lease: string) {
    if (!isClientErrorReport(value)) return false;
    if (this.seen.has(value.errorId)) return true;
    this.seen.add(value.errorId);
    log.error('viewer.error', {
      tenant,
      lease,
      errorId: value.errorId,
      context: value.context,
      err: value.error,
    });
    return true;
  }
}

export const viewerErrorReports = new ViewerErrors();
