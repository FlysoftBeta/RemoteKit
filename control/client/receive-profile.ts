export type ReceiveProfile = 'native' | 'chrome89-h264-42' | 'chrome89-h264-51' | 'h264-level42-experimental';
export interface ReceiveCodecCapability { mimeType: string; clockRate: number; sdpFmtpLine?: string }
const constrainedBaselineMode1 = (parameters: string) => /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(parameters) && /(?:^|;)\s*profile-level-id=42e0[0-9a-f]{2}(?:;|$)/i.test(parameters);
export function supportsExperimentalH264Level42(codecs: readonly ReceiveCodecCapability[] | undefined) {
  return !!codecs?.some(codec => codec.mimeType.toLowerCase() === 'video/h264' && codec.clockRate === 90000 && constrainedBaselineMode1(codec.sdpFmtpLine ?? ''));
}
export const isChrome89 = (userAgent: string) => /(?:Chrome|Chromium)\/89\./.test(userAgent);

export function chooseReceiveProfile(userAgent: string, saved?: string | null): ReceiveProfile {
  if (saved === 'native' || saved === 'h264-level42-experimental' || isChrome89(userAgent) && (saved === 'chrome89-h264-42' || saved === 'chrome89-h264-51')) return saved;
  return /\bChrome\/89\.0\.4389\.90(?:\s|$)/.test(userAgent) && !/Android|Mobile|iPhone|iPad|Edg\/|OPR\//.test(userAgent) ? 'chrome89-h264-42' : 'native';
}
export function loadReceiveProfile(): ReceiveProfile { return chooseReceiveProfile(typeof navigator === 'undefined' ? '' : navigator.userAgent); }
export function configureReceiveOffer(sdp: string, profile: ReceiveProfile, userAgent: string, codecs?: readonly ReceiveCodecCapability[]) {
  if (profile === 'native') return { sdp, changes: [] as { payload: string; original: string; effective: string }[] };
  const experimental = profile === 'h264-level42-experimental';
  if (experimental && !supportsExperimentalH264Level42(codecs)) throw new Error('实验接收档需要客户端支持 H.264 constrained-baseline / packetization-mode=1。');
  if (!experimental && !isChrome89(userAgent)) throw new Error('Chrome 89 实验接收档只适用于明确的 Chrome 89 测试客户端。');
  const target = profile === 'chrome89-h264-51' ? '42e033' : '42e02a';
  const changes: { payload: string; original: string; effective: string }[] = [];
  let videoPayloads = new Set<string>();
  const h264Payloads = new Set<string>();
  let section = 0;
  if (experimental) {
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith('m=')) { section++; videoPayloads = line.startsWith('m=video ') && line.split(/\s+/)[1] !== '0' ? new Set(line.split(/\s+/).slice(3)) : new Set(); }
      const rtp = line.match(/^a=rtpmap:(\d+) H264\/90000\s*$/i);
      if (rtp && videoPayloads.has(rtp[1])) h264Payloads.add(`${section}:${rtp[1]}`);
    }
  }
  section = 0;
  const lines = sdp.split(/\r?\n/).map(line => {
    if (line.startsWith('m=')) section++;
    const match = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (!match || !constrainedBaselineMode1(match[2]) || experimental && !h264Payloads.has(`${section}:${match[1]}`)) return line;
    const effective = line.replace(/profile-level-id=42e0[0-9a-f]{2}/i, `profile-level-id=${target}`);
    changes.push({ payload: match[1], original: line, effective }); return effective;
  });
  if (!changes.length) throw new Error('原始 offer 没有 constrained-baseline / mode1，无法应用此实验接收档。');
  return { sdp: lines.join('\r\n'), changes };
}
export function originalGatheredOffer(effective: string, original: string) {
  const fmtp = new Map(original.split(/\r?\n/).filter(line => line.startsWith('a=fmtp:')).map(line => [line.split(' ')[0], line]));
  return effective.split(/\r?\n/).map(line => line.startsWith('a=fmtp:') ? fmtp.get(line.split(' ')[0]) ?? line : line).join('\r\n');
}
export async function probeReceiveCapabilities() {
  const configurations = [
    { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.42E02A"', width: 1920, height: 1080, bitrate: 24000000, framerate: 60 } },
    { type: 'webrtc', video: { contentType: 'video/H264;profile-level-id=42e02a;packetization-mode=1', width: 1920, height: 1080, bitrate: 24000000, framerate: 60 } },
    { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.42E033"', width: 1640, height: 2360, bitrate: 24000000, framerate: 60 } },
  ];
  const api = navigator.mediaCapabilities;
  const results = [];
  for (const configuration of configurations) {
    try { if (!api?.decodingInfo) throw new Error('MediaCapabilities.decodingInfo unavailable'); const result = await api.decodingInfo(configuration as MediaDecodingConfiguration); results.push({ configuration, result: { supported: result.supported, smooth: result.smooth, powerEfficient: result.powerEfficient } }); }
    catch (error) { results.push({ configuration, error: String(error) }); }
  }
  return { userAgent: navigator.userAgent, results };
}

export interface ProductReceiveSelection { profile: ReceiveProfile; reason: string }
export async function selectProductReceiveProfile(userAgent: string, codecs: readonly ReceiveCodecCapability[] | undefined,
  probe: ((configuration: { codec: string; codedWidth: number; codedHeight: number }) => Promise<{ supported?: boolean }>) | undefined =
    typeof VideoDecoder === 'undefined' ? undefined : configuration => VideoDecoder.isConfigSupported(configuration)) : Promise<ProductReceiveSelection> {
  if (isChrome89(userAgent)) return { profile: chooseReceiveProfile(userAgent), reason: 'Chrome89 compatibility profile' };
  if (!supportsExperimentalH264Level42(codecs)) return { profile: 'native', reason: 'H264 constrained-baseline mode1 RTP codec unavailable' };
  if (!probe) return { profile: 'native', reason: 'VideoDecoder capability probe unavailable' };
  try {
    const result = await probe({ codec: 'avc1.42e02a', codedWidth: 1936, codedHeight: 1088 });
    return result.supported ? { profile: 'h264-level42-experimental', reason: 'VideoDecoder supports avc1.42e02a at 1936x1088' } : { profile: 'native', reason: 'VideoDecoder rejected H264 level4.2 at 1936x1088' };
  } catch (error) { return { profile: 'native', reason: 'VideoDecoder capability probe failed: ' + String(error) }; }
}
