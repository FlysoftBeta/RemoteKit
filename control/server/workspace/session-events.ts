import type { DomainContext, DomainServices } from '../application';
import type { SessionEvent } from '../endpoint/coordination';
import type { DownloadEvent } from '../endpoint/types';
import { RemoteKitError, toRemoteKitError, wireError } from '../../shared/errors';
import { RetryLedger } from '../persistence/retry-units';
import { BackgroundJob } from '../background';

export class SessionEvents {
  private closed = false;
  failures() {
    return [
      ...this.deliveries.failures(),
      ...this.downloads.failures(),
      ...(this.downloadJob.retry.error
        ? [{ key: 'dispatch', error: wireError(this.downloadJob.retry.error) }]
        : []),
    ];
  }
  private readonly deliveries: RetryLedger;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly downloads: RetryLedger;
  private readonly downloadInflight = new Map<string, Promise<RemoteKitError | undefined>>();
  private readonly downloadJob = new BackgroundJob('session.download_dispatch', {});
  private readonly timer: NodeJS.Timeout;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listener: (input: { nodeId: string; message: SessionEvent }) => void;
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'operations' | 'viewers' | 'clipboard' | 'library' | 'learning'
    >,
  ) {
    this.downloads = new RetryLedger(context.store, 'session.download');
    this.deliveries = new RetryLedger(context.store, 'session.event');
    this.timer = setInterval(() => {
      void this.downloadJob.run(() => this.reconcileDownloads(), context.store.buildId);
    }, 1500);
    this.timer.unref();
    context.store.coordination.cancelInterruptedSignIns();
    this.listener = ({ nodeId, message }) => {
      const key = JSON.stringify([message.tenantId, message.sessionId, message.streamId]);
      const previous = this.queues.get(key) ?? Promise.resolve();
      const pending = previous.then(() => this.receive(nodeId, message));
      const settled = pending
        .catch((err) => {
          context.tenants.get(message.tenantId).lastError = toRemoteKitError(err);
        })
        .finally(() => {
          if (this.queues.get(key) === settled) this.queues.delete(key);
        });
      this.queues.set(key, settled);
    };
    context.endpoint.nodes.on('session.event', this.listener);
  }
  receive(nodeId: string, event: SessionEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = JSON.stringify([event.tenantId, event.sessionId, event.eventId]);
    const current = this.inflight.get(key);
    if (current) return current;
    const work = this.deliver(nodeId, event, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }
  private async deliver(nodeId: string, event: SessionEvent, key: string) {
    const unit = this.deliveries.unit(key);
    const previous = unit.error;
    const input = JSON.stringify([this.context.store.buildId, event.placementEpoch, event.connectionEpoch]);
    if (!unit.ready(input)) return;
    try {
      await this.apply(nodeId, event);
      this.deliveries.remove(key);
      unit.succeed();
      const runtime = this.context.tenants.get(event.tenantId);
      if (previous && runtime.lastError === previous) runtime.clearError();
    } catch (cause) {
      const failure = unit.fail(toRemoteKitError(cause));
      this.deliveries.save(key);
      if (unit.state.phase === 'faulted') this.context.endpoint.faultSession(event.tenantId, failure.error);
      unit.schedule(() => {
        void this.receive(nodeId, event).catch((error) => {
          this.context.tenants.get(event.tenantId).lastError = toRemoteKitError(error);
        });
      });
      throw failure.error;
    }
  }
  private async apply(nodeId: string, event: SessionEvent) {
    const { store, endpoint } = this.context;
    const placed = endpoint.placement.peek(event.tenantId);
    const node = endpoint.nodes.get(nodeId);
    if (
      !placed ||
      placed.nodeId !== nodeId ||
      placed.sessionId !== event.sessionId ||
      placed.placementEpoch !== event.placementEpoch ||
      node?.state.state !== 'ready' ||
      node.state.connectionEpoch !== event.connectionEpoch ||
      endpoint.sessionFault(event.tenantId)
    )
      return;
    const cursor = BigInt(store.coordination.cursor(event));
    if (BigInt(event.seq) > cursor + 1n) {
      endpoint.faultSession(
        event.tenantId,
        new RemoteKitError('invalid_request', 'Session event sequence has a gap'),
      );
      return;
    }
    if (BigInt(event.seq) > cursor) {
      let disposition: string | null;
      try {
        disposition = store.coordination.receive(event);
      } catch (error) {
        endpoint.faultSession(event.tenantId, error);
        return;
      }
      const settle = (value: string) => store.coordination.settle(event, value);
      if (disposition === null) {
        switch (event.type) {
          case 'view.closed':
            await this.context.tenants.serial(event.tenantId, async () => {
              store.transaction(() => {
                const workspace = store.workspaces.workspace(event.tenantId);
                const tab = workspace.tabs.find((tab) => tab.webviewId === event.body.viewId);
                if (tab) this.services.pageRequests.removeProductTab(workspace, tab);
                store.workspaces.saveWorkspace(workspace);
                settle('removed');
              });
              this.services.viewers.push(event.tenantId);
            });
            break;
          case 'download.imported':
          case 'download.failed': {
            const download = { ...event.body, type: event.type, eventId: event.eventId } as DownloadEvent;
            const error = await this.consumeDownload(event.tenantId, event.sessionId, download, settle);
            const runtime = this.context.tenants.get(event.tenantId);
            runtime.backgroundTasks.set(event.eventId, {
              id: event.eventId,
              kind: 'download',
              name: event.body.name,
              state:
                error?.code === 'outcome_unknown'
                  ? 'unknown'
                  : error || event.type === 'download.failed'
                    ? 'failed'
                    : 'complete',
              ...(error
                ? { error: wireError(error) }
                : event.type === 'download.failed'
                  ? { error: event.body.error }
                  : {}),
            });
            while (runtime.backgroundTasks.size > 50)
              runtime.backgroundTasks.delete(runtime.backgroundTasks.keys().next().value!);
            this.services.viewers.push(event.tenantId);
            break;
          }
          case 'clipboard.changed':
            await this.services.clipboard.changed(
              { ...event.body, type: event.type, tenantId: event.tenantId, sessionId: event.sessionId },
              settle,
            );
            break;
          case 'view.signIn': {
            const current = endpoint.observation(event.tenantId)?.browserIncarnation;
            if (current && current !== event.browserIncarnation) {
              settle('canceled');
              break;
            }
            settle('queued');
            this.services.learning.signIn.consume(
              event.tenantId,
              event.browserIncarnation ?? '',
              { ...event.body, type: event.type, eventId: event.eventId },
              (outcome) => {
                store.transaction(() => settle(outcome));
              },
            );
            break;
          }
        }
      }
      store.transaction(() => store.coordination.advance(event));
    }
    await endpoint.acknowledge({
      method: 'session.events.ack',
      tenantId: event.tenantId,
      sessionId: event.sessionId,
      placementEpoch: event.placementEpoch,
      connectionEpoch: event.connectionEpoch,
      streamId: event.streamId,
      upTo: store.coordination.cursor(event),
    });
  }
  private consumeDownload(
    tenant: string,
    sessionId: string,
    event: DownloadEvent,
    settle: (value: string) => void,
  ): Promise<RemoteKitError | undefined> {
    const key = JSON.stringify([tenant, sessionId, event.eventId]);
    const pending = this.downloadInflight.get(key);
    if (pending) return pending;
    const row = this.context.store.db
      .prepare('SELECT disposition FROM session_event_inbox WHERE tenant=? AND session_id=? AND event_id=?')
      .get(tenant, sessionId, event.eventId) as { disposition: string | null } | undefined;
    if (row?.disposition === 'recorded') return Promise.resolve(undefined);
    const work = this.applyDownload(tenant, sessionId, event, settle).finally(() =>
      this.downloadInflight.delete(key),
    );
    this.downloadInflight.set(key, work);
    return work;
  }
  private async applyDownload(
    tenant: string,
    sessionId: string,
    event: DownloadEvent,
    settle: (value: string) => void,
  ) {
    const key = JSON.stringify([tenant, sessionId, event.eventId]);
    const unit = this.downloads.unit(key);
    const revision = this.context.store.library.snapshot(tenant).revision;
    if (!unit.ready(JSON.stringify([this.context.store.buildId, revision]))) return unit.error;
    try {
      await this.services.library.consumeDownload(tenant, event);
    } catch (cause) {
      const failure = unit.fail(toRemoteKitError(cause)).error;
      this.downloads.save(key, () => settle('download_pending'));
      return failure;
    }
    this.downloads.remove(key, () => settle('recorded'));
    unit.succeed();
  }
  async reconcileDownloads() {
    for (const row of this.context.store.coordination.pendingDownloads()) {
      const event = { ...row.payload.body, type: row.payload.type, eventId: row.eventId } as DownloadEvent;
      const settle = (disposition: string) =>
        this.context.store.db
          .prepare(
            'UPDATE session_event_inbox SET disposition=? WHERE tenant=? AND session_id=? AND event_id=?',
          )
          .run(disposition, row.tenant, row.sessionId, row.eventId);
      const failure = await this.consumeDownload(row.tenant, row.sessionId, event, settle);
      if (!failure) {
        const task = this.context.tenants.get(row.tenant).backgroundTasks.get(row.eventId);
        if (task && event.type === 'download.imported') {
          task.state = 'complete';
          delete task.error;
        }
        this.services.viewers.push(row.tenant);
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.context.endpoint.nodes.off('session.event', this.listener);
    await this.downloadJob.close();
    await Promise.allSettled([
      ...this.queues.values(),
      ...this.inflight.values(),
      ...this.downloadInflight.values(),
    ]);
    this.downloads.close();
    this.deliveries.close();
  }
}
