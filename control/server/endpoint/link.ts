import type { ClipboardChangedEvent, ClientActionEvent, RtcSignal } from './types';
export type EndpointLinkState =
  | { state: 'offline' }
  | { state: 'connecting' }
  | { state: 'ready'; incarnation: string; connectionEpoch: string };
export function readyTransition(
  previousIncarnation: string | undefined,
  incarnation: string,
  connectionEpoch: string,
) {
  return {
    state: { state: 'ready', incarnation, connectionEpoch } as EndpointLinkState,
    processChanged: previousIncarnation !== incarnation,
  };
}
export interface EndpointLink {
  readonly state: EndpointLinkState;
  request(method: string, tenantId: string, args?: Record<string, unknown>): Promise<unknown>;
  onClientAction?(listener: (event: ClientActionEvent) => void): () => void;
  onSignal?(listener: (event: RtcSignal) => void): () => void;
  onClipboardChanged?(listener: (event: ClipboardChangedEvent) => void): () => void;
}
