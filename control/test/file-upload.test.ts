import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile } from '../client/file-upload';
test('file transfer sends raw Blob with cookies, validates target, reports progress and aborts', async () => {
  const oldLocation = globalThis.location,
    oldXhr = globalThis.XMLHttpRequest;
  const requests: any[] = [];
  class Xhr {
    upload: any = {};
    headers: any = {};
    status = 204;
    withCredentials = false;
    timeout = 0;
    onload: any;
    onabort: any;
    body: any;
    constructor() {
      requests.push(this);
    }
    open(method: string, url: string) {
      Object.assign(this, { method, url });
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body: any) {
      this.body = body;
    }
    abort() {
      this.onabort();
    }
  }
  Object.assign(globalThis, {
    location: { href: 'https://viewer.example/', origin: 'https://viewer.example' },
    XMLHttpRequest: Xhr,
  });
  try {
    const file = new File(['contents'], 'client-name.jpg'),
      controller = new AbortController(),
      progress: number[] = [];
    const transfer = uploadFile('/api/files/opaque', file, controller.signal, (bytes) =>
      progress.push(bytes),
    );
    const xhr = requests[0];
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.withCredentials, true);
    assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
    assert.equal(xhr.body, file);
    xhr.upload.onprogress({ loaded: 3 });
    assert.deepEqual(progress, [3]);
    xhr.onload();
    await transfer;
    const cancelled = uploadFile('/api/files/next', file, controller.signal, () => {});
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    await assert.rejects(
      uploadFile('https://other.example/api/files/opaque', file, new AbortController().signal, () => {}),
      /地址无效/,
    );
    await assert.rejects(
      uploadFile('/api/files/opaque?tenant=bad', file, new AbortController().signal, () => {}),
      /地址无效/,
    );
    assert.equal(requests.length, 2);
  } finally {
    Object.assign(globalThis, { location: oldLocation, XMLHttpRequest: oldXhr });
  }
});
