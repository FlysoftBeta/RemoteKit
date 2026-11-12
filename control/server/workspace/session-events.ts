import type { DomainContext, DomainServices } from '../application';
import type { SessionEvent } from '../endpoint/coordination';
import type { DownloadEvent } from '../endpoint/types';
import { log } from '../log';
import { toRemoteKitError } from '../../shared/errors';

export class SessionEvents {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listener: (input: { nodeId: string; message: SessionEvent }) => void;
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'operations' | 'viewers' | 'clipboard' | 'library' | 'learning'
    >,
  ) {
    context.store.coordination.cancelInterruptedSignIns();
    this.listener = ({ nodeId, message }) => {
      const key = JSON.stringify([message.tenantId, message.sessionId, message.streamId]);
      const previous = this.queues.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => this.receive(nodeId, message));
      this.queues.set(key, pending);
      void pending
        .catch((err) =>
          log.warn('session.event_failed', {
            tenant: message.tenantId,
            eventId: message.eventId,
            ...(message.type === 'clipboard.changed' ? { code: toRemoteKitError(err).code } : { err }),
          }),
        )
        .finally(() => {
          if (this.queues.get(key) === pending) this.queues.delete(key);
        });
    };
    context.endpoint.nodes.on('session.event', this.listener);
  }
  async receive(nodeId: string, event: SessionEvent) {
    const { store, endpoint } = this.context;
    const placed = endpoint.placement.peek(event.tenantId);
    const node = endpoint.nodes.get(nodeId);
    if (
      !placed ||
      placed.nodeId !== nodeId ||
      placed.sessionId !== event.sessionId ||
      placed.placementEpoch !== event.placementEpoch ||
      node?.state.state !== 'ready' ||
      node.state.connectionEpoch !== event.connectionEpoch
    )
      return;
    const cursor = BigInt(store.coordination.cursor(event));
    if (BigInt(event.seq) > cursor + 1n) return;
    if (BigInt(event.seq) > cursor) {
      const disposition = store.coordination.receive(event);
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
            await this.services.library.consumeDownload(event.tenantId, download);
            store.transaction(() => settle('recorded'));
            const runtime = this.context.tenants.get(event.tenantId);
            runtime.backgroundTasks.set(event.eventId, {
              id: event.eventId,
              kind: 'download',
              name: event.body.name,
              state: event.type === 'download.failed' ? 'failed' : 'complete',
              ...(event.type === 'download.failed' ? { error: event.body.error } : {}),
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
          case 'client.action': {
            const runtime = this.context.tenants.get(event.tenantId);
            const valid =
              event.body.leaseId === runtime.viewer?.id &&
              event.body.connectionId === runtime.connectionId &&
              event.body.authEpoch === runtime.viewer?.security.peer?.appliedEpoch &&
              runtime.viewer?.security.locked === false;
            if (valid)
              await this.services.operations.handleEndpointAction({
                ...event.body,
                tenantId: event.tenantId,
              });
            store.transaction(() => settle(valid ? 'receipt-committed' : 'authorization-retired'));
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
  async close() {
    this.context.endpoint.nodes.off('session.event', this.listener);
    await Promise.allSettled(this.queues.values());
  }
}
