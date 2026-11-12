import { ServicePeers } from './viewers/service-peers';
import { SessionEvents } from './workspace/session-events';
import { compileDesired } from './workspace/desired';
import { log } from './log';
import { toRemoteKitError } from '../shared/errors';
import { constants, fstatSync } from 'node:fs';
import { Announcements } from './admin/announcements';
import { UserAdmin } from './admin/users';
import { NodeAdmin } from './cluster/node-admin';
import { SessionPurge } from './cluster/session-purge';
import { ObjectIndex } from './cluster/objects';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FILE_LIMITS } from '../shared/product';
import { AccountService } from './auth/accounts';
import { ViewerSecurity } from './auth/viewer-security';
import { type RuntimeConfig, type SessionImportConfig } from './config';
import { SessionImporter } from './session-import/importer';
import type { EndpointGateway } from './endpoint/gateway';
import type { NodeRegistry } from './cluster/node-link';
import { FileLibrary } from './files/library';
import type { createHttp } from './http/server';
import type { ControlDatabase } from './persistence/database';
import { ClipboardService } from './clipboard';
import { TenantRegistry } from './tenants/tenant-registry';
import { systemClock, type Clock } from './util/clock';
import { RtcSignaling } from './viewers/rtc-signaling';
import { ViewerHub } from './viewers/viewer-hub';
import { UncertainRecovery } from './workspace/lifecycle';
import { Navigation } from './workspace/navigation';
import { OperationPipeline } from './workspace/operations';
import { PageRequests, type FileLimits } from './workspace/page-requests';
import { Popups } from './workspace/popups';
import { Reconciler } from './workspace/reconciler';
import { SitePolicy } from './workspace/site-policy';
import { Workspace } from './workspace/workspace';
import { LearningService } from './learning/service';

export interface DomainContext {
  store: ControlDatabase;
  endpoint: EndpointGateway;
  tenants: TenantRegistry;
  clock: Clock;
  fileLimits: FileLimits;
  events: EventEmitter;
  serverIncarnation: string;
  closed: boolean;
}
export interface DomainServices extends DomainContext {
  sessionImporter: SessionImporter;
  objects: ObjectIndex;
  nodeAdmin: NodeAdmin;
  sessionPurge: SessionPurge;
  userAdmin: UserAdmin;
  announcements: Announcements;
  navigation: Navigation;
  viewers: ViewerHub;
  rtc: RtcSignaling;
  servicePeers: ServicePeers;
  operations: OperationPipeline;
  reconciler: Reconciler;
  pageRequests: PageRequests;
  lifecycle: UncertainRecovery;
  popups: Popups;
  policy: SitePolicy;
  security: ViewerSecurity;
  library: FileLibrary;
  clipboard: ClipboardService;
  workspace: Workspace;
  learning: LearningService;
  accounts: AccountService;
  close(): Promise<void>;
}
export function createApplication(
  store: ControlDatabase,
  endpoint: EndpointGateway,
  fileLimits: FileLimits = FILE_LIMITS,
  clock: Clock = systemClock,
  tenantObjectBytes: number | null = null,
  sessionImport?: SessionImportConfig,
): DomainServices {
  const context: DomainContext = {
    store,
    endpoint,
    fileLimits,
    clock,
    tenants: new TenantRegistry(clock, (tenant) => store.reclaim.absentSince(tenant)),
    events: new EventEmitter(),
    serverIncarnation: randomUUID(),
    closed: false,
  };
  const services = context as DomainServices;
  services.sessionImporter = new SessionImporter(
    store,
    endpoint,
    store.security.authAttempts,
    sessionImport,
    undefined,
    clock,
  );
  services.servicePeers = new ServicePeers(context, services);
  services.objects = new ObjectIndex(
    store,
    endpoint.nodes,
    tenantObjectBytes,
    (tenant, node) => endpoint.isPlacedOn(tenant, node) || services.servicePeers.hasGrant(tenant, node),
    (tenant) => Boolean(endpoint.placement.peek(tenant)?.pendingCommit),
  );
  services.nodeAdmin = new NodeAdmin(store, endpoint.nodes, endpoint.placement, services.objects);
  services.sessionPurge = new SessionPurge(store, endpoint.nodes);
  services.navigation = new Navigation(context, services);
  services.viewers = new ViewerHub(context, services);
  services.rtc = new RtcSignaling(context, services);
  services.operations = new OperationPipeline(context, services);
  services.reconciler = new Reconciler(context, services);
  services.pageRequests = new PageRequests(context, services);
  services.lifecycle = new UncertainRecovery(context, services);
  services.popups = new Popups(context, services);
  services.policy = new SitePolicy(context);
  services.accounts = new AccountService(store);
  services.userAdmin = new UserAdmin(context, services);
  services.announcements = new Announcements(context, services);
  services.workspace = new Workspace(context, services);
  services.library = new FileLibrary(
    store.library,
    {
      describeAsset: (tenant, params) => services.servicePeers.describeAsset(tenant, params),
      prepareSelection: endpoint.prepareSelection.bind(endpoint),
      selectionStatus: endpoint.selectionStatus.bind(endpoint),
    },
    fileLimits,
    services.objects,
    (tenant, requestId) => services.workspace.fileSourceForRequest(tenant, requestId),
  );
  services.objects.onAvailabilityChanged = () => {
    for (const [tenant] of context.tenants.withViewers()) services.library.refreshAvailability(tenant);
  };
  services.learning = new LearningService(context, services);
  services.clipboard = new ClipboardService(context, services);
  endpoint.setDesiredSource((tenant) => compileDesired(context, services, tenant));
  endpoint.nodes.on('session.fault', ({ target }) => {
    void endpoint.synchronize(target.tenantId).catch(() => {});
    services.viewers.push(target.tenantId);
  });
  services.security = new ViewerSecurity(
    store,
    endpoint,
    services.servicePeers,
    (tenant, viewer, workspace) => {
      if (!context.closed)
        void services.servicePeers
          .authorize(tenant)
          .catch((err) => log.warn('service.authorize_failed', { tenant, err }));
      const lease = context.tenants.get(tenant).viewer?.id;
      if (!lease || !services.viewers.validSecurity(tenant, viewer)) return;
      context.events.emit('auth', tenant, lease, services.viewers.authState(tenant, viewer));
      if (workspace) {
        services.viewers.push(tenant);
        void endpoint.synchronize(tenant).catch((err) => log.warn('session.desired_failed', { tenant, err }));
        void context.tenants
          .serial(tenant, () => services.reconciler.reconcileProduct(tenant))
          .catch((err) => log.warn('security.reconcile_failed', { tenant, err }));
      }
    },
    (tenant, viewer) => services.viewers.validSecurity(tenant, viewer),
    (tenant, viewer) => {
      const runtime = context.tenants.get(tenant);
      if (!runtime.viewer || !services.viewers.validSecurity(tenant, viewer)) return;
      if (viewer.locked) services.pageRequests.clearFullscreen(tenant);
      runtime.quality.resetFeedback();
      void context.tenants
        .serial(tenant, async () => {
          if (!services.viewers.validSecurity(tenant, viewer)) return;
          if (!viewer.locked)
            void endpoint
              .synchronize(tenant)
              .catch((err) => log.warn('session.desired_failed', { tenant, err }));
          if (viewer.locked) await services.reconciler.reconcileProduct(tenant);
        })
        .catch((err) => log.warn('security.reconcile_failed', { tenant, err }));
    },
    clock,
  );
  const sessionEvents = new SessionEvents(context, services);
  const unsubscribeSignals = endpoint.onSignal((event) => services.rtc.receiveSignal(event));
  services.close = async () => {
    context.closed = true;
    unsubscribeSignals?.();
    await services.servicePeers.dispose();
    await sessionEvents.close();
    endpoint.setDesiredSource();
    await services.learning.stop();
    await services.sessionImporter.stop();
    await context.tenants.close();
    await services.objects.close();
    await services.sessionPurge.close();
    store.reclaim.close();
    context.events.removeAllListeners();
  };
  return services;
}

