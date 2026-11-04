import type { FileUploadResult } from '../shared/product';
import type { Asset, SelectionState } from '../shared/file-library';
import type { DcFileBegin, FileRpc } from './file-upload';
import { operationId } from './product-operations';

export interface PhotoRank {
    selectedAssetId: string;
    uncertain: boolean;
    candidates: { assetId: string; score: number }[];
    reason: string;
}

const libraryBinding = { requestId: 'library' };

function checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** File bytes and transaction commands share the current authenticated RTC peer.
 * A new peer interrupts the transfer; drafts are never silently resumed there. */
export class DcFileClient implements FileRpc {
    private pending = new Map<string, { channel: RTCDataChannel; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private uploads = new Map<string, { requestId: string; channel: RTCDataChannel }>();
    constructor(private readonly getChannel: () => RTCDataChannel | null, private readonly getAuthEpoch = (): number | undefined => undefined) {}
    handle(message: any): boolean {
        if (message?.type !== 'files.result') return false;
        if (message.version !== 1 || typeof message.requestId !== 'string') return true;
        const entry = this.pending.get(message.requestId);
        if (!entry || entry.channel !== this.getChannel()) return true;
        clearTimeout(entry.timer); this.pending.delete(message.requestId);
        if (message.ok === true) entry.resolve(message.result);
        else entry.reject(new Error(typeof message.error === 'string' ? message.error : '文件发送失败'));
        return true;
    }
    disconnect() {
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('连接中断，请重新选择文件')); }
        this.pending.clear(); this.uploads.clear();
    }
    private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
        const channel = this.getChannel();
        const authEpoch = this.getAuthEpoch();
        if (channel?.readyState !== 'open') throw new Error('连接中断，请恢复连接后重试');
        if (this.pending.size >= 8) throw new Error('文件发送繁忙，请稍后重试');
        // Input/layout retain queue headroom. Polling also works on Chrome89,
        // without replacing transport's existing bufferedamountlow handler.
        const deadline = performance.now() + 15000;
        while (channel.bufferedAmount > 64 * 1024) {
            if (channel !== this.getChannel() || authEpoch !== this.getAuthEpoch() || channel.readyState !== 'open') throw new Error('连接中断，请重新选择文件');
            if (performance.now() > deadline) throw new Error('文件发送暂时拥塞，请重试');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (channel !== this.getChannel() || authEpoch !== this.getAuthEpoch()) throw new Error('连接中断，请重试');
        const requestId = operationId();
        const encoded = JSON.stringify({ type: 'files.request', version: 1, requestId, method, params, authEpoch });
        // Wire byte bound includes multibyte filenames and MIME strings.
        if (new TextEncoder().encode(encoded).byteLength > (method === 'begin' ? 61440 : 24576)) throw new Error('文件信息过长，请减少文件数量');
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('文件确认超时，请重试确认')); }, 20000);
            this.pending.set(requestId, { channel, resolve, reject, timer });
            try { channel.send(encoded); }
            catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('连接中断，请重新选择文件')); }
        });
    }
    async begin(requestId: string, files: File[]): Promise<DcFileBegin> {
        const channel = this.getChannel();
        const authEpoch = this.getAuthEpoch();
        const result = await this.call<DcFileBegin>('begin', { requestId, files: files.map(file => ({ name: file.name, type: file.type, size: file.size })) });
        if (!result || typeof result.uploadId !== 'string' || !Array.isArray(result.offsets) || result.offsets.length !== files.length || result.offsets.some((offset, index) => !Number.isSafeInteger(offset) || offset < 0 || offset > files[index].size)) throw new Error('文件发送状态无效');
        if (channel !== this.getChannel() || authEpoch !== this.getAuthEpoch() || !channel) throw new Error('连接中断，请重新选择文件');
        this.uploads.set(result.uploadId, { requestId, channel });
        return result;
    }
    private binding(uploadId: string) {
        const value = this.uploads.get(uploadId);
        if (!value || value.channel !== this.getChannel()) throw new Error('文件发送已中断，请取消后重新选择');
        return { requestId: value.requestId, uploadId };
    }
    async upload(uploadId: string, fileIndex: number, file: File, offset: number, signal: AbortSignal, progress: (bytes: number) => void) {
        const binding = this.binding(uploadId);
        const authEpoch = this.getAuthEpoch();
        // One chunk per file is in flight. This also preserves sequential disk
        // offsets; the protocol admits up to four concurrent chunks per client.
        for (let position = offset; position < file.size;) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const bytes = new Uint8Array(await file.slice(position, position + 16384).arrayBuffer());
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (authEpoch !== this.getAuthEpoch() || !this.uploads.has(uploadId)) throw new Error('连接中断，请重新选择文件');
            let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
            const result = await this.call<{ offset: number }>('chunk', { ...binding, fileIndex, offset: position, data: btoa(text) });
            if (result.offset !== position + bytes.length) throw new Error('文件接收进度不一致，请重试');
            position = result.offset; progress(position);
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        progress(file.size);
    }
    async commit(uploadId: string): Promise<FileUploadResult> {
        const result = await this.call<FileUploadResult>('commit', this.binding(uploadId));
        if (result.state === 'selected' || result.state === 'cancelled') this.uploads.delete(uploadId);
        return result;
    }
    async status(uploadId: string): Promise<{ state: string; offsets: number[] }> { return this.call('status', this.binding(uploadId)); }
    async cancel(requestId: string, uploadId?: string): Promise<FileUploadResult> {
        // Binding cancellation works after a lost begin reply or reconnection;
        // an old uploadId must not claim another peer's draft.
        const owned = uploadId ? this.uploads.get(uploadId) : undefined;
        const result = await this.call<FileUploadResult>('cancel', { requestId, ...(owned?.channel === this.getChannel() ? { uploadId } : {}) });
        if (result.state !== 'validating' && uploadId) this.uploads.delete(uploadId);
        return result;
    }
    async uploadAsset(file: File, operationId: string, signal: AbortSignal): Promise<Asset> {
        const channel = this.getChannel(), epoch = this.getAuthEpoch();
        const check = () => {
            checkAbort(signal);
            if (channel !== this.getChannel() || epoch !== this.getAuthEpoch()) throw new Error('连接中断，请重试');
        };
        check();
        const { uploadId, offset } = await this.call<{ uploadId: string; offset: number }>('asset.begin', {
            ...libraryBinding, operationId, name: file.name, type: file.type, size: file.size,
        });
        try {
            check();
            if (typeof uploadId !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('文件发送状态无效');
            for (let position = offset; position < file.size;) {
                const bytes = new Uint8Array(await file.slice(position, position + 16384).arrayBuffer());
                check();
                let binary = '';
                for (const byte of bytes) binary += String.fromCharCode(byte);
                const result = await this.call<{ offset: number }>('asset.chunk', {
                    ...libraryBinding, uploadId, offset: position, data: btoa(binary),
                });
                if (result.offset !== position + bytes.length) throw new Error('文件接收进度不一致');
                position = result.offset;
                check();
            }
            const asset = await this.call<Asset>('asset.seal', { ...libraryBinding, uploadId });
            check();
            return asset;
        } catch (error) {
            if (signal.aborted && channel === this.getChannel() && epoch === this.getAuthEpoch()) {
                void this.call('asset.cancel', { ...libraryBinding, uploadId }).catch(() => {});
            }
            throw error;
        }
    }
    async readPhoto(asset: Asset, signal: AbortSignal): Promise<Blob> {
        const channel = this.getChannel(), epoch = this.getAuthEpoch();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 20 * 1024 * 1024) throw new Error('照片预览大小超出限制');
        for (let offset = 0; offset < asset.size;) {
            checkAbort(signal);
            if (channel !== this.getChannel() || epoch !== this.getAuthEpoch()) throw new Error('连接中断，请重试');
            const part = await this.call<{ data: string; offset: number; total: number }>('asset.read', {
                ...libraryBinding, assetId: asset.assetId, offset,
            });
            const binary = atob(part.data);
            if (!binary.length || binary.length > 16384 || part.offset !== offset + binary.length || part.total !== asset.size || part.offset > part.total) throw new Error('照片预览数据无效');
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            parts.push(bytes);
            offset = part.offset;
        }
        checkAbort(signal);
        if (channel !== this.getChannel() || epoch !== this.getAuthEpoch()) throw new Error('连接中断，请重试');
        return new Blob(parts, { type: asset.type });
    }
    rankPhotos(assetIds: string[]): Promise<PhotoRank> {
        return this.call('photo.rank', { ...libraryBinding, assetIds });
    }
    async photoThumbnail(assetId: string, signal: AbortSignal): Promise<Blob> {
        checkAbort(signal);
        const asset = await this.call<Asset>('photo.thumbnail', { ...libraryBinding, assetId });
        if (asset.type !== 'image/jpeg' || asset.size > 65536 ||
            (asset.width ?? 0) > 320 || (asset.height ?? 0) > 320) throw new Error('照片缩略图数据无效');
        return this.readPhoto(asset, signal);
    }
    processPhoto(assetId: string, mode: 'rectify' | 'scan'): Promise<Asset> {
        return this.call('photo.process', { ...libraryBinding, assetId, mode });
    }
    commitSelection(requestId: string, selectionId: string): Promise<{ state: SelectionState; selectionId: string }> {
        return this.call('selection.commit', { requestId, selectionId });
    }
}
