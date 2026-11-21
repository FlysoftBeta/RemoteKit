import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAction } from '../client/control/action-builder';
import { createApplication } from '../server/application';
import type { SessionDesired } from '../server/endpoint/coordination';
import type { EndpointLink } from '../server/endpoint/link';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
import { ControlDatabase } from '../server/persistence/database';
import { ViewerGenerations } from '../server/persistence/viewer-generations';
import { STALE_GENERATION_DETAIL } from '../shared/errors';
import { occlusionRevision } from '../shared/occlusion-revision';
import { applyDesiredViews, publishAndObserve } from './coordination-fixture';
import { observedProductAction, registerUser, testGateway } from './server-fixture';

const last = <T>(items: T[]) => items[items.length - 1];

class RecordingEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  readonly desired: SessionDesired[] = [];
  private readonly views = new Map<string, any>();
  observe() {
    return {
      running: true,
      browserPid: 10,
      browserIncarnation: 'occlusion-browser',
      views: [...this.views.values()].map((view) => ({ ...view })),
    };
  }
  async request(method: string, _tenant: string, args: any = {}): Promise<any> {
    if (method === 'session.desired') {
      this.desired.push(structuredClone(args));
      applyDesiredViews(this.views, args);
    }
    return {};
  }
  visibleSets() {
    return this.desired.map((desired) =>
      desired.views
        .filter((view) => view.visible)
        .map((view) => view.viewId)
        .sort(),
    );
  }
}

async function fixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    endpoint = new RecordingEndpoint(),
    control = createApplication(store, testGateway(endpoint));
  const { tenantId: tenant } = await registerUser(store, 'occlusion', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  const authority = () => ({
    tenantId: tenant,
    leaseId: 'lease',
    epoch: control.viewers.productEpoch(tenant, 'lease')!,
  });
  const generation = () => control.tenants.get(tenant).viewer!.generation;
  // Reports the way a Viewer would: this lease's generation and an explicit space.
  const report = (
    activeSpaceId: string | null,
    windows: { windowId: string; visible: boolean; occludedBottom?: number; sequence: number }[],
    revisionGeneration = generation(),
  ) =>
    dispatchViewerRequest(control, authority(), 'viewport', {
      devicePixelRatio: 1,
      activeSpaceId,
      windows: windows.map((window) => ({
        windowId: window.windowId,
        width: 800,
        height: 600,
        visible: window.visible,
        occludedBottom: window.occludedBottom ?? 0,
        occlusionRevision: occlusionRevision(revisionGeneration, window.sequence),
      })),
    });
  return { store, endpoint, control, tenant, report, generation };
}

async function openWindow(f: Awaited<ReturnType<typeof fixture>>, url: string) {
  const known = new Set(f.store.workspaces.workspace(f.tenant).windows.map((window) => window.id));
  const { state } = await observedProductAction(
    f.control,
    f.tenant,
    buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url }),
    'lease',
  );
  const window = state.workspace.windows.find((candidate) => !known.has(candidate.id))!;
  const space = state.workspace.spaces.find((candidate) => candidate.windowIds.includes(window.id))!;
  return { windowId: window.id, spaceId: space.id };
}

async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.control.viewers.detachViewer(f.tenant, 'lease');
  await f.control.close();
  f.store.db.close();
}

test('viewer generations are per tenant, durable and never wrap', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const generations = new ViewerGenerations(store.db);
    assert.deepEqual(
      [1, 2, 3].map(() => generations.next('a')),
      [1, 2, 3],
    );
    assert.equal(generations.next('b'), 1);
    store.db.prepare("UPDATE viewer_generations SET generation=4294967295 WHERE tenant='a'").run();
    assert.throws(() => generations.next('a'), { code: 'limit_exceeded' });
    assert.deepEqual(store.db.prepare("SELECT generation FROM viewer_generations WHERE tenant='a'").get(), {
      generation: 4294967295n,
    });
    assert.equal(generations.next('b'), 2);
    generations.deleteTenant('a');
    assert.equal(generations.next('a'), 1);
  } finally {
    store.db.close();
  }
});

