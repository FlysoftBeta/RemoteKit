import type { FileBinding } from './endpoint/types';
import type { FileRequest } from '../shared/product';

export type FileLimits = FileRequest['limits'];
export interface InternalFileRequest extends FileRequest {
  binding: FileBinding;
}
