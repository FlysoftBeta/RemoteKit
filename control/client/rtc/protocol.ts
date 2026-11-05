export type FileMethod =
  | 'photo.burst.sample'
  | 'asset.begin'
  | 'asset.chunk'
  | 'asset.seal'
  | 'asset.cancel'
  | 'asset.read'
  | 'asset.describe'
  | 'photo.burst.begin'
  | 'photo.burst.end'
  | 'photo.burst.cancel'
  | 'photo.thumbnail'
  | 'photo.process'
  | 'selection.cancel'
  | 'selection.commit';
import { httpStatus, type WireError } from '../../shared/errors';
import type { Layout, Surface } from '../presentation/types';
export interface EditableView {
  session: string;
  id: string;
  instance: string;
  document: string;
  focus: string;
}
export interface RemoteEditable {
  type: number;
  flags: number;
  active: boolean;
  target: string;
  selectionStart: number;
  selectionEnd: number;
  compositionStart: number;
  compositionEnd: number;
  caretX: number;
  caretY: number;
  caretWidth: number;
  caretHeight: number;
}
export interface EditableMessage {
  type: 'input.editable';
  version: 1;
  revision: string;
  view: EditableView | null;
  editable: RemoteEditable;
}

import type { OperationReceipt, ProductOperation } from '../../shared/product';
import type { CaptureTiming } from '../media/capture-latency';
import type { MediaFeedback } from '../media/media-feedback';
import type { PresentationBarrier } from '../presentation/video-presentation';

type Authorized = { authEpoch?: number };
export type InputResultMessage = {
  type: 'input.result';
  clientSequence: string;
  ok: boolean;
  error?: WireError;
};
export type FocusMessage = {
  type: 'focus';
  focusRequestId: string;
  layoutEpoch: string;
  ok: boolean;
  token?: { view: string; session: string; instance: string; document: string; focus: string };
  error?: WireError;
};
export type FrameMessage = {
  type: 'frame';
  rtpTimestamp: number;
  layoutEpoch: string;
  encodedBytes?: number;
  keyframe?: boolean;
} & Partial<CaptureTiming>;
export type FileResult = {
  type: 'files.result';
  version: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
};
export type ProductResult = {
  type: 'product.result';
  version: 1;
  operationId: string;
  operationGeneration: string;
} & ({ result: OperationReceipt; error?: WireError } | { result?: undefined; error: WireError });
type CameraBinding = { version: 1; authEpoch: number; challengeId: string };
export type Incoming = Authorized &
  (
    | Layout
    | EditableMessage
    | InputResultMessage
    | FocusMessage
    | FrameMessage
    | FileResult
    | ProductResult
    | { type: 'clock.pong'; version: 1; requestId: string; serverTimeMs: number; serverMonotonicMs: number }
    | { type: 'presentation.mode'; version: 1; backend: 'video' }
    | ({ type: 'presentation.prepare' } & PresentationBarrier)
    | ({ type: 'stats' } & Record<string, unknown>)
    | { type: 'error'; error: WireError }
    | (CameraBinding & {
        type: 'auth.camera.config';
        width: number;
        height: number;
        format: 'rgb24';
        fps: 5;
        chunkBytes: 16384;
      })
    | (CameraBinding & { type: 'auth.camera.frame'; captureId: number })
  );
type InputTarget = {
  view: string;
  session: string;
  instance: string;
  document: string;
  focus: string;
  layoutEpoch: string;
};
export type Outgoing = Authorized &
  (
    | {
        type: 'files.request';
        version: 1;
        requestId: string;
        method: FileMethod;
        params: Record<string, unknown>;
      }
    | ({ type: 'product.action'; version: 1 } & ProductOperation)
    | { type: 'clock.ping'; version: 1; requestId: string }
    | { type: 'media.refresh' }
    | { type: 'media.presentation'; version: 1; backend: 'video'; restart?: true }
    | MediaFeedback
    | ({ type: 'presentation.ready' } & PresentationBarrier)
    | ({
        type: 'input';
        outputGeneration: string;
        sequence: string;
        event: Record<string, unknown>;
      } & InputTarget)
    | ({ type: 'focus'; focusRequestId: string; focused: boolean } & InputTarget)
    | (CameraBinding & {
        type: 'auth.camera.ready';
        width: number;
        height: number;
        format: 'rgb24';
        maxFps: 5;
      })
    | (CameraBinding & { type: 'auth.camera.accept'; width: number; height: number; format: 'rgb24'; fps: 5 })
  );

