import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../server/application';
import { log } from '../server/log';
import { diskFloor } from '../server/cluster/disk';
import { MetricsHistory } from '../server/cluster/metrics';
import { NodeRegistry } from '../server/cluster/node-link';
import { Placement } from '../server/cluster/placement';
import type { NodeLimits } from '../server/config';
import { endpointDefaults, testNode } from './node-fixture';
import { EndpointGateway } from '../server/endpoint/gateway';
import type { EndpointSnapshot } from '../server/endpoint/types';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { BackgroundReclaim, type ReclaimObservation } from '../server/workspace/lifecycle';
import { fakeMetrics } from './fake-node';
import { TestClock } from './server-fixture';

const closeTo = (actual: number | undefined, expected: number) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function cluster(overrides: Partial<NodeLimits> = {}) {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const nodes = new NodeRegistry({
    privateKey: Buffer.alloc(32).toString('base64'),
    buildId: 'dev',
    nodes: Object.fromEntries(
      ['alpha', 'beta'].map((nodeId) => [
        nodeId,
        {
          ...testNode(nodeId),
          limits: { ...testNode(nodeId).limits, ...overrides },
          configHash: nodeId,
        },
      ]),
    ),
  });
  for (const node of nodes.all()) {
    node.state = { state: 'ready', incarnation: 'process', connectionEpoch: 'epoch' };
    node.metrics.record(fakeMetrics());
  }
  const placement = new Placement(store, nodes);
  return {
    store,
    nodes,
    placement,
    close() {
      nodes.stop();
      store.db.close();
    },
  };
}

test('prediction learns idle EWMA and per-session costs, and uses conservative costs before idle', () => {
  const metrics = new MetricsHistory(null);
  assert.equal(metrics.predicted(0), undefined);
  metrics.record(fakeMetrics({ cpu: 0.5, sessions: 2 }), 0);
  closeTo(metrics.predicted(0), 0.75);
  metrics.record(fakeMetrics({ cpu: 0.1 }), 1);
  metrics.record(fakeMetrics({ cpu: 0.3 }), 2);
  metrics.record(fakeMetrics({ cpu: 0.54, sessions: 2 }), 3);
  closeTo(metrics.predicted(3), 0.74);
  metrics.record(fakeMetrics({ cpu: 0.04, sessions: 2 }), 4);
  assert.ok(metrics.predicted(4)! < 0.2);
  metrics.clear();
  metrics.record(fakeMetrics({ cpu: 0.54, sessions: 2 }), 5);
  closeTo(metrics.predicted(5), 0.81);
});

test('idle nodes borrow the average known costs of other fresh nodes', () => {
  const first = new MetricsHistory(null);
  const second = new MetricsHistory(null);
  const idle = new MetricsHistory(null, () => [first, second]);
  first.record(fakeMetrics({ cpu: 0.4, sessions: 2 }), 0);
  second.record(fakeMetrics({ cpu: 0.6, sessions: 2 }), 0);
  idle.record(fakeMetrics({ cpu: 0.1 }), 0);
  closeTo(idle.predicted(0), 0.35);
  first.record(fakeMetrics({ cpu: 0.1 }), 1);
  closeTo(idle.predicted(1), 0.35);
  idle.record(fakeMetrics({ cpu: 0.1 }), 30001);
  closeTo(idle.predicted(30002), 0.1);
});

test('prediction includes memory, disk, both GPU engines, and optional session cap', () => {
  for (const overrides of [
    { memory: { total: 100, available: 40 } },
    { disk: { total: 100, free: 40 } },
    ...['engine3d', 'engineVideoEncode'].map((resource) => ({
      gpus: [
        { luid: 'a', name: 'a', engine3d: 0.1, engineVideoEncode: 0.1, dedicatedUsed: 0, dedicatedTotal: 1 },
        {
          luid: 'b',
          name: 'b',
          engine3d: 0,
          engineVideoEncode: 0,
          dedicatedUsed: 0,
          dedicatedTotal: 1,
          [resource]: 0.6,
        },
      ],
    })),
  ]) {
    const metrics = new MetricsHistory(null);
    metrics.record(fakeMetrics({ ...overrides, sessions: 2 }), 0);
    closeTo(metrics.predicted(0), 0.9);
    assert.equal(metrics.relieved(0), true);
    assert.equal(metrics.relieved(30001), false);
  }
  const capped = new MetricsHistory(2);
  capped.record(fakeMetrics({ sessions: 1 }), 0);
  closeTo(capped.predicted(0), 1);
  capped.record(fakeMetrics({ sessions: 2 }), 1);
  assert.equal(capped.relieved(1), false);
  const uncapped = new MetricsHistory(null);
  uncapped.record(fakeMetrics({ sessions: 100 }), 0);
  closeTo(uncapped.latest(0)!.pressure, 0.1);
});

