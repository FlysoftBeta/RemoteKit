export type ReceiveProfile =
  | 'native'
  | 'chrome89-h264-42'
  | 'chrome89-h264-51'
  | 'h264-level42-experimental'
  | 'h264-level52'
  | 'h264-level51';
export interface ReceiveCodecCapability {
  mimeType: string;
  clockRate: number;
  sdpFmtpLine?: string;
}
const constrainedBaselineMode1 = (parameters: string) =>
  /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(parameters) &&
  /(?:^|;)\s*profile-level-id=42e0[0-9a-f]{2}(?:;|$)/i.test(parameters);
export function supportsExperimentalH264Level42(codecs: readonly ReceiveCodecCapability[] | undefined) {
  return !!codecs?.some(
    (codec) =>
      codec.mimeType.toLowerCase() === 'video/h264' &&
      codec.clockRate === 90000 &&
      constrainedBaselineMode1(codec.sdpFmtpLine ?? ''),
  );
}
export const isChrome89 = (userAgent: string) => /(?:Chrome|Chromium|HeadlessChrome)\/89\./.test(userAgent);

export function chooseReceiveProfile(userAgent: string, saved?: string | null): ReceiveProfile {
  if (
    saved === 'native' ||
    saved === 'h264-level42-experimental' ||
    saved === 'h264-level52' ||
    saved === 'h264-level51' ||
    (isChrome89(userAgent) && (saved === 'chrome89-h264-42' || saved === 'chrome89-h264-51'))
  )
    return saved;
  return /\b(?:Chrome|HeadlessChrome)\/89\.0\.4389\.90(?:\s|$)/.test(userAgent) &&
    !/Android|Mobile|iPhone|iPad|Edg\/|OPR\//.test(userAgent)
    ? 'chrome89-h264-42'
    : 'native';
}
export function loadReceiveProfile(): ReceiveProfile {
  return chooseReceiveProfile(typeof navigator === 'undefined' ? '' : navigator.userAgent);
}
export function configureReceiveOffer(
  sdp: string,
  profile: ReceiveProfile,
  userAgent: string,
  codecs?: readonly ReceiveCodecCapability[],
) {
  if (profile === 'native')
    return { sdp, changes: [] as { payload: string; original: string; effective: string }[] };
  const experimental =
    profile === 'h264-level42-experimental' || profile === 'h264-level52' || profile === 'h264-level51';
  if (experimental && !supportsExperimentalH264Level42(codecs))
    throw new Error('实验接收档需要客户端支持 H.264 constrained-baseline / packetization-mode=1。');
  if (!experimental && !isChrome89(userAgent))
    throw new Error('Chrome 89 实验接收档只适用于明确的 Chrome 89 测试客户端。');
  const target =
    profile === 'h264-level52'
      ? '42e034'
      : profile === 'chrome89-h264-51' || profile === 'h264-level51'
        ? '42e033'
        : '42e02a';
  const changes: { payload: string; original: string; effective: string }[] = [];
  let videoPayloads = new Set<string>();
  const h264Payloads = new Set<string>();
  let section = 0;
  if (experimental) {
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
  }
  section = 0;
  const lines = sdp.split(/\r?\n/).map((line) => {
    if (line.startsWith('m=')) section++;
    const match = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (
      !match ||
      !constrainedBaselineMode1(match[2]) ||
      (experimental && !h264Payloads.has(`${section}:${match[1]}`))
    )
      return line;
    const effective = line.replace(/profile-level-id=42e0[0-9a-f]{2}/i, `profile-level-id=${target}`);
    changes.push({ payload: match[1], original: line, effective });
    return effective;
  });
  if (!changes.length)
    throw new Error('原始 offer 没有 constrained-baseline / mode1，无法应用此实验接收档。');
  return { sdp: lines.join('\r\n'), changes };
}
export async function probeReceiveCapabilities() {
  const configurations = [
    {
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="avc1.42E02A"',
        width: 1920,
        height: 1080,
        bitrate: 24000000,
        framerate: 60,
      },
    },
    {
      type: 'webrtc',
      video: {
        contentType: 'video/H264;profile-level-id=42e02a;packetization-mode=1',
        width: 1920,
        height: 1080,
        bitrate: 24000000,
        framerate: 60,
      },
    },
    {
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="avc1.42E033"',
        width: 1640,
        height: 2360,
        bitrate: 24000000,
        framerate: 60,
      },
    },
  ];
  const api = navigator.mediaCapabilities;
  const results = [];
  for (const configuration of configurations) {
    try {
      if (!api?.decodingInfo) throw new Error('MediaCapabilities.decodingInfo unavailable');
      const result = await api.decodingInfo(configuration as MediaDecodingConfiguration);
      results.push({
        configuration,
        result: { supported: result.supported, smooth: result.smooth, powerEfficient: result.powerEfficient },
      });
    } catch (error) {
      results.push({ configuration, error: String(error) });
    }
  }
  return { userAgent: navigator.userAgent, results };
}

