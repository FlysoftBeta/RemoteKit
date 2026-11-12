import { submitViewerAction } from './server-fixture';
import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';

const endpoint = {
  async request(method: string) {
    return { accepted: true, applied: false };
  },
};
test('audio output channels default on and persist the complete shared pair atomically', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    control = createApplication(store, testGateway(endpoint));
  try {
    const account = await registerUser(store, 'audio-settings', 'password123'),
      tenant = account.tenantId;
    await control.viewers.attachViewer(
      tenant,
      'viewer',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(store.workspaces.workspace(tenant).settings.workspace.audioChannels, {
      left: true,
      right: true,
    });
    for (const left of [false, true])
      for (const right of [false, true]) {
        const result = await submitViewerAction(control, tenant, 'viewer', {
          type: 'settings.update',
          settings: { workspace: { audioChannels: { left, right } } },
        });
        assert.equal(result.status, 'committed');
        assert.deepEqual(control.viewers.productState(tenant).workspace.settings.workspace.audioChannels, {
          left,
          right,
        });
        assert.deepEqual(store.workspaces.workspace(tenant).settings.workspace.audioChannels, {
          left,
          right,
        });
      }
    for (const channels of [
      { left: false },
      { right: false },
      { left: false, right: 'yes' },
      { left: true, right: true, muted: false },
      null,
    ]) {
      await assert.rejects(
        submitViewerAction(control, tenant, 'viewer', {
          type: 'settings.update',
          settings: { workspace: { audioChannels: channels as any } },
        }),
        { code: 'invalid_request' },
      );
      assert.deepEqual(store.workspaces.workspace(tenant).settings.workspace.audioChannels, {
        left: true,
        right: true,
      });
    }
    await control.viewers.attachViewer(
      tenant,
      'replacement',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(control.viewers.productState(tenant).workspace.settings.workspace.audioChannels, {
      left: true,
      right: true,
    });
    await assert.rejects(
      submitViewerAction(control, tenant, 'viewer', {
        type: 'settings.update',
        settings: { workspace: { audioChannels: { left: false, right: false } } },
      }),
      { code: 'conflict' },
    );
  } finally {
    await control.close();
    store.db.close();
  }
});
test('audio defaults enable both outputs and failed persistence preserves confirmed channels', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    control = createApplication(store, testGateway(endpoint));
  try {
    const { tenantId: tenant } = await registerUser(store, 'audio-persistence', 'password123');
    assert.deepEqual(store.workspaces.workspace(tenant).settings.workspace.audioChannels, {
      left: true,
      right: true,
    });
    await control.viewers.attachViewer(
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
      submitViewerAction(control, tenant, 'viewer', {
        type: 'settings.update',
        settings: { workspace: { audioChannels: { left: false, right: false } } },
      }),
      { code: 'internal' },
    );
    store.workspaces.saveWorkspace = original;
    assert.deepEqual(control.viewers.productState(tenant).workspace.settings.workspace.audioChannels, {
      left: true,
      right: true,
    });
  } finally {
    await control.close();
    store.db.close();
  }
});