test('disk floor is configured or the greater of two GiB and five percent of the volume', () => {
  const metrics = new MetricsHistory(null);
  const node = { limits: { diskReserveBytes: null as number | null } };
  metrics.record(fakeMetrics({ disk: { total: 10 * 1024 ** 3, free: 0 } }));
  assert.equal(diskFloor(node, metrics.latest()!), 2 * 1024 ** 3);
  metrics.record(fakeMetrics({ disk: { total: 100 * 1024 ** 3, free: 0 } }));
  assert.equal(diskFloor(node, metrics.latest()!), 5 * 1024 ** 3);
  node.limits.diskReserveBytes = 0;
  assert.equal(diskFloor(node, metrics.latest()!), 0);
});

test('placement chooses predicted headroom even under pressure and signals relief', () => {
  const h = cluster();
  try {
    const alpha = h.nodes.get('alpha')!;
    const beta = h.nodes.get('beta')!;
    alpha.metrics.clear();
    for (let offset = 30000; offset >= 0; offset -= 5000)
      alpha.metrics.record(fakeMetrics({ cpu: 0.86, sessions: 20 }), Date.now() - offset);
    beta.metrics.record(fakeMetrics({ cpu: 0.7, sessions: 1 }));
    assert.equal(alpha.metrics.underPressure(), true);
    assert.ok(alpha.metrics.predicted()! < beta.metrics.predicted()!);
    assert.equal(h.placement.resolve('tenant').nodeId, 'alpha');
    assert.ok(alpha.reliefRequestedAt);
    assert.ok(h.placement.resolve('next').nodeId);
  } finally {
    h.close();
  }
});

test('configured caps remain hard, including placements newer than the metrics', () => {
  const h = cluster({ maxSessions: 1, diskReserveBytes: 100, sessionMemoryBytes: 100 });
  try {
    h.nodes.get('beta')!.diskDraining = true;
    h.placement.resolve('first');
    assert.throws(() => h.placement.resolve('second'), { code: 'unavailable', message: '没有可用的节点' });
    h.placement.evacuate('alpha');
    for (const overrides of [
      { sessions: 1 },
      { disk: { total: 1000, free: 99 } },
      { memory: { total: 1000, available: 99 } },
    ]) {
      h.nodes.get('alpha')!.metrics.record(fakeMetrics(overrides));
      assert.throws(() => h.placement.resolve('second'), { code: 'unavailable' });
    }
  } finally {
    h.close();
  }
});

test('stopped sessions do not hold a configured session slot', () => {
  const h = cluster({ maxSessions: 1, diskReserveBytes: 100, sessionMemoryBytes: 100 });
  try {
    h.nodes.get('beta')!.diskDraining = true;
    h.placement.resolve('first');
    assert.throws(() => h.placement.resolve('second'), { code: 'unavailable' });
    h.store.db
      .prepare("UPDATE session_placements SET run_state='stopped',data_state='clean' WHERE tenant='first'")
      .run();
    assert.equal(h.placement.resolve('second').nodeId, 'alpha');
  } finally {
    h.close();
  }
});

