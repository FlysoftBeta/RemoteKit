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
