import { isErrorId, type ErrorCode } from './errors';

export interface ClientErrorReport {
  errorId: string;
  context: Record<string, unknown>;
  error: { name: string; message: string; code?: ErrorCode; reason?: string; stack?: string };
}

export function isClientErrorReport(value: unknown): value is ClientErrorReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as ClientErrorReport;
  return (
    isErrorId(report.errorId) &&
    report.errorId.startsWith('v-') &&
    !!report.context &&
    typeof report.context === 'object' &&
    !Array.isArray(report.context) &&
    !!report.error &&
    typeof report.error.name === 'string' &&
    typeof report.error.message === 'string' &&
    (report.error.stack === undefined || typeof report.error.stack === 'string') &&
    (report.error.reason === undefined || typeof report.error.reason === 'string')
  );
}