export type DecodeError = { type: 'decode-error'; reason: string };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const wireError = (v: unknown): v is WireError =>
  object(v) &&
  typeof v.code === 'string' &&
  Object.prototype.hasOwnProperty.call(httpStatus, v.code) &&
  typeof v.message === 'string';
const resultError = (v: Record<string, unknown>) =>
  v.ok === false ? wireError(v.error) : optional(v, 'error', wireError);
const string = (v: unknown): v is string => typeof v === 'string';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sequence = (v: unknown): v is string => string(v) && /^(0|[1-9]\d{0,19})$/.test(v);
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v) && v >= 0;
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((key) => string(v[key]));
const numbers = (v: Record<string, unknown>, keys: string[]) => keys.every((key) => number(v[key]));
const optional = (v: Record<string, unknown>, key: string, check: (value: unknown) => boolean) =>
  v[key] === undefined || check(v[key]);
function surface(v: unknown): v is Surface {
  return (
    object(v) &&
    strings(v, ['id', 'session', 'instance', 'document', 'focus']) &&
    numbers(v, ['x', 'y', 'width', 'height', 'deviceScaleFactor']) &&
    ['mediaScale', 'mediaScaleX', 'mediaScaleY'].every((key) => optional(v, key, number)) &&
    optional(v, 'stale', (value) => typeof value === 'boolean')
  );
}
function receipt(v: unknown) {
  return (
    object(v) &&
    strings(v, ['operationId', 'operationGeneration']) &&
    ['accepted', 'applying', 'committed', 'rejected', 'unknown', 'expired'].includes(String(v.status)) &&
    optional(v, 'error', string) &&
    optional(v, 'revision', integer) &&
    optional(v, 'resolved', (value) => typeof value === 'boolean')
  );
}
function valid(v: Record<string, unknown>): boolean {
  switch (v.type) {
    case 'layout':
      return (
        sequence(v.generation) &&
        sequence(v.epoch) &&
        numbers(v, ['width', 'height']) &&
        Array.isArray(v.views) &&
        v.views.every(surface) &&
        optional(v, 'reconfiguring', (value) => value === true)
      );
    case 'input.editable': {
      const e = v.editable,
        view = v.view;
      return (
        v.version === 1 &&
        sequence(v.revision) &&
        (view === null ||
          (object(view) && strings(view, ['id', 'session', 'instance', 'document', 'focus']))) &&
        object(e) &&
        typeof e.active === 'boolean' &&
        sequence(e.target) &&
        (e.active ? e.target !== '0' && view !== null : e.target === '0') &&
        integer(e.type) &&
        e.type <= 17 &&
        Number.isInteger(e.flags) &&
        numbers(e, [
          'selectionStart',
          'selectionEnd',
          'compositionStart',
          'compositionEnd',
          'caretX',
          'caretY',
          'caretWidth',
          'caretHeight',
        ])
      );
    }
    case 'input.result':
      return string(v.clientSequence) && typeof v.ok === 'boolean' && resultError(v);
    case 'focus':
      return (
        strings(v, ['focusRequestId', 'layoutEpoch']) &&
        typeof v.ok === 'boolean' &&
        resultError(v) &&
        optional(
          v,
          'token',
          (value) => object(value) && strings(value, ['view', 'session', 'instance', 'document', 'focus']),
        )
      );
    case 'frame':
      return (
        integer(v.rtpTimestamp) &&
        v.rtpTimestamp <= 0xffffffff &&
        sequence(v.layoutEpoch) &&
        optional(v, 'encodedBytes', integer) &&
        optional(v, 'keyframe', (value) => typeof value === 'boolean') &&
        ['captureWallTimeMs', 'captureMonotonicMs', 'captureClockUncertaintyMs'].every((key) =>
          optional(v, key, number),
        ) &&
        optional(v, 'sourceCaptureId', sequence)
      );
    case 'files.result':
      return v.version === 1 && string(v.requestId) && typeof v.ok === 'boolean' && resultError(v);
    case 'product.result':
      return (
        v.version === 1 &&
        strings(v, ['operationId', 'operationGeneration']) &&
        optional(v, 'result', receipt) &&
        (v.result === undefined ||
          (object(v.result) &&
            v.result.operationId === v.operationId &&
            v.result.operationGeneration === v.operationGeneration)) &&
        (v.result !== undefined || wireError(v.error)) &&
        optional(v, 'error', wireError)
      );
    case 'clock.pong':
      return v.version === 1 && string(v.requestId) && numbers(v, ['serverTimeMs', 'serverMonotonicMs']);
    case 'presentation.mode':
      return v.version === 1 && v.backend === 'video';
    case 'presentation.prepare':
      return (
        v.version === 1 && ['barrierId', 'outputGeneration', 'layoutEpoch'].every((key) => sequence(v[key]))
      );
    case 'stats':
      return true;
    case 'error':
      return wireError(v.error);
    case 'auth.camera.config':
      return (
        v.version === 1 &&
        integer(v.authEpoch) &&
        string(v.challengeId) &&
        integer(v.width) &&
        integer(v.height) &&
        v.format === 'rgb24' &&
        v.fps === 5 &&
        v.chunkBytes === 16384
      );
    case 'auth.camera.frame':
      return (
        v.version === 1 &&
        integer(v.authEpoch) &&
        string(v.challengeId) &&
        integer(v.captureId) &&
        v.captureId > 0 &&
        v.captureId <= 0xffffffff
      );
    default:
      return false;
  }
}
export function decodeIncoming(raw: unknown): Incoming | DecodeError {
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { type: 'decode-error', reason: 'Invalid JSON' };
  }
  if (!object(value) || !optional(value, 'authEpoch', integer) || !valid(value))
    return { type: 'decode-error', reason: `Invalid ${object(value) ? String(value.type) : 'message'}` };
  return value as Incoming;
}
export function encodeOutgoing(message: Outgoing): string {
  return JSON.stringify(message);
}

