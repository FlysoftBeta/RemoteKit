import type { FileRequest } from '../shared/product';

export type FileLimits = FileRequest['limits'];
export interface FileBinding {
  browserIncarnation: string;
  view: string;
  instance: string;
  document: string;
  request: string;
}
export interface InternalFileRequest extends FileRequest {
  binding: FileBinding;
}
export class FileRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