export function startApplication(
  config: RuntimeConfig,
  store: ControlDatabase,
  nodes: NodeRegistry,
  control: DomainServices,
  server: ReturnType<typeof createHttp>,
) {
  let closing = false;
  const background = new Set<Promise<unknown>>();
  function run(work: Promise<unknown>) {
    background.add(work);
    void work.then(
      () => background.delete(work),
      (error) => {
        background.delete(work);
        log.error('background.run_failed', { err: error });
      },
    );
  }
  const endpointReady = (identity: { processChanged: boolean; nodeId: string }) => {
    if (!closing) {
      for (const [tenant] of control.tenants.withViewers()) control.library.refreshAvailability(tenant);
      run(control.reconciler.endpointReady(identity));
    }
  };
  nodes.on('ready', endpointReady);
  const endpointOffline = (nodeId: string) => {
    if (!closing) control.rtc.endpointOffline(nodeId);
  };
  nodes.on('offline', endpointOffline);
  const reconciliationTimer = setInterval(() => {
    if (!closing) {
      run(control.reconciler.tick());
      run(
        control.objects.tick().then(() => {
          for (const [tenant] of control.tenants.withViewers()) control.library.refreshAvailability(tenant);
        }),
      );
      run(control.servicePeers.tick());
    }
  }, 1500);
  server.listen(config.port, config.host, () => {
    if (closing) return;
    nodes.start();
    control.sessionImporter.start();
    control.learning.start();
    const address = server.address();
    log.info('control.started', {
      buildId: config.buildId,
      pid: process.pid,
      listen: `${config.tls ? 'https' : 'http'}://${config.host}:${typeof address === 'object' ? address?.port : config.port}`,
    });
  });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    process.stdin.off('end', stdinClosed);
    process.stdin.off('close', stdinClosed);
    if (pipedStdin) process.stdin.pause();
    clearInterval(reconciliationTimer);
    nodes.off('ready', endpointReady);
    nodes.off('offline', endpointOffline);
    closePromise = (async () => {
      await server.shutdown();
      while (background.size) await Promise.allSettled([...background]);
      await control.close();
      await nodes.stop();
      store.db.close();
    })();
    return closePromise;
  }
  function stdinClosed() {
    void close();
  }
  const stdinStat = fstatSync(0);
  // Node's Stats.isFIFO() always returns false on Windows, even for anonymous pipes.
  const pipedStdin =
    stdinStat.isFIFO() ||
    (process.platform === 'win32' && (stdinStat.mode & constants.S_IFMT) === constants.S_IFIFO);
  if (pipedStdin) {
    process.stdin.once('end', stdinClosed);
    process.stdin.once('close', stdinClosed);
    process.stdin.resume();
    if (process.stdin.readableEnded || process.stdin.destroyed) stdinClosed();
  }
  process.on('SIGINT', () => {
    void close();
  });
  process.on('SIGTERM', () => {
    void close();
  });
  process.once('disconnect', () => {
    void close();
  });
}
