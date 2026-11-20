import type { BrowserAvailability } from '../../shared/product';
import { RemoteKitError, errorReasonMessage, type ErrorReason } from '../../shared/errors';
import type { DomainContext } from '../application';

export function browserAvailability(context: DomainContext, tenant: string): BrowserAvailability {
  const fault = context.endpoint.sessionFault(tenant);
  if (fault) return { state: 'unavailable', reason: 'browser_unavailable', errorId: fault.errorId };
  const placement = context.endpoint.placement.peek(tenant);
  const nodes = context.endpoint.nodes;
  const boundNodeId = context.endpoint.placement.boundNodeId(tenant);
  if (boundNodeId !== null && nodes.get(boundNodeId)?.state.state !== 'ready')
    return { state: 'unavailable', reason: 'session_bound_node_offline' };
  if (placement?.dataState === 'dirty' && nodes.get(placement.nodeId)?.state.state !== 'ready')
    return { state: 'unavailable', reason: 'session_data_on_offline_node' };
  if (!nodes.all().some((node) => node.state.state === 'ready' && !nodes.isRemoved(node.nodeId)))
    return { state: 'unavailable', reason: 'no_eligible_node' };
  const error = context.tenants.get(tenant).lastError;
  if (error)
    return {
      state: 'unavailable',
      reason: errorReasonMessage(error.reason) ? (error.reason as ErrorReason) : 'browser_unavailable',
      errorId: error.errorId,
    };
  return { state: context.endpoint.observation(tenant)?.browser === 'running' ? 'available' : 'starting' };
}

export function requireBrowser(context: DomainContext, tenant: string, allowStarting = false) {
  const browser = browserAvailability(context, tenant);
  if (browser.state === 'available' || (allowStarting && browser.state === 'starting')) return;
  throw new RemoteKitError(
    'unavailable',
    browser.reason === 'session_bound_node_offline'
      ? '会话绑定的节点离线，恢复后自动继续'
      : browser.reason === 'session_data_on_offline_node'
        ? '浏览器暂不可用：数据所在节点离线，恢复后自动继续'
        : browser.reason === 'no_eligible_node'
          ? '浏览器暂不可用：没有可用的节点，恢复后自动继续'
          : '浏览器暂不可用，恢复后自动继续',
    { reason: browser.reason, errorId: browser.errorId },
  );
}