export interface ProductReceiveSelection {
  profile: ReceiveProfile;
  reason: string;
  probeDurationMs?: number;
}
const productReceiveCache = new Map<string, Promise<ProductReceiveSelection>>();
export async function selectProductReceiveProfile(
  userAgent: string,
  codecs: readonly ReceiveCodecCapability[] | undefined,
  probe:
    | ((configuration: {
        codec: string;
        codedWidth: number;
        codedHeight: number;
      }) => Promise<{ supported?: boolean }>)
    | undefined = typeof VideoDecoder === 'undefined'
    ? undefined
    : (configuration) => VideoDecoder.isConfigSupported(configuration),
): Promise<ProductReceiveSelection> {
  // Production callers share a page-local result/in-flight probe across login,
  // WebSocket preparation and reconnect. Explicit injected probes stay isolated.
  if (arguments.length < 3) {
    const key = JSON.stringify([userAgent, codecs]);
    const cached = productReceiveCache.get(key);
    if (cached) return cached;
    const startedAt = performance.now();
    const pending = selectProductReceiveProfile(userAgent, codecs, probe).then((result) => ({
      ...result,
      probeDurationMs: performance.now() - startedAt,
    }));
    productReceiveCache.set(key, pending);
    if (productReceiveCache.size > 8) productReceiveCache.delete(productReceiveCache.keys().next().value!);
    return pending;
  }
  if (isChrome89(userAgent))
    return { profile: chooseReceiveProfile(userAgent), reason: 'Chrome89 compatibility profile' };
  if (!supportsExperimentalH264Level42(codecs))
    return { profile: 'native', reason: 'H264 constrained-baseline mode1 RTP codec unavailable' };
  const probeErrors: string[] = [];
  const capabilitySource = probe ? 'VideoDecoder' : 'MediaCapabilities WebRTC';
  const bounded = async (work: Promise<{ supported?: boolean }>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (
        (
          await Promise.race([
            work,
            new Promise<{ supported: false }>((resolve) => {
              timer = setTimeout(() => {
                probeErrors.push(label + ' probe timed out after 1500ms');
                resolve({ supported: false });
              }, 1500);
            }),
          ])
        ).supported === true
      );
    } catch (error) {
      probeErrors.push(String(error));
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const supported = async (codec: string, codedWidth: number, codedHeight: number, framerate = 60) => {
    if (probe) {
      return bounded(
        Promise.resolve().then(() => probe({ codec, codedWidth, codedHeight })),
        capabilitySource + ' ' + codec,
      );
    }
    // On an insecure origin WebCodecs can be absent while RTC is available.
    // Ask the actual WebRTC decoding capability API; unsupported API/config is a conservative rejection.
    if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) {
      probeErrors.push(
        'VideoDecoder and MediaCapabilities WebRTC decodingInfo unavailable; retaining native receiver level',
      );
      return false;
    }
    try {
      return bounded(
        navigator.mediaCapabilities.decodingInfo({
          type: 'webrtc',
          video: {
            contentType:
              'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=' + codec.slice(5),
            width: codedWidth,
            height: codedHeight,
            bitrate: 48000000,
            framerate,
          },
        } as MediaDecodingConfiguration),
        capabilitySource + ' ' + codec,
      );
    } catch (error) {
      probeErrors.push(String(error));
      return false;
    }
  };
  try {
    // All three levels begin now; rejected/slow higher-level probing adds at most
    // one 1500ms budget, rather than two serial timeout windows.
    const high = supported('avc1.42e034', 3856, 2176),
      middle = supported('avc1.42e033', 3856, 2176, 29),
      compatibility = supported('avc1.42e02a', 1936, 1088);
    if (await high)
      return {
        profile: 'h264-level52',
        reason:
          capabilitySource +
          ' supports H264 level5.2 at 3856x2176; negotiated sampling still enforces FS/MBPS',
      };
    if (await middle)
      return {
        profile: 'h264-level51',
        reason:
          capabilitySource +
          ' supports H264 level5.1 at 3856x2176 / 29fps; resolution-first policy may lower actual target FPS',
      };
    if (await compatibility)
      return {
        profile: 'h264-level42-experimental',
        reason:
          capabilitySource +
          ' rejected level5.2/5.1; supports H264 level4.2 at 1936x1088' +
          (probeErrors.length ? '; ' + probeErrors.join('; ') : ''),
      };
    return {
      profile: 'native',
      reason: probeErrors.length
        ? 'Decoder capability probe failed: ' + probeErrors.join('; ')
        : 'Decoder capability rejected H264 level5.2, level5.1 and level4.2',
    };
  } catch (error) {
    return { profile: 'native', reason: 'Decoder capability probe failed: ' + String(error) };
  }
}
