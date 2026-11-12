import { createHash } from 'node:crypto';
import type { SessionDesired, SessionObserved, SessionTarget } from '../server/endpoint/coordination';
import type { EndpointSnapshot } from '../server/endpoint/types';

export function observedSession(
  target: SessionTarget,
  connectionEpoch: string,
  incarnation: string,
  desired?: SessionDesired,
  snapshot: Partial<EndpointSnapshot> = {},
): SessionObserved {
  const running = snapshot.running ?? desired?.run === 'running';
  const committed = desired?.commit
    ? {
        requestId: desired.commit,
        manifestId: createHash('sha256')
          .update(target.sessionId + desired.commit)
          .digest('hex'),
      }
    : null;
  return {
    tenantId: target.tenantId,
    sessionId: target.sessionId,
    placementEpoch: target.placementEpoch,
    event: 'session.observed',
    connectionEpoch,
    endpointIncarnation: incarnation,
    nodeRevision: '1',
    seq: '1',
    observedRevision: desired?.revision ?? '0',
    converged: true,
    browser: running ? 'running' : 'stopped',
    browserIncarnation: running ? (snapshot.browserIncarnation ?? 'browser-1') : null,
    browserPid: running ? (snapshot.browserPid ?? 10) : 0,
    browserRestart: 'ready',
    data: desired
      ? {
          state: running ? 'dirty' : 'clean',
          base: committed?.manifestId ?? desired.checkpoint,
          stoppedCleanly: !running,
          changesAt: 0,
          committed,
          lastVersion: null,
        }
      : null,
    checkpoint: committed
      ? {
          manifestId: committed.manifestId,
          objects: [committed.manifestId],
          buildId: 'test',
          kind: 'stopped',
          takenAt: Date.now(),
        }
      : null,
    applied: {
      sitePreferencesRevision: desired?.revision ?? '0',
      mediaPolicyRevision: desired?.revision ?? '0',
      viewsRevision: desired?.revision ?? '0',
      clipboardRevision: desired?.clipboard.revision ?? '0',
    },
    authorization: {
      connectionId: desired?.authorization.connectionId ?? null,
      epoch: desired?.authorization.epoch ?? 0,
      unlocked: desired?.authorization.unlocked ?? false,
      revoked: !desired?.authorization.unlocked,
      filesApplied: desired?.authorization.unlocked ?? false,
    },
    lock: desired?.lock ?? { leaseId: null, epoch: 0, state: 'locked' },
    views:
      snapshot.views ??
      (running
        ? (desired?.views ?? [])
            .filter((view) => view.presence === 'ensure')
            .map((view) => ({
              ...view,
              instance: '1',
              document: '1',
              actual: 0,
              pending: false,
              canDiscard: true,
            }))
        : []),
    pendingPopups: snapshot.pendingPopups ?? [],
    recovery: { pending: false, views: {}, exportPending: false },
    rtc: {
      active: snapshot.rtc?.active ?? false,
      connectionId: snapshot.rtc?.connectionId ?? null,
      avSync: snapshot.rtc?.avSync ?? null,
    },
    blockers: snapshot.stopBlockers ?? {
      unacknowledgedEvents: 0,
      pendingNativeSelections: 0,
      inFlightUploads: 0,
      pendingPageRequests: 0,
      downloadsInProgress: 0,
      pendingDownloadImports: 0,
      rtcConnected: false,
      lifecycleUncertain: false,
    },

    events: { streamId: 'fixture-stream', ackedThrough: '0', lastSeq: '0' },
    stats: snapshot.stats ?? {},
    lastError: snapshot.status ?? null,
  } as SessionObserved;
}

export function applyDesiredViews(views: Map<string, any>, desired: SessionDesired) {
  const changes: { method: string; args: any }[] = [];
  const wanted = new Set(desired.views.map((view) => view.viewId));
  for (const key of views.keys()) if (!wanted.has(key)) views.delete(key);
  for (const config of desired.views) {
    let current = views.get(config.viewId);
    if (!current && config.presence === 'ifPresent') continue;
    if (!current) {
      current = {
        viewId: config.viewId,
        url: config.url,
        instance: '1',
        document: '1',
        actual: 0,
        pending: false,
        loading: false,
        canDiscard: true,
      };
      views.set(config.viewId, current);
      changes.push({ method: 'view.created', args: { ...config } });
    }
    const geometry = {
      width: config.width,
      height: config.height,
      visible: config.visible,
      device: config.device,
      deviceScaleFactor: config.device.deviceScaleFactor,
      occludedBottom: config.occludedBottom,
      occlusionRevision: config.occlusionRevision,
    };
    if (
      Object.entries(geometry).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
    ) {
      Object.assign(current, geometry);
      changes.push({ method: 'view.configured', args: { ...config } });
    }
  }
  return changes;
}

import { readFileSync } from 'node:fs';
import type { EndpointGateway } from '../server/endpoint/gateway';
import { canonical } from '../server/endpoint/coordination';
export function installDesiredSource(gateway: EndpointGateway) {
  const revisions = new Map<string, { key: string; revision: bigint }>();
  gateway.setDesiredSource((tenant) => {
    const current = gateway.placement.peek(tenant);
    const placement = current?.pendingCommit ? current : gateway.placement.resolve(tenant);
    const node = gateway.nodes.get(placement.nodeId)!;
    if (node.state.state !== 'ready') throw new Error('Node offline');
    const document = JSON.parse(
      readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
    ) as SessionDesired;
    Object.assign(document, {
      tenantId: tenant,
      sessionId: placement.sessionId,
      placementEpoch: placement.placementEpoch,
      run: placement.runState,
      commit: placement.pendingCommit,
      checkpoint: placement.checkpoint,
      views: [],
      connectionEpoch: node.state.connectionEpoch,
      profileKey: gateway.placement.keys(placement).profileKey,
    });
    const { revision, connectionEpoch, ...content } = document;
    const key = canonical(content);
    const previous = revisions.get(tenant);
    const next = previous?.key === key ? previous.revision : (previous?.revision ?? 0n) + 1n;
    revisions.set(tenant, { key, revision: next });
    document.revision = String(next);
    return document;
  });
}
