import type { FileRequest } from '../shared/product';
export function acceptsFile(file: Pick<File, 'name' | 'type'>, accept: string[]) {
    if (!accept.length)
        return true;
    return accept.some(raw => { const rule = raw.trim().toLowerCase(); return rule === '*/*' || (rule.startsWith('.') ? file.name.toLowerCase().endsWith(rule) : rule.endsWith('/*') ? file.type.toLowerCase().startsWith(rule.slice(0, -1)) : file.type.toLowerCase() === rule); });
}
export function cameraFormat(accept: string[]): 'image/jpeg' | 'image/png' | null {
    if (acceptsFile({ name: 'photo.jpg', type: 'image/jpeg' }, accept))
        return 'image/jpeg';
    if (acceptsFile({ name: 'photo.png', type: 'image/png' }, accept))
        return 'image/png';
    return null;
}
export function validateSelection(files: File[], request: FileRequest): string {
    if (!files.length)
        return '请先选择文件';
    if (files.length > (request.multiple ? request.limits.maxFiles : 1))
        return '选择的文件数量过多';
    // accept is the native picker's hint, not a MIME-based rejection rule.
    if (files.some(file => file.size > request.limits.maxFileBytes))
        return '单个文件超出允许大小';
    if (files.reduce((total, file) => total + file.size, 0) > request.limits.maxBatchBytes)
        return '所选文件总大小超出限制';
    return '';
}
export function mergeSelection(previous: File[], next: File[], multiple: boolean) {
    if (!multiple)
        return next.slice(0, 1);
    const result = [...previous];
    for (const file of next)
        if (!result.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified && existing.type === file.type))
            result.push(file);
    return result;
}
export function combineSelection(files:File[],photos:File[],multiple:boolean){
    return photos.length?mergeSelection(files,photos,multiple):files;
}
