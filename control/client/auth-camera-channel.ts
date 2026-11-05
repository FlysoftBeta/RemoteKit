const MAX_BUFFER = 256 * 1024;
const CHUNK_BYTES = 16384;
const CAPTURE_BUDGET_MS = 1000;
const HEADER_BYTES = 68;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CameraBinding {
  authEpoch: number;
  challengeId: string;
}
interface CameraSize {
  width: number;
  height: number;
}
interface Capture extends CameraBinding, CameraSize {
  captureId: number;
}

function validSize(width: number, height: number) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    Math.min(width, height) >= 64 &&
    Math.max(width, height) <= 640 &&
    Math.min(width, height) <= 480 &&
    width * height <= 307200
  );
}

export function packAuthCameraChunk(
  capture: Capture,
  rgba: Uint8ClampedArray,
  offset: number,
  size: number,
): ArrayBuffer {
  const packet = new ArrayBuffer(HEADER_BYTES + size);
  const header = new DataView(packet),
    bytes = new Uint8Array(packet);
  header.setUint32(0, 0x46414b52, true);
  header.setUint16(4, 1, true);
  header.setUint16(6, HEADER_BYTES, true);
  header.setUint32(8, capture.authEpoch % 0x100000000, true);
  header.setUint32(12, Math.floor(capture.authEpoch / 0x100000000), true);
  header.setUint32(16, capture.captureId, true);
  header.setUint32(20, offset, true);
  header.setUint32(24, capture.width * capture.height * 3, true);
  header.setUint16(28, capture.width, true);
  header.setUint16(30, capture.height, true);
  for (let index = 0; index < 36; ++index) bytes[32 + index] = capture.challengeId.charCodeAt(index);
  // Callers use RGB pixel-aligned chunks, so alpha never enters the wire.
  for (let source = (offset / 3) * 4, target = HEADER_BYTES; target < bytes.length; source += 4) {
    bytes[target++] = rgba[source];
    bytes[target++] = rgba[source + 1];
    bytes[target++] = rgba[source + 2];
  }
  return packet;
}

/** An ordered, server-paced RGB24 channel on the Viewer peer. It owns a
 * detached capture element, no permission prompt, audio track or model. */
export class AuthCameraChannel {
  private channel?: RTCDataChannel;
  private binding?: CameraBinding;
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private announced?: CameraSize;
  private configured = false;
  private generation = new AbortController();
  private capturing = false;
  private latestCapture = 0;
  private lastMediaTime = -1;
  private lastSentAt = -Infinity;
  private sentFrames = 0;
  private sentBytes = 0;

  constructor(private readonly changed: () => void) {}
  get ready() {
    return this.channel?.readyState === 'open';
  }
  get diagnostics() {
    return {
      channel: this.channel?.readyState,
      format: 'rgb24',
      width: this.announced?.width,
      height: this.announced?.height,
      configured: this.configured,
      framesSent: this.sentFrames,
      bytesSent: this.sentBytes,
    };
  }

  hasRecentFrame(challengeId: string) {
    return (
      this.binding?.challengeId === challengeId && performance.now() - this.lastSentAt <= CAPTURE_BUDGET_MS
    );
  }

  bind(channel?: RTCDataChannel) {
    if (channel === this.channel) return;
    const previous = this.channel;
    this.channel = channel;
    this.latestCapture = 0;
    this.sentFrames = 0;
    this.sentBytes = 0;
    this.setSource(undefined);
    if (previous) {
      previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null;
      previous.close();
    }
    if (channel) {
      channel.bufferedAmountLowThreshold = MAX_BUFFER / 2;
      channel.onopen = () => {
        if (this.channel === channel) {
          this.announce();
          this.changed();
        }
      };
      channel.onclose = channel.onerror = () => {
        if (this.channel === channel) this.bind(undefined);
      };
      channel.onmessage = (event) => {
        if (this.channel === channel) this.receive(event.data);
      };
    }
    this.changed();
  }

  setSource(stream: MediaStream | undefined, binding?: CameraBinding) {
    if (
      !stream ||
      !binding ||
      !Number.isSafeInteger(binding.authEpoch) ||
      binding.authEpoch <= 0 ||
      !UUID.test(binding.challengeId)
    ) {
      stream = undefined;
      binding = undefined;
    }
    if (
      stream === this.stream &&
      binding?.authEpoch === this.binding?.authEpoch &&
      binding?.challengeId === this.binding?.challengeId
    )
      return;
    this.resetCapture();
    this.binding = binding;
    if (stream !== this.stream) {
      this.stream = stream;
      const previous = this.video;
      this.video = undefined;
      if (previous) {
        previous.onloadedmetadata = previous.onresize = previous.onplaying = null;
        previous.pause();
        previous.srcObject = null;
      }
      this.canvas = undefined;
      if (stream) {
        const video = (this.video = document.createElement('video'));
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.onloadedmetadata =
          video.onresize =
          video.onplaying =
            () => {
              if (this.video === video) this.announce();
            };
        video.srcObject = stream;
        void video
          .play()
          .then(() => {
            if (this.video === video) this.announce();
          })
          .catch(() => {});
      }
    }
    this.announce();
  }

