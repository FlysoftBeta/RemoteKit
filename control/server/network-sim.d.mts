export interface NetworkSimulation {
  oneWayDelayMs: number;
  downlinkMbps: number;
  uplinkMbps: number;
  maxQueueBytes: number;
  maxQueueDelayMs: number;
}
export interface UdpTarget {
  address: string;
  port: number;
}
export function parseNetworkSimulation(value?: string): NetworkSimulation | undefined;
export function selectLocalCandidate(sdp: string, options?: { requireLoopback?: boolean }): UdpTarget;
export function rewriteSdp(sdp: string, relay: UdpTarget): string;
export class LoopbackRelay {
  constructor(config: NetworkSimulation, clientTarget: UdpTarget);
  bind(): Promise<this>;
  setServer(target: UdpTarget): void;
  readonly clientAddress: UdpTarget;
  readonly serverAddress: UdpTarget;
  snapshot(): any;
  close(): void;
}
