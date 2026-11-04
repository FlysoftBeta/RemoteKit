import test from 'node:test';
import assert from 'node:assert/strict';
import { DcFileClient } from '../client/dc-file-client';

function fixture() {
    const sent: any[] = [];
    let respond = true;
    const channel = { readyState: 'open', bufferedAmount: 0, send: (text: string) => {
        const message = JSON.parse(text); sent.push(message);
        if (!respond) return;
        const result = message.method === 'begin' ? { uploadId: 'batch', offsets: message.params.files.map(() => 0) }
            : message.method === 'chunk' ? { offset: message.params.offset + Buffer.from(message.params.data, 'base64').length }
                : { state: 'cancelled' };
        queueMicrotask(() => client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }));
    } } as unknown as RTCDataChannel;
    let current: RTCDataChannel | null = channel;
    const client = new DcFileClient(() => current);
    return { client, channel, sent, hold: () => { respond = false; }, replace: () => { current = null; } };
}
test('DC file bytes use bounded chunks and advance progress only after received ACK', async () => {
    const { client, sent } = fixture();
    const file = new File([new Uint8Array(40000).map((_, index) => index % 251)], 'bytes.dat');
    const begin = await client.begin('opaque', [file]);
    const progress: number[] = [];
    await client.upload(begin.uploadId, 0, file, begin.offsets[0], new AbortController().signal, value => progress.push(value));
    const chunks = sent.filter(message => message.method === 'chunk');
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map(message => message.params.offset), [0, 16384, 32768]);
    assert.ok(chunks.every(message => Buffer.from(message.params.data, 'base64').length <= 16384));
    assert.deepEqual(Buffer.concat(chunks.map(message => Buffer.from(message.params.data, 'base64'))), Buffer.from(await file.arrayBuffer()));
    assert.equal(progress[progress.length - 1], file.size);
    assert.ok(sent.every(message => message.type === 'files.request' && message.params.requestId === 'opaque'));
    assert.ok(sent.every(message => !JSON.stringify(message).includes('path')));
});
test('abort prevents further chunk sends; cancel after lost begin uses request binding', async () => {
    const { client, sent } = fixture();
    const file = new File(['data'], 'a.txt');
    await client.begin('opaque', [file]);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(client.upload('batch', 0, file, 0, abort.signal, () => {}), { name: 'AbortError' });
    assert.equal(sent.filter(message => message.method === 'chunk').length, 0);
    await client.cancel('opaque', 'lost-unrecorded-batch');
    assert.deepEqual(sent[sent.length - 1].params, { requestId: 'opaque' });
    client.disconnect();
    await client.cancel('opaque', 'batch');
    assert.deepEqual(sent[sent.length - 1].params, { requestId: 'opaque' });
});
test('peer replacement rejects pending transaction and never reuses its upload', async () => {
    const f = fixture();
    await f.client.begin('opaque', [new File(['data'], 'a.txt')]);
    f.hold(); const pending = f.client.commit('batch');
    f.replace();
    f.client.handle({ type: 'files.result', version: 1, requestId: f.sent[f.sent.length - 1].requestId, ok: true, result: { state: 'selected' } });
    f.client.disconnect();
    await assert.rejects(pending, /连接中断/);
    await assert.rejects(f.client.commit('batch'), /已中断/);
});

test('library asset transfer resumes from the Endpoint offset and uses the library binding only', async () => {
    const data = new Uint8Array(40000).map((_, index) => index % 251);
    const file = new File([data], '照片.jpg', { type: 'image/jpeg' });
    const signal = new AbortController().signal;
    const asset = { assetId: 'sealed', hash: 'hash', size: data.byteLength, type: file.type };
    const messages: { method: string; params: any; authEpoch: number }[] = [];
    const channel = {
        readyState: 'open', bufferedAmount: 0,
        send(text: string) {
            const message = JSON.parse(text);
            messages.push(message);
            const offset = message.params.offset;
            const part = data.subarray(offset, offset + 16384);
            const result = message.method === 'asset.begin' ? { uploadId: 'draft', offset: 16384 }
                : message.method === 'asset.chunk' ? { offset: offset + Buffer.from(message.params.data, 'base64').byteLength }
                : message.method === 'asset.seal' ? asset
                : message.method === 'asset.read' ? { offset: offset + part.length, total: data.length, data: Buffer.from(part).toString('base64') }
                : { state: 'unknown', selectionId: 'selection' };
            queueMicrotask(() => client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }));
        },
    } as unknown as RTCDataChannel;
    const client = new DcFileClient(() => channel, () => 9);
    assert.deepEqual(await client.uploadAsset(file, 'operation', signal), asset);
    const chunks = messages.filter(message => message.method === 'asset.chunk');
    assert.deepEqual(chunks.map(message => message.params.offset), [16384, 32768]);
    assert.deepEqual(Buffer.concat(chunks.map(message => Buffer.from(message.params.data, 'base64'))), Buffer.from(data.subarray(16384)));
    assert.deepEqual(new Uint8Array(await (await client.readPhoto(asset, signal)).arrayBuffer()), data);
    assert.ok(messages.every(message => message.params.requestId === 'library' && message.authEpoch === 9));
    assert.deepEqual(await client.commitSelection('chooser', 'selection'), { state: 'unknown', selectionId: 'selection' });
    assert.deepEqual(messages[messages.length - 1]?.params, { requestId: 'chooser', selectionId: 'selection' });
});
