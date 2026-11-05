import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { Control } from '../server/control';

const endpoint = {
  async request(method: string) {
    if (method === 'session.snapshot') return { running: false, views: [] };
    return { accepted: true, applied: false };
  },
};
test('audio output channels default on and persist the complete shared pair atomically', async () => {
  const store = new ControlDatabase(':memory:'),
    control = new Control(store, testGateway(endpoint));
  try {
    const account = await store.accounts.register('audio-settings', 'password123'),
      tenant = account.tenantId;
    await control.attachViewer(
      tenant,
      'viewer',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(store.workspaces.workspace(tenant).settings.audioChannels, { left: true, right: true });
    for (const left of [false, true])
      for (const right of [false, true]) {
        const result = await control.viewerRequest(tenant, 'viewer', 'action', {
          type: 'settings.update',
          settings: { audioChannels: { left, right } },
        });
        assert.deepEqual(result.state.workspace.settings.audioChannels, { left, right });
        assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels, { left, right });
        assert.deepEqual(store.workspaces.workspace(tenant).settings.audioChannels, { left, right });
      }
    for (const channels of [
      { left: false },
      { right: false },
      { left: false, right: 'yes' },
      { left: true, right: true, muted: false },
      null,
    ]) {
      await assert.rejects(
        control.viewerRequest(tenant, 'viewer', 'action', {
          type: 'settings.update',
          settings: { audioChannels: channels },
        }),
        { code: 'invalid_request' },
      );
      assert.deepEqual(store.workspaces.workspace(tenant).settings.audioChannels, {
        left: true,
        right: true,
      });
    }
    await control.attachViewer(
      tenant,
      'replacement',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels, {
      left: true,
      right: true,
    });
    await assert.rejects(
      control.viewerRequest(tenant, 'viewer', 'action', {
        type: 'settings.update',
        settings: { audioChannels: { left: false, right: false } },
      }),
      { code: 'conflict' },
    );
  } finally {
    store.db.close();
  }
});
test('audio defaults enable both outputs and failed persistence preserves confirmed channels', async () => {
  const store = new ControlDatabase(':memory:'),
    control = new Control(store, testGateway(endpoint));
  try {
    const { tenantId: tenant } = await store.accounts.register('audio-persistence', 'password123');
    assert.deepEqual(store.workspaces.workspace(tenant).settings.audioChannels, { left: true, right: true });
    await control.attachViewer(
      tenant,
      'viewer',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const original = store.workspaces.saveWorkspace.bind(store.workspaces);
    store.workspaces.saveWorkspace = () => {
      throw Error('sqlite fault');
    };
    await assert.rejects(
      control.viewerRequest(tenant, 'viewer', 'action', {
        type: 'settings.update',
        settings: { audioChannels: { left: false, right: false } },
      }),
      { code: 'internal' },
    );
    store.workspaces.saveWorkspace = original;
    assert.deepEqual(control.productState(tenant).workspace.settings.audioChannels, {
      left: true,
      right: true,
    });
  } finally {
    store.db.close();
  }
});