test('warm bonus applies only below predicted pressure threshold and only to the latest checkpoint', () => {
  const h = cluster();
  try {
    const sleeping = h.placement.resolve('tenant');
    const manifest = '1'.repeat(64);
    h.store.db
      .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
      .run('tenant', 1, sleeping.placementEpoch, manifest, 'dev', 0);
    h.store.db
      .prepare(
        "UPDATE session_placements SET run_state='stopped',data_state='clean',checkpoint_id=1 WHERE tenant='tenant'",
      )
      .run();
    h.store.db
      .prepare('INSERT INTO warm_session_copies VALUES (?,?,?,?)')
      .run('tenant', 'alpha', manifest, Date.now());
    const alpha = h.nodes.get('alpha')!;
    const beta = h.nodes.get('beta')!;
    const place = (a: number, b: number, warm = manifest) => {
      h.store.db
        .prepare("UPDATE session_placements SET run_state='stopped',data_state='clean' WHERE tenant='tenant'")
        .run();
      h.store.db.prepare('UPDATE warm_session_copies SET manifest_id=?').run(warm);
      alpha.metrics.record(fakeMetrics({ cpu: a }));
      beta.metrics.record(fakeMetrics({ cpu: b }));
      return h.placement.resolve('tenant').nodeId;
    };
    assert.equal(place(0.8, 0.7), 'alpha');
    assert.equal(place(0.85, 0.8), 'beta');
    assert.equal(place(0.8, 0.7, '2'.repeat(64)), 'beta');
    assert.equal(place(0.5, 0.5, '2'.repeat(64)), 'alpha');
  } finally {
    h.close();
  }
});

const snapshot = (): EndpointSnapshot => ({
  running: true,
  views: [],
  stopBlockers: {
    unacknowledgedClosedEvents: 0,
    pendingNativeSelections: 0,
    inFlightUploads: 0,
    pendingPageRequests: 0,
    downloadsInProgress: 0,
    pendingDownloadImports: 0,
    rtcConnected: false,
    lifecycleUncertain: false,
  },
});

function reliefCluster() {
  const h = cluster();
  const clock = new TestClock();
  const gateway = new EndpointGateway(h.nodes, h.placement);
  gateway.snapshot = async () => snapshot();
  const stopped: string[] = [];
  gateway.stop = async (tenant) => {
    stopped.push(tenant);
    h.store.db
      .prepare("UPDATE session_placements SET run_state='stopped',data_state='clean' WHERE tenant=?")
      .run(tenant);
    return 1;
  };
  const app = createApplication(h.store, gateway, undefined, clock);
  const add = (tenant: string, absence: number) => {
    h.placement.resolve(tenant);
    h.store.workspaces.writeWorkspace(emptyWorkspace(tenant));
    const runtime = app.tenants.get(tenant);
    runtime.started = true;
    runtime.viewerAbsentSince = clock.monotonicMs() - absence;
    return runtime;
  };
  const pressure = () => {
    const node = h.nodes.get('alpha')!;
    node.metrics.clear();
    for (let offset = 30000; offset >= 0; offset -= 5000)
      node.metrics.record(fakeMetrics({ cpu: 0.9, sessions: 4 }), Date.now() - offset);
  };
  return {
    ...h,
    app,
    clock,
    gateway,
    stopped,
    add,
    pressure,
    async close() {
      await app.close();
      h.close();
    },
  };
}

test('relief selects longest eligible absence, allows one flight per node and waits for newer metrics', async (t) => {
  const h = reliefCluster();
  const logs: unknown[][] = [];
  t.mock.method(log, 'info', (...args: unknown[]) => logs.push(args));
  try {
    h.add('short', 600000);
    h.add('z-last', 600000);
    h.add('long', 720000);
    h.add('blocked', 840000);
    h.add('online', 300000).viewer = {} as any;
    h.add('recent', 59999);
    h.gateway.snapshot = async (tenant) => {
      const value = snapshot();
      if (tenant === 'blocked') value.stopBlockers!.inFlightUploads = 1;
      return value;
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = h.gateway.stop.bind(h.gateway);
    h.gateway.stop = async (tenant) => {
      await gate;
      return stop(tenant);
    };
    h.pressure();
    const first = h.app.lifecycle.relieve();
    const concurrent = h.app.lifecycle.relieve();
    release();
    await Promise.all([first, concurrent]);
    assert.deepEqual(h.stopped, ['long']);
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['long']);
    h.nodes.get('alpha')!.metrics.record(fakeMetrics({ cpu: 0.9, sessions: 3 }), Date.now() + 1);
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['long', 'short']);
    const decisions = logs
      .filter((line) => line[0] === 'stop.auto')
      .map((line) => line[1] as Record<string, unknown>);
    assert.equal(decisions[0].reason, 'rebalance');
    assert.equal(decisions[0].tenant, 'long');
    assert.equal(decisions[0].node, 'alpha');
    assert.equal(typeof decisions[0].pressure, 'number');
    assert.equal(typeof decisions[0].predicted, 'number');
    assert.equal(h.placement.resolve('long').nodeId, 'beta');
    h.nodes.get('alpha')!.metrics.record(fakeMetrics(), Date.now() + 2);
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['long', 'short']);
    h.nodes.get('alpha')!.metrics.record(fakeMetrics({ cpu: 0.9, sessions: 2 }), Date.now() + 3);
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['long', 'short']);
  } finally {
    await h.close();
  }
});

