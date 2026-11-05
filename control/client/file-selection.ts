import type { FileRequest } from '../shared/product';
export function fileChooserAccept(request: Pick<FileRequest, 'accept' | 'acceptTypesOmitted'>): string[] {
  return request.acceptTypesOmitted ? [] : request.accept;
}
export function validateSelection(files: Pick<File, 'size'>[], request: FileRequest): string {
  if (!files.length) return '请先选择文件';
  if (files.length > (request.multiple ? request.limits.maxFiles : 1)) return '选择的文件数量过多';
  // accept is the native picker's hint, not a MIME-based rejection rule.
  if (files.some((file) => file.size > request.limits.maxFileBytes)) return '单个文件超出允许大小';
  if (files.reduce((total, file) => total + file.size, 0) > request.limits.maxBatchBytes)
    return '所选文件总大小超出限制';
  return '';
}
