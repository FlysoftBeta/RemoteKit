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
import { defaultQuotas, type RuntimeConfig, type SessionImportConfig } from './config';
import { SessionImporter } from './session-import/importer';
import type { EndpointGateway } from './endpoint/gateway';
import type { NodeRegistry } from './cluster/node-link';
import { FileLibrary } from './files/library';
import type { createHttp } from './http/server';
import type { ControlDatabase } from './persistence/database';
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
  operations: OperationPipeline;
  reconciler: Reconciler;
  pageRequests: PageRequests;
  lifecycle: UncertainRecovery;
  popups: Popups;
  policy: SitePolicy;
  security: ViewerSecurity;
  library: FileLibrary;
  workspace: Workspace;
  accounts: AccountService;
  close(): Promise<void>;
}
export function createApplication(
  store: ControlDatabase,
  endpoint: EndpointGateway,
  fileLimits: FileLimits = FILE_LIMITS,
  clock: Clock = systemClock,
  tenantObjectBytes = defaultQuotas.tenantObjectBytes,
  sessionImport?: SessionImportConfig,
): DomainServices {
  const context: DomainContext = {
    store,
    endpoint,
    fileLimits,
    clock,
    tenants: new TenantRegistry(clock),
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
  services.objects = new ObjectIndex(
    store,
    endpoint.nodes,
    tenantObjectBytes,
    (tenant, node) => endpoint.isPlacedOn(tenant, node),
    (tenant) => endpoint.hibernating.has(tenant),
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
    endpoint,
    fileLimits,
    services.objects,
    (tenant, requestId) => services.workspace.fileSourceForRequest(tenant, requestId),
  );
  services.security = new ViewerSecurity(
    store,
    endpoint,
    (tenant, viewer, workspace) => {
      const lease = context.tenants.get(tenant).viewer?.id;
      if (!lease || !services.viewers.validSecurity(tenant, viewer)) return;
      context.events.emit('auth', tenant, lease, services.viewers.authState(tenant, viewer));
      if (workspace) {
        services.viewers.push(tenant);
        services.pageRequests.authorizeFiles(tenant);
        void context.tenants
          .serial(tenant, () => services.reconciler.reconcileProduct(tenant))
          .catch(() => {});
      }
    },
    (tenant, viewer) => services.viewers.validSecurity(tenant, viewer),
    (tenant, viewer) => {
      const runtime = context.tenants.get(tenant);
      if (!runtime.viewer || !services.viewers.validSecurity(tenant, viewer)) return;
      services.pageRequests.clearAuthorization(tenant);
      if (viewer.locked) services.pageRequests.clearFullscreen(tenant);
      runtime.quality.resetFeedback();
      void context.tenants
        .serial(tenant, async () => {
          if (!services.viewers.validSecurity(tenant, viewer)) return;
          if (!viewer.locked) services.pageRequests.authorizeFiles(tenant);
          if (viewer.locked) await services.reconciler.reconcileProduct(tenant);
        })
        .catch(() => {});
    },
    clock,
  );
  const unsubscribeActions = endpoint.onClientAction?.((event) => {
    void services.operations.handleEndpointAction(event).catch(() => {});
  });
  const unsubscribeSignals = endpoint.onSignal?.((event) => services.rtc.receiveSignal(event));
  services.close = async () => {
    context.closed = true;
    unsubscribeActions?.();
    unsubscribeSignals?.();
    await services.sessionImporter.stop();
    await context.tenants.close();
    await services.objects.close();
    await services.sessionPurge.close();
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
        console.error(error);
      },
    );
  }
  const endpointReady = (identity: { processChanged: boolean; nodeId: string }) => {
    if (!closing) run(control.reconciler.endpointReady(identity));
  };
  nodes.on('ready', endpointReady);
  const endpointOffline = (nodeId: string) => {
    if (!closing) control.rtc.endpointOffline(nodeId);
  };
  nodes.on('offline', endpointOffline);
  const reconciliationTimer = setInterval(() => {
    if (!closing) {
      run(control.reconciler.tick());
      run(control.objects.tick());
    }
  }, 1500);
  server.listen(config.port, config.host, () => {
    nodes.start();
    control.sessionImporter.start();
    const address = server.address();
    console.log(
      `RemoteKit Control ${config.tls ? 'https' : 'http'}://${config.host}:${typeof address === 'object' ? address?.port : config.port}`,
    );
  });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
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