  private resetCapture() {
    this.generation.abort();
    this.generation = new AbortController();
    this.announced = undefined;
    this.configured = false;
    this.capturing = false;
    this.lastMediaTime = -1;
    this.lastSentAt = -Infinity;
  }

  private send(message: object) {
    const channel = this.channel,
      binding = this.binding;
    if (channel?.readyState !== 'open' || !binding) return false;
    try {
      channel.send(JSON.stringify({ version: 1, ...binding, ...message }));
      return true;
    } catch {
      return false;
    }
  }

  private announce() {
    const video = this.video;
    if (!video || !this.binding) return;
    const width = video.videoWidth,
      height = video.videoHeight;
    if (this.announced?.width === width && this.announced.height === height) return;
    if (this.announced) this.resetCapture();
    if (!validSize(width, height)) return;
    if (this.send({ type: 'auth.camera.ready', width, height, format: 'rgb24', maxFps: 5 }))
      this.announced = { width, height };
  }

  private receive(raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 2048) return;
    const binding = this.binding,
      size = this.announced;
    if (!binding || !size) return;
    try {
      const message = JSON.parse(raw);
      if (
        !message ||
        message.version !== 1 ||
        message.authEpoch !== binding.authEpoch ||
        message.challengeId !== binding.challengeId
      )
        return;
      if (message.type === 'auth.camera.config') {
        if (
          message.width !== size.width ||
          message.height !== size.height ||
          message.format !== 'rgb24' ||
          message.fps !== 5 ||
          message.chunkBytes !== CHUNK_BYTES
        )
          return;
        this.configured = this.send({ type: 'auth.camera.accept', ...size, format: 'rgb24', fps: 5 });
      } else if (
        message.type === 'auth.camera.frame' &&
        this.configured &&
        Number.isInteger(message.captureId) &&
        message.captureId > this.latestCapture &&
        message.captureId <= 0xffffffff
      ) {
        this.latestCapture = message.captureId;
        if (!this.capturing) void this.capture({ ...binding, ...size, captureId: message.captureId });
      }
    } catch {
      /* Unrecognized authentication messages cannot request capture. */
    }
  }

  private async capture(capture: Capture) {
    const channel = this.channel,
      video = this.video,
      track = this.stream?.getVideoTracks()[0];
    if (
      !channel ||
      !video ||
      track?.readyState !== 'live' ||
      track.muted ||
      video.readyState < 2 ||
      document.hidden
    )
      return;
    if (video.videoWidth !== capture.width || video.videoHeight !== capture.height) {
      this.announce();
      return;
    }
    if (video.currentTime <= this.lastMediaTime) return;
    this.lastMediaTime = video.currentTime;
    const { signal } = this.generation;
    const deadline = performance.now() + CAPTURE_BUDGET_MS;
    this.capturing = true;
    try {
      const canvas = (this.canvas ??= document.createElement('canvas'));
      if (canvas.width !== capture.width || canvas.height !== capture.height) {
        canvas.width = capture.width;
        canvas.height = capture.height;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0);
      const rgba = context.getImageData(0, 0, capture.width, capture.height).data;
      const totalBytes = capture.width * capture.height * 3;
      const chunkBytes = CHUNK_BYTES - (CHUNK_BYTES % 3);
      for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
        const size = Math.min(chunkBytes, totalBytes - offset);
        if (
          channel.bufferedAmount + HEADER_BYTES + size > MAX_BUFFER &&
          !(await this.waitForLowBuffer(channel, deadline, signal))
        )
          return;
        if (
          signal.aborted ||
          performance.now() >= deadline ||
          channel.readyState !== 'open' ||
          document.hidden
        )
          return;
        channel.send(packAuthCameraChunk(capture, rgba, offset, size));
      }
      this.sentFrames++;
      this.sentBytes += totalBytes;
      this.lastSentAt = performance.now();
    } catch {
      /* A withdrawn grant or unavailable frame is simply dropped. */
    } finally {
      if (!signal.aborted) this.capturing = false;
    }
  }

  private waitForLowBuffer(channel: RTCDataChannel, deadline: number, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        channel.removeEventListener('bufferedamountlow', low);
        resolve(ready);
      };
      const abort = () => finish(false);
      const low = () => finish(true);
      const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
      signal.addEventListener('abort', abort, { once: true });
      channel.addEventListener('bufferedamountlow', low, { once: true });
      if (signal.aborted) abort();
      else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) low();
    });
  }
}