test('viewer generations stay monotonic across a Control restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'rk-generation-'));
  try {
    const path = join(directory, 'control.db');
    const first = new ControlDatabase(path, { buildId: 'test' });
    assert.deepEqual([first.viewerGenerations.next('t'), first.viewerGenerations.next('t')], [1, 2]);
    first.db.close();
    const second = new ControlDatabase(path, { buildId: 'test' });
    assert.equal(second.viewerGenerations.next('t'), 3);
    second.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an exhausted generation fails the attach before the previous Viewer is touched', async () => {
  const f = await fixture();
  try {
    f.store.db.prepare('UPDATE viewer_generations SET generation=4294967295 WHERE tenant=?').run(f.tenant);
    let revoked = false;
    f.control.tenants.get(f.tenant).viewer!.revoke = () => {
      revoked = true;
    };
    await assert.rejects(
      f.control.viewers.attachViewer(
        f.tenant,
        'next',
        () => {},
        { identity: 'test-account', valid: () => true },
        true,
      ),
      { code: 'limit_exceeded' },
    );
    assert.equal(revoked, false);
    assert.equal(f.control.tenants.get(f.tenant).viewer!.id, 'lease');
  } finally {
    await close(f);
  }
});

test('a new Viewer device starts a higher generation whose first occlusion is accepted and published', async () => {
  const f = await fixture();
  try {
    const { windowId, spaceId } = await openWindow(f, 'https://one.test/');
    await f.report(spaceId, [{ windowId, visible: true, occludedBottom: 100, sequence: 40 }]);
    await publishAndObserve(f.control.endpoint, f.tenant);
    const old = f.generation();
    assert.equal(last(f.endpoint.desired)!.views[0].occlusionRevision, occlusionRevision(old, 40));
    await f.control.viewers.detachViewer(f.tenant, 'lease');
    await f.control.viewers.attachViewer(
      f.tenant,
      'device-2',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const authority = {
      tenantId: f.tenant,
      leaseId: 'device-2',
      epoch: f.control.viewers.productEpoch(f.tenant, 'device-2')!,
    };
    const next = f.control.tenants.get(f.tenant).viewer!.generation;
    assert.ok(next > old);
    assert.equal(f.control.viewers.productState(f.tenant).viewer.generation, next);
    // A slow device clock cannot matter: sequence restarts at 1 and still outranks the old Viewer.
    await dispatchViewerRequest(f.control, authority, 'viewport', {
      devicePixelRatio: 1,
      activeSpaceId: spaceId,
      windows: [
        {
          windowId,
          width: 800,
          height: 600,
          visible: true,
          occludedBottom: 250,
          occlusionRevision: occlusionRevision(next, 1),
        },
      ],
    });
    await publishAndObserve(f.control.endpoint, f.tenant);
    const view = last(f.endpoint.desired)!.views[0];
    assert.equal(view.occludedBottom, 250);
    assert.equal(view.occlusionRevision, occlusionRevision(next, 1));
    assert.ok(BigInt(view.occlusionRevision) > BigInt(occlusionRevision(old, 40)));
    await f.control.viewers.detachViewer(f.tenant, 'device-2');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('an old generation is rejected and so is a regression inside the generation', async () => {
  const f = await fixture();
  try {
    const { windowId, spaceId } = await openWindow(f, 'https://one.test/');
    const generation = f.generation();
    await f.report(spaceId, [{ windowId, visible: true, sequence: 5 }]);
    await assert.rejects(f.report(spaceId, [{ windowId, visible: true, sequence: 6 }], generation - 1), {
      code: 'conflict',
      detail: STALE_GENERATION_DETAIL,
    });
    await assert.rejects(f.report(spaceId, [{ windowId, visible: true, sequence: 6 }], generation + 1), {
      code: 'conflict',
      detail: STALE_GENERATION_DETAIL,
    });
    await assert.rejects(f.report(spaceId, [{ windowId, visible: true, sequence: 4 }]), {
      code: 'conflict',
      detail: STALE_GENERATION_DETAIL,
    });
    await assert.rejects(f.report(spaceId, [{ windowId, visible: true, sequence: 0 }]), {
      code: 'invalid_request',
    });
    await f.report(spaceId, [{ windowId, visible: true, sequence: 5 }]);
    await f.report(spaceId, [{ windowId, visible: true, occludedBottom: 10, sequence: 7 }]);
  } finally {
    await close(f);
  }
});

test('the viewport must name its space strictly', async () => {
  const f = await fixture();
  try {
    const { windowId, spaceId } = await openWindow(f, 'https://one.test/');
    const send = (activeSpaceId: unknown) =>
      dispatchViewerRequest(
        f.control,
        { tenantId: f.tenant, leaseId: 'lease', epoch: f.control.viewers.productEpoch(f.tenant, 'lease')! },
        'viewport',
        {
          devicePixelRatio: 1,
          ...(activeSpaceId === undefined ? {} : { activeSpaceId }),
          windows: [
            {
              windowId,
              width: 800,
              height: 600,
              visible: true,
              occludedBottom: 0,
              occlusionRevision: occlusionRevision(f.generation(), 1),
            },
          ],
        },
      );
    for (const bad of [undefined, 3, '', 'x'.repeat(129)])
      await assert.rejects(send(bad), { code: 'invalid_request' });
    await send(spaceId);
  } finally {
    await close(f);
  }
});

test('switching spaces keeps the last published layout until the Viewer reports the new space', async () => {
  const f = await fixture();
  try {
    const a = await openWindow(f, 'https://a.test/');
    const b = await openWindow(f, 'https://b.test/');
    await observedProductAction(
      f.control,
      f.tenant,
      buildAction({ type: 'space.activate', spaceId: a.spaceId }),
      'lease',
    );
    const viewId = (windowId: string) =>
      f.store.workspaces.workspace(f.tenant).tabs.find((tab) => tab.windowId === windowId)!.webviewId;
    await f.report(a.spaceId, [
      { windowId: a.windowId, visible: true, sequence: 1 },
      { windowId: b.windowId, visible: false, sequence: 1 },
    ]);
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.deepEqual(last(f.endpoint.visibleSets()), [viewId(a.windowId)]);
    const before = f.endpoint.desired.length;

    // Control commits the switch first; the Viewer has not rendered the new space yet.
    await observedProductAction(
      f.control,
      f.tenant,
      buildAction({ type: 'space.activate', spaceId: b.spaceId }),
      'lease',
    );
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.equal(f.store.workspaces.workspace(f.tenant).activeSpaceId, b.spaceId);
    assert.equal(f.endpoint.desired.length, before, 'no intermediate layout is published');
    assert.equal(f.control.policy.qualityFor(f.tenant).resourceLimitation, null);

    await f.report(b.spaceId, [
      { windowId: a.windowId, visible: false, sequence: 2 },
      { windowId: b.windowId, visible: true, sequence: 2 },
    ]);
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.equal(f.endpoint.desired.length, before + 1, 'the new space is published once');
    assert.deepEqual(last(f.endpoint.visibleSets()), [viewId(b.windowId)]);
    const published = f.endpoint.visibleSets();
    const sets = published.slice(published.findIndex((set) => set.length > 0));
    assert.ok(
      sets.every((set) => set.length > 0),
      `A to B never passes through an empty set: ${JSON.stringify(sets)}`,
    );
  } finally {
    await close(f);
  }
});

test('disconnecting hides everything at once even while a space switch is unreported', async () => {
  const f = await fixture();
  try {
    const a = await openWindow(f, 'https://a.test/');
    const b = await openWindow(f, 'https://b.test/');
    await f.report(b.spaceId, [
      { windowId: a.windowId, visible: false, sequence: 1 },
      { windowId: b.windowId, visible: true, sequence: 1 },
    ]);
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.equal(last(f.endpoint.visibleSets())!.length, 1);
    await observedProductAction(
      f.control,
      f.tenant,
      buildAction({ type: 'space.activate', spaceId: a.spaceId }),
      'lease',
    );
    await f.control.viewers.detachViewer(f.tenant, 'lease');
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.deepEqual(last(f.endpoint.visibleSets()), []);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('locking hides everything at once even while a space switch is unreported', async () => {
  const f = await fixture();
  try {
    const a = await openWindow(f, 'https://a.test/');
    const b = await openWindow(f, 'https://b.test/');
    await f.report(b.spaceId, [
      { windowId: a.windowId, visible: false, sequence: 1 },
      { windowId: b.windowId, visible: true, sequence: 1 },
    ]);
    await publishAndObserve(f.control.endpoint, f.tenant);
    await observedProductAction(
      f.control,
      f.tenant,
      buildAction({ type: 'space.activate', spaceId: a.spaceId }),
      'lease',
    );
    await dispatchViewerRequest(
      f.control,
      {
        tenantId: f.tenant,
        leaseId: 'lease',
        epoch: f.control.viewers.productEpoch(f.tenant, 'lease')!,
      },
      'auth.lock',
      {},
    );
    await publishAndObserve(f.control.endpoint, f.tenant);
    assert.deepEqual(last(f.endpoint.visibleSets()), []);
  } finally {
    await close(f);
  }
});
