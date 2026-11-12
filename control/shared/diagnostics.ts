import type { WireError } from './errors';
export interface DiagnosticEnvironment {
  browserFamily: 'brave' | 'chrome' | 'chromium' | 'edge' | 'safari' | 'firefox' | 'other';
  browserMajorVersion?: number;
  browserVersion?: string;
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other';
  osVersion?: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  screenColorDepth: number;
  maxTouchPoints: number;
  hardwareConcurrency?: number;
  deviceMemoryGiB?: number;
  effectiveConnectionType?: 'slow-2g' | '2g' | '3g' | '4g';
  networkRttMs?: number;
  networkDownlinkMbps?: number;
  videoFrameCallbackSupported: boolean;
}

export interface DiagnosticReply {
  id: string;
  status: 'collecting' | 'finalizing' | 'complete' | 'failed';
  startedAt?: number;
  maxDurationMs?: number;
  bytes?: number;
  reason?: string;
  error?: WireError;
}

export interface DiagnosticMethods {
  'diagnostics.start': { params: { environment: DiagnosticEnvironment }; result: DiagnosticReply };
  'diagnostics.sample': { params: { id: string; sequence: number; data: object }; result: DiagnosticReply };
  'diagnostics.stop': { params: { id: string }; result: DiagnosticReply };
  'diagnostics.status': { params: { id: string }; result: DiagnosticReply };
}
