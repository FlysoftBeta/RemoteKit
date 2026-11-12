export const fixtureMedia = {
  encoder: 'auto',
  fps: 60,
  bitrate: 36000000,
  maxBitrate: 48000000,
  asyncDepth: null,
  gop: null,
  targetUsage: null,
  qsvLowPower: 'auto',
  bufferMs: null,
  rateControl: null,
  idleIdrMs: 150,
  maxEncodeWidth: 4096,
  maxEncodeHeight: 4096,
};

// Test writers create complete records before persisting them.
export function createControlConfig(options = {}) {
  const nodes = Object.fromEntries(
    Object.entries(options.nodes ?? {}).map(([id, node]) => [
      id,
      {
        ...node,
        peer: { listen: '127.0.0.1:3101', address: node.peer?.listen ?? '127.0.0.1:3101', ...node.peer },
        rtc: { ports: null, address: null, ...node.rtc },
        limits: { maxSessions: null, diskReserveBytes: null, sessionMemoryBytes: null, ...node.limits },
      },
    ]),
  );
  return {
    ...options,
    version: 1,
    http: { listen: '127.0.0.1:3001', origins: ['http://127.0.0.1:3001'], ...options.http },
    storage: {
      database: '../data/control.db',
      diagnostics: '../data/diagnostics',
      logs: '../logs',
      ...options.storage,
    },
    media: { ...fixtureMedia, ...options.media },
    quotas: { tenantObjectBytes: null, ...options.quotas },
    nodes,
    ...(options.sessionImport === undefined
      ? {}
      : {
          sessionImport: {
            folder: 'INBOX',
            pollSeconds: 60,
            replyWindowSeconds: 30,
            ...options.sessionImport,
            imap: { port: 993, ...options.sessionImport.imap },
          },
        }),
  };
}
