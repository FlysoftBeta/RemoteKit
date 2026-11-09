import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceClipboardSync } from '../client/clipboard/device-clipboard';

function fixture() {
  let focused = true,
    granted = false,
    device = '',
    reads = 0,
    failures = 0;
  const sent: string[] = [],
    writes: string[] = [];
  const sync = new DeviceClipboardSync({
    focused: () => focused,
    granted: async () => granted,
    read: async () => {
      reads++;
      return device;
    },
    write: async (text) => {
      writes.push(text);
      device = text;
    },
    failed: () => {
      failures++;
    },
  });
  const set = async (text: string) => {
    sent.push(text);
    return { revision: String(sent.length + 10) };
  };
  sync.configure('one', true, set);
  return {
    sync,
    sent,
    writes,
    set,
    focus(value: boolean) {
      focused = value;
    },
    grant(value: boolean) {
      granted = value;
    },
    device(value: string) {
      device = value;
    },
    get reads() {
      return reads;
    },
    get failures() {
      return failures;
    },
  };
}

test('remote writes wait for focus, retain only the latest and never echo on granted reads', async () => {
  const h = fixture();
  h.focus(false);
  h.sync.receive({ revision: '1', text: 'old' });
  h.sync.receive({ revision: '2', text: 'latest' });
  assert.deepEqual(h.writes, []);
  h.focus(true);
  h.grant(true);
  await h.sync.focus();
  assert.deepEqual(h.writes, ['latest']);
  assert.deepEqual(h.sent, []);
  h.device('device');
  await h.sync.focus();
  await h.sync.focus();
  assert.deepEqual(h.sent, ['device']);
});

test('focus never reads without an existing grant; paste text needs no permission', async () => {
  const h = fixture();
  await h.sync.focus();
  assert.equal(h.reads, 0);
  await h.sync.send('permissionless paste');
  await h.sync.send('permissionless paste');
  assert.deepEqual(h.sent, ['permissionless paste']);
  await h.sync.readForPaste();
  assert.equal(h.reads, 1);
});

test('sync off and changed identities clear deferred content and stop both directions', async () => {
  const h = fixture();
  h.focus(false);
  h.sync.receive({ revision: '1', text: 'old user' });
  h.sync.configure('two', false, h.set);
  h.focus(true);
  h.grant(true);
  await h.sync.focus();
  await h.sync.send('off');
  h.sync.receive({ revision: '2', text: 'off' });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.reads, 0);
  h.sync.configure('two', true, h.set);
  await h.sync.send('next user');
  assert.deepEqual(h.sent, ['next user']);
});

test('device writes finish before a caller forwards paste, and failures leave the hash retryable', async () => {
  const h = fixture();
  let release!: () => void;
  const order: string[] = [];
  h.sync.configure('one', true, async () => {
    order.push('set');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push('applied');
    return { revision: '1' };
  });
  const paste = h.sync.send('paste').then(() => order.push('paste'));
  await Promise.resolve();
  assert.deepEqual(order, ['set']);
  release();
  await paste;
  assert.deepEqual(order, ['set', 'applied', 'paste']);
  h.sync.configure('one', true, async () => {
    throw new Error('must not be logged');
  });
  await assert.rejects(h.sync.send('retry'));
  h.sync.configure('one', true, h.set);
  await h.sync.send('retry');
  assert.deepEqual(h.sent, ['retry']);
});

test('a delayed device acknowledgement cannot replace a newer remote hash', async () => {
  const h = fixture();
  let release!: (value: { revision: string }) => void;
  h.sync.configure(
    'one',
    true,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const sending = h.sync.send('device');
  await Promise.resolve();
  h.sync.receive({ revision: '3', text: 'new remote' });
  release({ revision: '2' });
  await sending;
  h.sync.configure('one', true, h.set);
  await h.sync.send('new remote');
  assert.deepEqual(h.sent, []);
  h.sync.receive({ revision: '1', text: 'stale remote' });
  await h.sync.focus();
  assert.equal(h.writes.includes('stale remote'), false);
});

test('a clipboard permission response cannot write into a replacement account', async () => {
  const sent: string[] = [];
  let resolve!: (text: string) => void;
  const sync = new DeviceClipboardSync({
    focused: () => true,
    granted: async () => false,
    read: () =>
      new Promise((done) => {
        resolve = done;
      }),
    write: async () => {},
    failed: () => {},
  });
  const set = async (text: string) => {
    sent.push(text);
    return { revision: '1' };
  };
  sync.configure('one', true, set);
  const reading = sync.readForPaste();
  sync.configure('two', true, set);
  resolve('old gesture');
  await reading;
  assert.deepEqual(sent, []);
});

test('local explicit paste reads only after permission is already granted', async () => {
  const h = fixture();
  h.device('device');
  await h.sync.readForPaste(false);
  assert.deepEqual(h.sent, []);
  h.grant(true);
  await h.sync.readForPaste(false);
  assert.deepEqual(h.sent, ['device']);
});
