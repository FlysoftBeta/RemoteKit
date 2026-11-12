import { isLocalTab } from '../../shared/product';
import { RemoteKitError } from '../../shared/errors';
import type { DomainContext, DomainServices } from '../application';
import type { DesiredView, SessionDesired } from '../endpoint/coordination';
import { sitePayload } from './site-policy';

export function compileDesired(
  context: DomainContext,
  services: Pick<DomainServices, 'policy' | 'lifecycle' | 'viewers' | 'security'>,
  tenant: string,
): SessionDesired {
  const runtime = context.tenants.get(tenant);
  const placement = context.endpoint.placement.peek(tenant) ?? context.endpoint.placement.resolve(tenant);
  const node = context.endpoint.nodes.get(placement.nodeId);
  if (node?.state.state !== 'ready') throw new RemoteKitError('unavailable', 'Session node is offline');
  const state = context.store.workspaces.workspace(tenant);
  const actual = context.endpoint.observation(tenant);
  const viewer = runtime.viewer;
  const connectionId = runtime.connectionId ?? runtime.rtc.disconnectedPeer?.connectionId ?? null;
  const security = viewer?.security ?? services.security.retiring(tenant, connectionId);
  const peer = security?.peer;
  const unlocked =
    !!viewer && viewer.security.lock.state !== 'locked' && !!peer && peer.connectionId === connectionId;
  const quality = services.policy.qualityFor(tenant, state);
  const viewport = viewer?.viewport ?? runtime.lastViewport;
  const views: DesiredView[] = [];
  for (const tab of state.tabs) {
    const current = actual?.views.find((view) => view.viewId === tab.webviewId);
    const navigating =
      !!tab.navigation && !tab.navigation.resolved && ['applying', 'unknown'].includes(tab.navigation.status);
    if (isLocalTab(tab) && !current && !navigating) continue;
    if (tab.popup?.status === 'failed') continue;
    const lifecycleBlocked =
      current?.lifecycle_uncertain === true || !!tab.lifecycleRecovery || !!tab.lifecycleRecoveryError;
    const visible =
      !!viewer &&
      unlocked &&
      !quality.resourceLimitation &&
      !isLocalTab(tab) &&
      !lifecycleBlocked &&
      services.lifecycle.wantedVisible(state, tab);
    const region = viewport?.windows.find((window) => window.windowId === tab.windowId);
    const originalBrowser = navigating ? tab.navigation?.browserIncarnation : undefined;
    const oldTarget = !!originalBrowser && originalBrowser !== actual?.browserIncarnation;
    const provisional =
      tab.popup?.status === 'pending' && actual?.browserIncarnation
        ? { browserIncarnation: actual.browserIncarnation, provisionalId: tab.popup.provisionalId }
        : undefined;
    views.push({
      viewId: tab.webviewId,
      presence: isLocalTab(tab) || lifecycleBlocked || oldTarget ? 'ifPresent' : 'ensure',
      url: navigating ? (current?.url ?? 'about:blank') : tab.url,
      width: region?.width ?? 1440,
      height: region?.height ?? 900,
      device: { mode: 'desktop', deviceScaleFactor: quality.effectiveDpr },
      visible,
      occludedBottom: visible ? (region?.occludedBottom ?? 0) : 0,
      occlusionRevision: region?.occlusionRevision ?? '1',
      ...(tab.signIn ? { signIn: tab.signIn } : {}),
      ...(provisional ? { adopt: provisional } : {}),
    });
  }
  const user = context.store.accounts.userForTenant(tenant);
  const clipboard = user && context.store.clipboards.latest(user.id);
  const files = unlocked
    ? (runtime.pageRequests.files ?? [])
        .slice(0, 64)
        .map((request) => ({ id: request.id, binding: request.binding }))
    : [];
  const desired: Omit<SessionDesired, 'revision'> = {
    method: 'session.desired',
    connectionEpoch: node.state.connectionEpoch,
    tenantId: tenant,
    sessionId: placement.sessionId,
    placementEpoch: placement.placementEpoch,
    run: placement.runState,
    commit: placement.pendingCommit,
    profileKey: context.endpoint.placement.keys(placement).profileKey,
    checkpoint: placement.checkpoint,
    sitePreferences: { sites: sitePayload(state) },
    mediaPolicy: quality.requested,
    quality: { effectiveDpr: quality.effectiveDpr },
    clipboard: {
      revision: clipboard?.revision ?? '0',
      value: { text: clipboard?.text ?? '', html: clipboard?.html ?? '' },
    },
    views,
    authorization: {
      connectionId: peer?.connectionId ?? null,
      epoch: peer?.epoch ?? 0,
      unlocked,
      files: { library: unlocked, requests: files },
    },
    lock: {
      leaseId: viewer?.id ?? null,
      epoch: security?.epoch ?? 0,
      state: unlocked ? 'unlocked' : 'locked',
    },
    library: { describe: context.endpoint.descriptionRequests(tenant) },
  };
  return { ...desired, revision: context.store.coordination.revision(desired) };
}