test('placement requests relief without sustained pressure; a newer relieved sample clears the request', async () => {
  const h = reliefCluster();
  try {
    h.add('idle', 600000);
    h.nodes.get('beta')!.state = { state: 'offline' };
    const alpha = h.nodes.get('alpha')!;
    alpha.metrics.record(fakeMetrics({ cpu: 0.8, sessions: 1 }));
    h.placement.resolve('new');
    assert.equal(alpha.metrics.underPressure(), false);
    assert.ok(alpha.reliefRequestedAt);
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['idle']);
    h.add('later', 60000);
    alpha.metrics.record(fakeMetrics({ cpu: 0.1 }), Date.now() + 1);
    await h.app.lifecycle.relieve();
    assert.equal(alpha.reliefRequestedAt, undefined);
    assert.deepEqual(h.stopped, ['idle']);
  } finally {
    await h.close();
  }
});

test('sustained pressure triggers relief without a lighter node; idle stop keeps ten minutes', async (t) => {
  const h = reliefCluster();
  const logs: unknown[][] = [];
  t.mock.method(log, 'info', (...args: unknown[]) => logs.push(args));
  try {
    h.add('idle', 600000);
    assert.equal(h.app.lifecycle.stopBlocker('idle', snapshot(), false), undefined);
    h.nodes.get('beta')!.metrics.record(fakeMetrics({ cpu: 0.7 }));
    h.pressure();
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, ['idle']);
    assert.equal(logs[0][0], 'stop.auto');
    assert.equal((logs[0][1] as { reason: string }).reason, 'relief');
  } finally {
    await h.close();
  }
});

test('relief rechecks pressure and Viewer presence after awaiting the snapshot', async () => {
  const h = reliefCluster();
  try {
    const runtime = h.add('idle', 600000);
    h.pressure();
    h.gateway.snapshot = async () => {
      h.nodes.get('alpha')!.metrics.record(fakeMetrics(), Date.now() + 1);
      return snapshot();
    };
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, []);
    h.pressure();
    h.gateway.snapshot = async () => {
      runtime.viewer = {} as any;
      return snapshot();
    };
    await h.app.lifecycle.relieve();
    assert.deepEqual(h.stopped, []);
  } finally {
    await h.close();
  }
});

test('tab reclaim uses ten-second freeze and thirty-second discard under pressure', () => {
  for (const underPressure of [true, false]) {
    const clock = new TestClock();
    const saver = new BackgroundReclaim(clock);
    const observation: ReclaimObservation = {
      visible: false,
      protectedByProduct: false,
      underPressure,
      browserIncarnation: 'browser',
      current: { actual: 0, visible: false, canDiscard: true, instance: 'page' },
    };
    saver.observe(observation);
    clock.advance(9999);
    assert.equal(saver.observe(observation), null);
    clock.advance(1);
    assert.equal(saver.observe(observation), underPressure ? 'freeze' : null);
    observation.current!.actual = 1;
    for (let i = 0; i < 4; i++) {
      clock.advance(5000);
      saver.observe(observation);
    }
    assert.equal(saver.observe(observation), underPressure ? 'discard' : null);
    observation.current!.audible = true;
    assert.equal(saver.observe(observation), null);
  }
});
