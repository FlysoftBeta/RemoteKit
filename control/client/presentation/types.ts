export interface Surface {
  id: string;
  session: string;
  instance: string;
  document: string;
  focus: string;
  x: number;
  y: number;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mediaScale?: number;
  mediaScaleX?: number;
  mediaScaleY?: number;
  stale?: boolean;
}
export interface Layout {
  type: 'layout';
  generation: string;
  epoch: string;
  width: number;
  height: number;
  views: Surface[];
  reconfiguring?: true;
}
export interface VideoPresentation {
  viewId: string;
  rtpTimestamp: number;
  layoutEpoch: string;
  paintedAt: number;
  paintedWallTime: number;
  authorizedAt: number;
}

import type { PlaneIdentity } from './plane-source';
import type { PresentationBarrier } from './video-presentation';
export interface PlaneRenderer extends PlaneIdentity {
  canvas: HTMLCanvasElement;
  ready: (ready: boolean) => void;
}
export interface ViewportRegistration {
  viewId: string;
  canvas: HTMLCanvasElement;
  ready: (ready: boolean) => void;
  renderer?: PlaneRenderer;
  remove?: () => void;
}
export interface VideoObservation {
  sequence: number;
  barrier: PresentationBarrier;
  peer: RTCPeerConnection;
  track: MediaStreamTrack;
  attempt: number;
  identity: PlaneIdentity;
  rtp: number;
  at: number;
  wall: number;
}
