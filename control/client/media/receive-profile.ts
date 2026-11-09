import { RemoteKitError } from '../../shared/errors';
// The Viewer streams at the device's physical resolution, so the H.264 level it declares in its
// offer has to cover that size at the product frame rate. Browsers offer level 3.1 (about 720p30,
// 14Mbps) by default; the Endpoint fits its encode geometry and bitrate to whatever is declared.

export type H264Level = 42 | 50 | 51 | 52;
export type ReceiveProfile = 'native' | `h264-level${H264Level}`;
export type ReceiveProbeOutcome = 'supported' | 'rejected' | 'timeout' | 'error' | 'unavailable';
export type ReceiveProbeSource = 'video-decoder' | 'media-capabilities-webrtc';
export interface ReceiveCodecCapability {
  mimeType: string;
  clockRate: number;
  sdpFmtpLine?: string;
}
export interface ReceiveSize {
  width: number;
  height: number;
}
export interface ProductReceiveSelection {
  profile: ReceiveProfile;
  reason: string;
  /** Physical size the selected level has to cover. */
  required?: ReceiveSize;
  probeSource?: ReceiveProbeSource;
  /** Outcome per probed level, keyed `level<idc>`. */
  probes?: Partial<Record<`level${H264Level}`, ReceiveProbeOutcome>>;
  probeDurationMs?: number;
}
type DecoderProbe = (configuration: {
  codec: string;
  codedWidth: number;
  codedHeight: number;
}) => Promise<{ supported?: boolean }>;

const FPS = 60;
const PROBE_TIMEOUT_MS = 1500;

// ITU-T H.264 Table A-1, as in endpoint/src/media/sampling.hpp. Levels below 4.2 are not offered:
// 3.x also caps the bitrate at 14–20Mbps, below the product range.
const LEVELS: readonly { level: H264Level; fs: number; mbps: number }[] = [
  { level: 42, fs: 8704, mbps: 522240 },
  { level: 50, fs: 22080, mbps: 589824 },
  { level: 51, fs: 36864, mbps: 983040 },
  { level: 52, fs: 36864, mbps: 2073600 },
];
type LevelLimit = (typeof LEVELS)[number];

const profileLevelId = (level: H264Level) => '42e0' + level.toString(16);
const macroblocks = (width: number, height: number) => Math.ceil(width / 16) * Math.ceil(height / 16);

function fits({ width, height }: ReceiveSize, limit: LevelLimit) {
  const blocks = macroblocks(width, height);
  const axis = Math.max(Math.ceil(width / 16), Math.ceil(height / 16));
  return blocks <= limit.fs && blocks * FPS <= limit.mbps && axis * axis <= 8 * limit.fs;
}

// Lowest level that carries the native size at the product frame rate; the highest level when
// nothing does (the Endpoint then scales the atlas down to fit).
export function requiredH264Level(native: ReceiveSize): H264Level {
  return (LEVELS.find((limit) => fits(native, limit)) ?? LEVELS[LEVELS.length - 1]).level;
}

// Largest even size with the native aspect ratio that the level carries at the product frame rate.
function fitToLevel(native: ReceiveSize, limit: LevelLimit): ReceiveSize {
  if (fits(native, limit)) return native;
  let scale = Math.sqrt(Math.min(limit.fs, limit.mbps / FPS) / macroblocks(native.width, native.height));
  for (;;) {
    const size = {
      width: Math.max(2, Math.floor((native.width * scale) / 2) * 2),
      height: Math.max(2, Math.floor((native.height * scale) / 2) * 2),
    };
    if (fits(size, limit)) return size;
    scale *= 0.98;
  }
}

export function nativeReceiveSize(): ReceiveSize {
  const ratio = window.devicePixelRatio || 1;
  return {
    width: Math.round(window.screen.width * ratio),
    height: Math.round(window.screen.height * ratio),
  };
}

const constrainedBaselineMode1 = (parameters: string) =>
  /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(parameters) &&
  /(?:^|;)\s*profile-level-id=42e0[0-9a-f]{2}(?:;|$)/i.test(parameters);
export function supportsConstrainedBaselineMode1(codecs: readonly ReceiveCodecCapability[] | undefined) {
  return !!codecs?.some(
    (codec) =>
      codec.mimeType.toLowerCase() === 'video/h264' &&
      codec.clockRate === 90000 &&
      constrainedBaselineMode1(codec.sdpFmtpLine ?? ''),
  );
}
export function configureReceiveOffer(
  sdp: string,
  profile: ReceiveProfile,
  codecs?: readonly ReceiveCodecCapability[],
) {
  const changes: { payload: string; original: string; effective: string }[] = [];
  if (profile === 'native') return { sdp, changes };
  if (!supportsConstrainedBaselineMode1(codecs))
    throw new RemoteKitError(
      'rejected',
      '接收档需要客户端支持 H.264 constrained-baseline / packetization-mode=1。',
    );
  const target = profileLevelId(Number(profile.slice('h264-level'.length)) as H264Level);
  let videoPayloads = new Set<string>();
  const h264Payloads = new Set<string>();
  let section = 0;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      section++;
      videoPayloads =
        line.startsWith('m=video ') && line.split(/\s+/)[1] !== '0'
          ? new Set(line.split(/\s+/).slice(3))
          : new Set();
    }
    const rtp = line.match(/^a=rtpmap:(\d+) H264\/90000\s*$/i);
    if (rtp && videoPayloads.has(rtp[1])) h264Payloads.add(`${section}:${rtp[1]}`);
  }
  section = 0;
  const lines = sdp.split(/\r?\n/).map((line) => {
    if (line.startsWith('m=')) section++;
    const match = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (!match || !constrainedBaselineMode1(match[2]) || !h264Payloads.has(`${section}:${match[1]}`))
      return line;
    const effective = line.replace(/profile-level-id=42e0[0-9a-f]{2}/i, `profile-level-id=${target}`);
    changes.push({ payload: match[1], original: line, effective });
    return effective;
  });
  if (!changes.length)
    throw new RemoteKitError('rejected', '原始 offer 没有 constrained-baseline / mode1，无法应用此接收档。');
  return { sdp: lines.join('\r\n'), changes };
}

