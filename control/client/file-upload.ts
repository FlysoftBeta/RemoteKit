import type { FileUploadResult } from '../shared/product';
export interface DcFileBegin { uploadId: string; offsets: number[] }
export interface FileRpc {
    begin(requestId: string, files: File[]): Promise<DcFileBegin>;
    upload(uploadId: string, fileIndex: number, file: File, offset: number, signal: AbortSignal, progress: (bytes: number) => void): Promise<void>;
    commit(uploadId: string): Promise<FileUploadResult>;
    cancel(requestId: string, uploadId?: string): Promise<FileUploadResult>;
}
export function uploadFile(url: string, file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin || !/^\/api\/files\/[^/]+$/.test(target.pathname) || target.search || target.hash)
        return Promise.reject(new Error('上传地址无效'));
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const finish = (error?: Error) => { signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        xhr.open('POST', target.href);
        xhr.withCredentials = true;
        xhr.timeout = 120000;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => progress(Math.min(file.size, event.loaded));
        xhr.onload = () => finish(xhr.status === 204 ? undefined : new Error('文件未发送，请重试'));
        xhr.onerror = () => finish(new Error('文件未发送，请重试'));
        xhr.ontimeout = () => finish(new Error('文件发送超时，请重试'));
        xhr.onabort = () => finish(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        xhr.send(file);
    });
}