export const AUTH_CAMERA_HEADER_BYTES = 68;
export interface AuthCameraCapture {
  authEpoch: number;
  challengeId: string;
  captureId: number;
  width: number;
  height: number;
}
export function encodeAuthCameraChunk(
  capture: AuthCameraCapture,
  rgba: Uint8ClampedArray,
  offset: number,
  size: number,
): ArrayBuffer {
  const packet = new ArrayBuffer(AUTH_CAMERA_HEADER_BYTES + size);
  const header = new DataView(packet),
    bytes = new Uint8Array(packet);
  header.setUint32(0, 0x46414b52, true);
  header.setUint16(4, 1, true);
  header.setUint16(6, AUTH_CAMERA_HEADER_BYTES, true);
  header.setUint32(8, capture.authEpoch % 0x100000000, true);
  header.setUint32(12, Math.floor(capture.authEpoch / 0x100000000), true);
  header.setUint32(16, capture.captureId, true);
  header.setUint32(20, offset, true);
  header.setUint32(24, capture.width * capture.height * 3, true);
  header.setUint16(28, capture.width, true);
  header.setUint16(30, capture.height, true);
  for (let index = 0; index < 36; ++index) bytes[32 + index] = capture.challengeId.charCodeAt(index);
  // Callers use RGB pixel-aligned chunks, so alpha never enters the wire.
  for (let source = (offset / 3) * 4, target = AUTH_CAMERA_HEADER_BYTES; target < bytes.length; source += 4) {
    bytes[target++] = rgba[source];
    bytes[target++] = rgba[source + 1];
    bytes[target++] = rgba[source + 2];
  }
  return packet;
}
