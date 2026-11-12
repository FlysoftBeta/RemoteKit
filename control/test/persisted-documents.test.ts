import assert from 'node:assert/strict';
import test from 'node:test';
import * as documents from '../server/persistence/documents';
import { decodeJson, encodeJson, type Codec } from '../server/persistence/codec';
import { defaultAuthSettings } from '../server/auth/crypto';
import { defaultSettings } from '../server/persistence/workspaces';

const counts = { applied: 1, rejected: 0 };
const event = { seq: 1, at: 1, type: 'paired', ref: 1, username: 'user' };
const incoming = {
  seq: 1,
  at: 1,
  receivedAt: 1,
  device: 'device',
  publicKey: 'key',
  type: 'pair',
  username: 'user',
};
const source = { app: 'browser', channel: 'example.test' };
const entry = {
  id: 'file',
  name: 'file',
  type: 'text/plain',
  size: 1,
  createdAt: 1,
  source,
  partitionId: null,
  collected: true,
  kind: 'file',
  assetId: 'object',
};
const samples: Record<string, unknown> = {
  errorCode: 'internal',
  wireError: { code: 'internal', message: 'failure' },
  windowState: { section: 'apps' },
  tab: { id: 'tab', windowId: 'window', webviewId: '1', title: '', url: '', idleKeepAlive: false },
  space: { id: 'space', windowIds: ['window'], weights: [1], focusedWindowId: 'window', lastActiveAt: 1 },
  settings: defaultSettings(),
  site: { tabletUa: true },
  app: {
    id: 'app',
    name: 'App',
    startUrl: 'https://example.test/',
    scope: 'https://example.test/',
    display: 'standalone',
    createdAt: 1,
    updatedAt: 1,
  },
  favorite: { id: 'favorite', url: 'https://example.test/', title: 'Example', createdAt: 1 },
  pending: { pendingClose: null, pendingWindowCloseId: null },
  authSettings: defaultAuthSettings(),
  receipt: { operationId: 'operation', operationGeneration: 'generation', status: 'committed' },
  action: { type: 'window.focus', windowId: 'window' },
  librarySource: source,
  partition: { id: 'partition', name: 'Work' },
  snippetOrigin: { kind: 'page', url: 'https://example.test/', app: 'browser' },
  libraryEntry: entry,
  librarySnapshot: {
    revision: 1,
    entries: [entry],
    basket: [],
    partitions: [],
    sources: [],
    excludedSources: [],
    basketPartitionId: null,
  },
  selection: {
    selectionId: 'selection',
    requestId: 'request',
    binding: { browserIncarnation: 'browser', view: '1', instance: '1', document: '1', request: '1' },
    entryIds: ['file'],
    files: [{ assetId: 'object', name: 'file', type: 'text/plain' }],
    limits: { maxFileBytes: 1, maxBatchBytes: 1, maxFiles: 1 },
    prepared: true,
  },
  sites: [{ name: 'Example', url: 'https://example.test/' }],
  counts,
  applyCounts: { cookies: counts, localStorage: counts },
  storageJob: { importId: 'import' },
  pairingCode: ['one', 'two', 'three', 'four', 'five'],
  importPayload: { cookies: [], localStorage: [], ref: 1 },
  controlEvent: event,
  incomingEvent: incoming,
  eventBody: event,
  changyanSession: {
    sso: { tgt: 'tgt', at: 'at', userId: 'user' },
    changyan: { token: 'token', userId: 'user', createdAt: 'created', expiresAt: 'expires' },
  },
  xinjiaoyuSession: {
    token: 'token',
    accessToken: 'access',
    clientSessionId: 'session',
    device: 'device',
    deviceType: 'type',
  },
};

test('every stored document definition has writer/reader coverage', () => {
  assert.deepEqual(Object.keys(documents).sort(), Object.keys(samples).sort());
});
for (const [name, sample] of Object.entries(samples)) {
  test(`${name} round trips its writer and rejects malformed persisted fields`, () => {
    const codec = (documents as Record<string, Codec<unknown>>)[name];
    const text = encodeJson(sample, codec, name);
    assert.deepEqual(decodeJson(text, codec, name), sample);
    const reject = (value: unknown) => {
      assert.throws(
        () => decodeJson(JSON.stringify(value), codec, name),
        (error: any) => error.reason === 'corrupt_record' && /^c-[0-9a-f]{10}$/.test(error.errorId),
      );
      assert.throws(() => encodeJson(value, codec, name), { reason: 'corrupt_record' });
    };
    reject(false);
    if (Array.isArray(sample)) {
      if (name === 'pairingCode') {
        reject(sample.slice(1));
        reject([...sample, 'six']);
        reject([1, ...sample.slice(1)]);
      } else {
        const item = sample[0] as Record<string, unknown>;
        const first = Object.keys(item)[0];
        reject([{ ...item, [first]: undefined }]);
        reject([{ ...item, unknown: true }]);
        reject([{ ...item, [first]: false }]);
      }
    } else if (sample && typeof sample === 'object') {
      const value = sample as Record<string, unknown>;
      reject({ ...value, unknown: true });
      const required = Object.keys(value).find((key) => {
        try {
          codec.read(JSON.parse(JSON.stringify({ ...value, [key]: undefined })), '$');
          return false;
        } catch {
          return true;
        }
      });
      if (required) {
        reject({ ...value, [required]: undefined });
        reject({ ...value, [required]: typeof value[required] === 'boolean' ? 'false' : false });
      } else {
        assert.deepEqual(decodeJson('{}', codec, name), {});
        reject({ ...value, tabletUa: 1 });
      }
    }
  });
}
