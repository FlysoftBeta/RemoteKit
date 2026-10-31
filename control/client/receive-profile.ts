export type ReceiveProfile = 'native' | 'chrome89-h264-42' | 'chrome89-h264-51';
export const isChrome89 = (userAgent: string) => /(?:Chrome|Chromium)\/89\./.test(userAgent);
const storageKey = 'remotekit.receive-profile';
export function chooseReceiveProfile(userAgent: string, saved?: string | null): ReceiveProfile {
  if (saved === 'native' || isChrome89(userAgent) && (saved === 'chrome89-h264-42' || saved === 'chrome89-h264-51')) return saved;
  return /\bChrome\/89\.0\.4389\.90(?:\s|$)/.test(userAgent) && !/Android|Mobile|iPhone|iPad|Edg\/|OPR\//.test(userAgent) ? 'chrome89-h264-42' : 'native';
}
export function loadReceiveProfile(): ReceiveProfile { let saved: string | null = null; try { if (typeof window !== 'undefined') saved = window.localStorage.getItem(storageKey); } catch {} return chooseReceiveProfile(typeof navigator === 'undefined' ? '' : navigator.userAgent, saved); }
export function saveReceiveProfile(profile: ReceiveProfile) { try { window.localStorage.setItem(storageKey, profile); } catch {} }
export function configureReceiveOffer(sdp: string, profile: ReceiveProfile, userAgent: string) {
  if (profile === 'native') return { sdp, changes: [] as { payload: string; original: string; effective: string }[] };
  if (!isChrome89(userAgent)) throw new Error('Chrome 89 实验接收档只适用于明确的 Chrome 89 测试客户端。');
  const target = profile === 'chrome89-h264-51' ? '42e033' : '42e02a';
  const changes: { payload: string; original: string; effective: string }[] = [];
  const lines = sdp.split(/\r?\n/).map(line => {
    const match = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (!match || !/(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(match[2]) || !/(?:^|;)\s*profile-level-id=42e0[0-9a-f]{2}(?:;|$)/i.test(match[2])) return line;
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