const sizeText = ({ width, height }: ReceiveSize) => `${width}x${height}`;

export async function selectReceiveProfile(
  codecs: readonly ReceiveCodecCapability[] | undefined,
  native: ReceiveSize,
  probe: DecoderProbe | undefined,
): Promise<ProductReceiveSelection> {
  if (!supportsConstrainedBaselineMode1(codecs))
    return { profile: 'native', reason: 'H264 constrained-baseline mode1 RTP codec unavailable' };
  const required = requiredH264Level(native);
  const candidates = LEVELS.filter((limit) => limit.level <= required).reverse();
  const probeSource: ReceiveProbeSource = probe ? 'video-decoder' : 'media-capabilities-webrtc';
  const capabilitySource = probe ? 'VideoDecoder' : 'MediaCapabilities WebRTC';
  const probeErrors: string[] = [];
  const bounded = async (
    work: () => Promise<{ supported?: boolean }>,
    label: string,
  ): Promise<ReceiveProbeOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(work),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS);
        }),
      ]);
      if (result === 'timeout') {
        probeErrors.push(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`);
        return 'timeout';
      }
      return result.supported === true ? 'supported' : 'rejected';
    } catch (error) {
      probeErrors.push(`${label}: ${String(error)}`);
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  };
  const check = (level: H264Level, size: ReceiveSize): Promise<ReceiveProbeOutcome> => {
    const id = profileLevelId(level);
    const label = `${capabilitySource} avc1.${id} ${sizeText(size)}`;
    if (probe)
      return bounded(
        () => probe({ codec: 'avc1.' + id, codedWidth: size.width, codedHeight: size.height }),
        label,
      );
    // On an insecure origin WebCodecs is absent while RTC is available.
    if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) {
      probeErrors.push(label + ': VideoDecoder and MediaCapabilities decodingInfo unavailable');
      return Promise.resolve('unavailable');
    }
    return bounded(
      () =>
        navigator.mediaCapabilities.decodingInfo({
          type: 'webrtc',
          video: {
            contentType: `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${id}`,
            width: size.width,
            height: size.height,
            bitrate: 48000000,
            framerate: FPS,
          },
        } as MediaDecodingConfiguration),
      label,
    );
  };
  // All levels are probed at once, so a slow or rejected higher level costs one timeout window.
  const sizes = candidates.map((limit) => fitToLevel(native, limit));
  const outcomes = await Promise.all(candidates.map((limit, index) => check(limit.level, sizes[index])));
  const probes = Object.fromEntries(
    candidates.map((limit, index) => [`level${limit.level}`, outcomes[index]]),
  ) as ProductReceiveSelection['probes'];
  const evidence = { required: native, probeSource, probes };
  const detail = probeErrors.length ? '; ' + probeErrors.join('; ') : '';
  const level = (index: number) => candidates[index].level;
  const covered = (index: number) =>
    index === 0 ? `covers ${sizeText(native)}@${FPS}` : `fits ${sizeText(sizes[index])}@${FPS}`;
  const supported = outcomes.indexOf('supported');
  if (supported >= 0)
    return {
      profile: `h264-level${level(supported)}`,
      reason: `${capabilitySource} supports level${level(supported) / 10}, ${covered(supported)}`,
      ...evidence,
    };
  // An undetermined probe is not evidence of a limit; Chromium's WebRTC receiver does not decode by
  // the SDP level, so declare what the native size needs rather than the browser default. Chrome 89
  // always lands here: it has no WebCodecs and its MediaCapabilities throws for type 'webrtc'.
  const undetermined = outcomes.findIndex((outcome) => outcome !== 'rejected');
  if (undetermined >= 0)
    return {
      profile: `h264-level${level(undetermined)}`,
      reason: `level${level(undetermined) / 10} ${covered(undetermined)} without decoder evidence${detail}`,
      ...evidence,
    };
  return {
    profile: 'native',
    reason: `${capabilitySource} rejected ${candidates.map((limit) => 'level' + limit.level / 10).join(', ')}`,
    ...evidence,
  };
}

// Login, WebSocket preparation and reconnects share one page-local result or in-flight probe.
const productReceiveCache = new Map<string, Promise<ProductReceiveSelection>>();
export function selectProductReceiveProfile(
  codecs: readonly ReceiveCodecCapability[] | undefined,
): Promise<ProductReceiveSelection> {
  const native = nativeReceiveSize();
  const key = JSON.stringify([codecs, native]);
  const cached = productReceiveCache.get(key);
  if (cached) return cached;
  const startedAt = performance.now();
  const probe: DecoderProbe | undefined =
    typeof VideoDecoder === 'undefined'
      ? undefined
      : (configuration) => VideoDecoder.isConfigSupported(configuration);
  const pending = selectReceiveProfile(codecs, native, probe).then((result) => ({
    ...result,
    probeDurationMs: performance.now() - startedAt,
  }));
  productReceiveCache.set(key, pending);
  if (productReceiveCache.size > 8) productReceiveCache.delete(productReceiveCache.keys().next().value!);
  return pending;
}
