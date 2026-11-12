import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { ReclaimStatistics } from '../server/persistence/reclaim-statistics';
import { TestClock } from './server-fixture';
import { createApplication } from '../server/application';
import { registerUser, testGateway } from './server-fixture';

test('dwell duration preserves fractional milliseconds emitted by the clock', () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  try {
    store.reclaim.observeWanted('tenant', new Map([['1', 'page']]));
    clock.advance(10000);
    clock.monotonicMs = () => 10000.25;
    store.reclaim.observeWanted('tenant', new Map());
    assert.deepEqual(store.reclaim.dwell('tenant'), [{ pageKey: 'page', visibleMs: 10000.25 }]);
    store.db.prepare('UPDATE page_dwell SET visible_ms=?').run('invalid');
    assert.throws(
      () => store.reclaim.dwell('tenant'),
      (error: any) => error.reason === 'corrupt_record',
    );
  } finally {
    store.db.close();
  }
});

test('presence records completed gaps, replacement connections and restart closure at the heartbeat', () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  try {
    store.reclaim.attach('tenant');
    clock.advance(5000);
    store.reclaim.attach('tenant');
    clock.advance(1000);
    store.reclaim.detach('tenant');
    clock.advance(7000);
    store.reclaim.attach('tenant');
    assert.deepEqual(store.reclaim.absences('tenant'), [7000]);
    store.reclaim.tick();
    const lastHeartbeat = clock.wallMs();
    clock.advance(2000);
    new ReclaimStatistics(store.db, clock);
    const rows = store.db
      .prepare('SELECT disconnected_at FROM viewer_presence ORDER BY connected_at')
      .all() as { disconnected_at: bigint }[];
    assert.equal(Number(rows[rows.length - 1].disconnected_at), lastHeartbeat);
    assert.equal(store.reclaim.absentSince('tenant'), lastHeartbeat);
  } finally {
    store.db.close();
  }
});

test('presence is bounded to ninety days and two thousand rows per tenant', () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  try {
    const insert = store.db.prepare('INSERT INTO viewer_presence VALUES (?,?,?)');
    store.db.transaction(() => {
      insert.run('tenant', 0, 1);
      for (let index = 0; index < 2100; index++)
        insert.run('tenant', clock.wallMs() - 2100 + index, clock.wallMs() - 2100 + index);
      insert.run('other', clock.wallMs(), clock.wallMs());
    })();
    store.reclaim.attach('tenant');
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM viewer_presence WHERE tenant='tenant'").get() as any)
        .count,
      2000n,
    );
    assert.equal(
      (store.db.prepare('SELECT min(connected_at) AS oldest FROM viewer_presence').get() as any).oldest > 0n,
      true,
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM viewer_presence WHERE tenant='other'").get() as any)
        .count,
      1n,
    );
  } finally {
    store.db.close();
  }
});

test('dwell batches transitions and visits once per ten seconds, including detach and shutdown tails', () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  try {
    store.reclaim.observeWanted('tenant', new Map([['tab', 'https://example.test/']]));
    clock.advance(3000);
    store.reclaim.observeWanted('tenant', new Map());
    clock.advance(2000);
    store.reclaim.observeWanted('tenant', new Map([['tab', 'https://example.test/']]));
    clock.advance(4999);
    store.reclaim.tick();
    assert.equal(store.db.prepare('SELECT * FROM page_dwell').get(), undefined);
    clock.advance(1);
    store.reclaim.tick();
    let row = store.db.prepare('SELECT * FROM page_dwell').get() as any;
    assert.equal(row.visible_ms, 8000n);
    assert.equal(row.visits, 2n);
    clock.advance(2000);
    store.reclaim.detach('tenant');
    assert.equal((store.db.prepare('SELECT visible_ms FROM page_dwell').get() as any).visible_ms, 8000n);
    store.reclaim.close();
    row = store.db.prepare('SELECT * FROM page_dwell').get() as any;
    assert.equal(row.visible_ms, 10000n);
    assert.equal(row.visits, 2n);
  } finally {
    store.db.close();
  }
});

test('wanted-visible dwell excludes locked viewers, hidden windows, background tabs and inactive Spaces', async () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  const control = createApplication(
    store,
    testGateway({
      async request() {
        return {};
      },
    }),
    undefined,
    clock,
  );
  const { tenantId } = await registerUser(store, 'dwell-user', 'password123');
  try {
    const runtime = control.tenants.get(tenantId);
    runtime.viewer = {
      id: 'viewer',
      security: { locked: false },
      viewport: { windows: [{ windowId: 'window', visible: true }] },
    } as any;
    const state = store.workspaces.workspace(tenantId);
    state.tabs = [0, 1].map((index) => ({
      id: `tab-${index}`,
      windowId: 'window',
      webviewId: String(index),
      idleKeepAlive: false,
      title: '',
      url: 'https://example.test/?utm_source=launcher',
      kind: 'remote',
    }));
    state.windows = [{ id: 'window', appId: 'browser', activeTabId: 'tab-0', lastActiveAt: 0 }];
    state.spaces = [
      { id: 'space', windowIds: ['window'], focusedWindowId: 'window', weights: [1], lastActiveAt: 0 },
    ];
    state.activeSpaceId = 'space';
    control.lifecycle.observeWanted(state);
    clock.advance(2000);
    Object.assign(runtime.viewer!.security!, { locked: true });
    control.lifecycle.observeWanted(state);
    clock.advance(2000);
    Object.assign(runtime.viewer!.security!, { locked: false });
    runtime.viewer!.viewport!.windows[0].visible = false;
    control.lifecycle.observeWanted(state);
    clock.advance(2000);
    runtime.viewer!.viewport!.windows[0].visible = true;
    state.activeSpaceId = null;
    control.lifecycle.observeWanted(state);
    clock.advance(2000);
    state.activeSpaceId = 'space';
    state.windows[0].activeTabId = 'tab-1';
    control.lifecycle.observeWanted(state);
    clock.advance(2000);
    control.lifecycle.observeWanted(state);
    const rows = store.db.prepare('SELECT * FROM page_dwell').all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].page_key, 'https://example.test/');
    assert.equal(rows[0].visible_ms, 4000n);
    assert.equal(rows[0].visits, 2n);
  } finally {
    await control.close();
    store.db.close();
  }
});
